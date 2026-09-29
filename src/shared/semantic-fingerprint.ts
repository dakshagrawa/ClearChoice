import type { FindingDto } from './finding-dto';

/** SHA-256 of the screened, wire-visible evidence; excludes request ID and ordinal. */
export async function semanticFingerprint(finding: Pick<FindingDto, 'kind' | 'reason' | 'screenedExcerpt'>): Promise<string> {
  const identity = `${finding.kind}\u0000${finding.reason}\u0000${finding.screenedExcerpt}`;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
