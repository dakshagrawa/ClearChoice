import type { Finding } from '../core/types';
import { isValidRequestId, MAX_FINDING_BATCH, toFindingDto } from '../shared/finding-dto';
import { CLEARCHOICE_FINDINGS_BATCH, isFindingsBatchRequest } from '../shared/messages';
import type { FindingsBatchRequest } from '../shared/messages';
import { semanticFingerprint } from '../shared/semantic-fingerprint';

const screeningFingerprint = '0'.repeat(64);

/** Create once per scan; pass the same ID to buildFindingBatch on retries. */
export function createScanRequestId(): string {
  if (typeof crypto?.getRandomValues !== 'function') throw new Error('Web Crypto unavailable');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Consumes the DOM-ordered findings from analyzePage; never reorders by selector or hash. */
export async function buildFindingBatch(findings: readonly Finding[], requestId: string): Promise<FindingsBatchRequest> {
  if (!isValidRequestId(requestId)) throw new Error('Invalid request ID');
  if (typeof crypto?.subtle?.digest !== 'function') throw new Error('Web Crypto unavailable');
  const screened = findings.flatMap((finding) => {
    const dto = toFindingDto(finding, requestId, 1, screeningFingerprint);
    return dto ? [dto] : [];
  });
  if (screened.length > MAX_FINDING_BATCH) throw new Error('Finding batch exceeds 100 eligible items');
  const ordinals = new Map<string, number>();
  const result: FindingsBatchRequest['findings'] = [];
  for (const dto of screened) {
    const fingerprint = await semanticFingerprint(dto);
    const ordinal = (ordinals.get(fingerprint) ?? 0) + 1;
    ordinals.set(fingerprint, ordinal);
    result.push({ ...dto, ordinal, opaqueFingerprint: fingerprint });
  }
  const batch = { type: CLEARCHOICE_FINDINGS_BATCH, version: 1, requestId, findings: result };
  if (!isFindingsBatchRequest(batch)) throw new Error('Invalid finding batch');
  return batch;
}
