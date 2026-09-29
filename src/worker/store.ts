import { isFindingsBatchRequest } from '../shared/messages';
import { canonicalOrigin, isFindingHistory, MAX_REVIEW_HISTORY } from '../shared/models';
import type { FindingRecord } from '../shared/models';
import { loadReviewStoreState } from '../shared/storage';
import type { BatchReceipt } from '../shared/storage';
import { semanticFingerprint } from '../shared/semantic-fingerprint';

export interface WorkerStoreOptions {
  now?: () => Date;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** In-worker only: storage.local is not a transaction against other writers/processes. */
export function createWorkerStore(options: WorkerStoreOptions = {}) {
  let tail: Promise<void> = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    upsertFindings(request: unknown, origin: unknown): Promise<{ ids: string[] }> {
      return enqueue(async () => {
        if (!isFindingsBatchRequest(request)) throw new Error('Invalid findings batch');
        if (!canonicalOrigin(origin)) throw new Error('Invalid canonical origin');
        // Authenticate every DTO before any read/write, including receipt replays.
        for (const finding of request.findings) {
          if (finding.opaqueFingerprint !== await semanticFingerprint(finding))
            throw new Error('Invalid semantic fingerprint');
        }
        const identities = request.findings.map((finding) => `${finding.opaqueFingerprint}:${finding.ordinal}`);
        if (new Set(identities).size !== identities.length) throw new Error('Duplicate finding identity');
        // Digest all validated DTO fields in wire order, not a sorted or lossy subset.
        const digest = await sha256([origin, request.findings.map((finding) => [
          finding.version, finding.requestId, finding.kind, finding.reason,
          finding.screenedExcerpt, finding.opaqueFingerprint, finding.ordinal,
        ])]);
        const ids: string[] = await Promise.all(request.findings.map(async (finding) =>
          `f_${await sha256([origin, finding.opaqueFingerprint, finding.ordinal])}`));
        const { state, receipts } = await loadReviewStoreState();
        const prior = receipts.find((entry) => entry.requestId === request.requestId);
        if (prior) {
          if (prior.digest !== digest) throw new Error('Request ID collision');
          if (prior.outcome.ids.length !== ids.length || prior.outcome.ids.some((id, index) => id !== ids[index]))
            throw new Error('Corrupt receipt outcome');
          return { ids: [...prior.outcome.ids] };
        }
        const now = (options.now ?? (() => new Date()))();
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid clock');
        const timestamp = now.toISOString();
        const reviewHistory: FindingRecord[] = state.reviewHistory.map((entry) => ({ ...entry }));
        for (const [index, finding] of request.findings.entries()) {
          const id = ids[index];
          const current: FindingRecord | undefined = reviewHistory.find((entry) => entry.id === id);
          if (current) {
            if (current.origin !== origin || current.opaqueFingerprint !== finding.opaqueFingerprint
              || current.ordinal !== finding.ordinal) throw new Error('Finding ID collision');
            if (timestamp < current.latestSeen) throw new Error('Clock precedes latest observation');
            current.kind = finding.kind;
            current.reason = finding.reason;
            current.screenedExcerpt = finding.screenedExcerpt;
            current.latestSeen = timestamp;
          } else {
            reviewHistory.push({
              id, origin, kind: finding.kind, reason: finding.reason,
              screenedExcerpt: finding.screenedExcerpt, opaqueFingerprint: finding.opaqueFingerprint,
              ordinal: finding.ordinal, firstSeen: timestamp, latestSeen: timestamp,
              status: 'needs-review',
            });
          }
        }
        if (reviewHistory.length > MAX_REVIEW_HISTORY) throw new Error('Review history capacity exceeded');
        if (!isFindingHistory(reviewHistory)) throw new Error('Invalid review history');
        const receipt: BatchReceipt = { requestId: request.requestId, digest, outcome: { ids } };
        const nextReceipts = [...receipts, receipt].slice(-MAX_REVIEW_HISTORY);
        // A single payload commits history and receipt; do not cache or acknowledge on failure.
        await chrome.storage.local.set({ reviewHistory, receipts: nextReceipts });
        return { ids: [...ids] };
      });
    },
  };
}
