import { isSubscriptionFields, MAX_SUBSCRIPTIONS } from '../shared/models';
import type { Subscription } from '../shared/models';
import { isFindingsBatchRequest } from '../shared/messages';
import { canonicalOrigin, isFindingHistory, isRecordIdentifier, isRetentionPolicy, MAX_REVIEW_HISTORY } from '../shared/models';
import type { FindingRecord, RetentionPolicy } from '../shared/models';
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
export class NonRetryableFindingError extends Error {}

export class ScanAuthorizationError extends Error {
  constructor() { super('Scan no longer authorized'); }
}

export function createWorkerStore(options: WorkerStoreOptions = {}) {
  let tail: Promise<void> = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function currentTime(): number {
    const now = (options.now ?? (() => new Date()))();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid clock');
    return now.getTime();
  }

  // Exact 24-hour UTC intervals; latestSeen at or before the instant expires.
  function retained(history: FindingRecord[], policy: RetentionPolicy, time: number): FindingRecord[] {
    return policy === 'never' ? history : history.filter((entry) =>
      Date.parse(entry.latestSeen) > time - policy * 86_400_000);
  }

  return {
    /** Share the worker's only mutation queue with grant registration/state transitions. */
    enqueue,
    readSubscriptionHelpOrigin(id: unknown): Promise<string | undefined> {
      return enqueue(async () => {
        if (!isRecordIdentifier(id)) throw new Error('Invalid subscription ID');
        const { state } = await loadReviewStoreState();
        const subscription = state.subscriptions.find((entry) => entry.id === id);
        if (!subscription) throw new Error('Subscription not found');
        const history = retained(state.reviewHistory, state.retentionPolicy, currentTime());
        if (history.length !== state.reviewHistory.length) await chrome.storage.local.set({ reviewHistory: history });
        return history.find((entry) => entry.id === subscription.sourceFindingId)?.origin;
      });
    },
    listSubscriptions(): Promise<Subscription[]> {
      return enqueue(async () => (await loadReviewStoreState()).state.subscriptions.map((entry) => ({ ...entry })));
    },
    createSubscription(fields: unknown, sourceFindingId?: unknown): Promise<Subscription> {
      return enqueue(async () => {
        if (!isSubscriptionFields(fields)) throw new Error('Invalid subscription fields');
        const { state } = await loadReviewStoreState();
        const time = currentTime();
        if (sourceFindingId !== undefined && (!isRecordIdentifier(sourceFindingId)
          || !retained(state.reviewHistory, state.retentionPolicy, time).some((entry) => entry.id === sourceFindingId))) throw new Error('Retained finding not found');
        if (sourceFindingId !== undefined && state.subscriptions.some((entry) => entry.sourceFindingId === sourceFindingId)) throw new Error('Finding already confirmed; edit the saved subscription');
        if (state.subscriptions.length >= MAX_SUBSCRIPTIONS) throw new Error('Subscription capacity exceeded');
        const id = `s_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
        if (state.subscriptions.some((entry) => entry.id === id)) throw new Error('Subscription ID collision');
        const timestamp = new Date(time).toISOString();
        const subscription: Subscription = { ...fields, id, createdAt: timestamp, updatedAt: timestamp,
          ...(typeof sourceFindingId === 'string' ? { sourceFindingId } : {}) };
        await chrome.storage.local.set({ subscriptions: [...state.subscriptions, subscription] });
        return { ...subscription };
      });
    },
    updateSubscription(id: unknown, fields: unknown): Promise<Subscription> {
      return enqueue(async () => {
        if (!isRecordIdentifier(id) || !isSubscriptionFields(fields)) throw new Error('Invalid subscription fields');
        const { state } = await loadReviewStoreState();
        const prior = state.subscriptions.find((entry) => entry.id === id);
        if (!prior) throw new Error('Subscription not found');
        const timestamp = new Date(currentTime()).toISOString();
        if (timestamp < prior.updatedAt) throw new Error('Clock precedes subscription');
        const subscription: Subscription = { ...fields, id: prior.id, createdAt: prior.createdAt, updatedAt: timestamp,
          ...(prior.sourceFindingId ? { sourceFindingId: prior.sourceFindingId } : {}) };
        await chrome.storage.local.set({ subscriptions: state.subscriptions.map((entry) => entry.id === id ? subscription : entry) });
        return { ...subscription };
      });
    },
    deleteSubscription(id: unknown): Promise<void> {
      return enqueue(async () => {
        if (!isRecordIdentifier(id)) throw new Error('Invalid subscription ID');
        const { state } = await loadReviewStoreState();
        if (!state.subscriptions.some((entry) => entry.id === id)) throw new Error('Subscription not found');
        await chrome.storage.local.set({ subscriptions: state.subscriptions.filter((entry) => entry.id !== id) });
      });
    },
    setRetentionPolicy(policy: unknown): Promise<void> {
      return enqueue(async () => {
        if (!isRetentionPolicy(policy)) throw new Error('Invalid retention policy');
        const { state } = await loadReviewStoreState();
        const reviewHistory = retained(state.reviewHistory, policy, currentTime());
        await chrome.storage.local.set({ retentionPolicy: policy, reviewHistory });
      });
    },
    markReviewed(id: unknown): Promise<void> {
      return enqueue(async () => {
        if (!isRecordIdentifier(id)) throw new Error('Invalid finding ID');
        const { state } = await loadReviewStoreState();
        const reviewHistory = retained(state.reviewHistory, state.retentionPolicy, currentTime())
          .map((entry) => ({ ...entry }));
        const entry = reviewHistory.find((item) => item.id === id);
        if (!entry) throw new Error('Finding not found');
        if (entry.status === 'reviewed' && reviewHistory.length === state.reviewHistory.length) return;
        entry.status = 'reviewed';
        await chrome.storage.local.set({ reviewHistory });
      });
    },
    deleteFinding(id: unknown): Promise<void> {
      return enqueue(async () => {
        if (!isRecordIdentifier(id)) throw new Error('Invalid finding ID');
        const { state } = await loadReviewStoreState();
        const reviewHistory = retained(state.reviewHistory, state.retentionPolicy, currentTime());
        if (!reviewHistory.some((entry) => entry.id === id)) throw new Error('Finding not found');
        await chrome.storage.local.set({ reviewHistory: reviewHistory.filter((entry) => entry.id !== id) });
      });
    },
    readReviewSnapshot(): Promise<{ history: FindingRecord[]; retentionPolicy: RetentionPolicy }> {
      return enqueue(async () => {
        const { state } = await loadReviewStoreState();
        const history = retained(state.reviewHistory, state.retentionPolicy, currentTime());
        if (history.length !== state.reviewHistory.length) await chrome.storage.local.set({ reviewHistory: history });
        return { history: history.map((entry) => ({ ...entry })), retentionPolicy: state.retentionPolicy };
      });
    },
    async readHistory(): Promise<FindingRecord[]> {
      return (await this.readReviewSnapshot()).history;
    },
    upsertFindings(request: unknown, origin: unknown, beforeCommit?: () => Promise<boolean>): Promise<{ ids: string[] }> {
      return enqueue(async () => {
        if (!isFindingsBatchRequest(request)) throw new NonRetryableFindingError('Invalid findings batch');
        if (!canonicalOrigin(origin)) throw new NonRetryableFindingError('Invalid canonical origin');
        // Authenticate every DTO before any read/write, including receipt replays.
        for (const finding of request.findings) {
          if (finding.opaqueFingerprint !== await semanticFingerprint(finding))
            throw new NonRetryableFindingError('Invalid semantic fingerprint');
        }
        const identities = request.findings.map((finding) => `${finding.opaqueFingerprint}:${finding.ordinal}`);
        if (new Set(identities).size !== identities.length) throw new NonRetryableFindingError('Duplicate finding identity');
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
          if (prior.digest !== digest) throw new NonRetryableFindingError('Request ID collision');
          if (prior.outcome.ids.length !== ids.length || prior.outcome.ids.some((id, index) => id !== ids[index]))
            throw new NonRetryableFindingError('Corrupt receipt outcome');
          if (beforeCommit && !(await beforeCommit())) throw new ScanAuthorizationError();
          return { ids: [...prior.outcome.ids] };
        }
        const now = (options.now ?? (() => new Date()))();
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid clock');
        const timestamp = now.toISOString();
        const reviewHistory: FindingRecord[] = retained(state.reviewHistory, state.retentionPolicy, now.getTime())
          .map((entry) => ({ ...entry }));
        for (const [index, finding] of request.findings.entries()) {
          const id = ids[index];
          const current: FindingRecord | undefined = reviewHistory.find((entry) => entry.id === id);
          if (current) {
            if (current.origin !== origin || current.opaqueFingerprint !== finding.opaqueFingerprint
              || current.ordinal !== finding.ordinal) throw new NonRetryableFindingError('Finding ID collision');
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
        if (reviewHistory.length > MAX_REVIEW_HISTORY) throw new NonRetryableFindingError('Review history capacity exceeded');
        if (!isFindingHistory(reviewHistory)) throw new NonRetryableFindingError('Invalid review history');
        const receipt: BatchReceipt = { requestId: request.requestId, digest, outcome: { ids } };
        const nextReceipts = [...receipts, receipt].slice(-MAX_REVIEW_HISTORY);
        // A single payload commits history and receipt; do not cache or acknowledge on failure.
        // The queued write boundary is the last focus/authorization checkpoint, not an atomic browser transaction.
        if (beforeCommit && !(await beforeCommit())) throw new ScanAuthorizationError();
        await chrome.storage.local.set({ reviewHistory, receipts: nextReceipts });
        return { ids: [...ids] };
      });
    },
  };
}
