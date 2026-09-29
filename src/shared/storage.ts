import { isFindingHistory, isSubscriptionCollection, MAX_REVIEW_HISTORY } from './models';
import { isValidRequestId, MAX_FINDING_BATCH } from './finding-dto';
import type { FindingRecord, Subscription } from './models';

export const LOCAL_STATE_VERSION = 1 as const;

export interface LocalState {
  version: typeof LOCAL_STATE_VERSION;
  dismissed: boolean;
  subscriptions: Subscription[];
  reviewHistory: FindingRecord[];
}

export interface BatchReceipt {
  requestId: string;
  digest: string;
  outcome: { ids: string[] };
}

const digest = /^[a-f0-9]{64}$/;
const findingId = /^f_[a-f0-9]{64}$/;

function isReceipts(value: unknown): value is BatchReceipt[] {
  return Array.isArray(value) && value.length <= MAX_REVIEW_HISTORY
    && value.every((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
      const item = entry as Record<string, unknown>;
      if (Object.keys(item).length !== 3 || !['requestId', 'digest', 'outcome'].every((key) => Object.hasOwn(item, key))
        || !isValidRequestId(item.requestId) || typeof item.digest !== 'string' || !digest.test(item.digest)) return false;
      const outcome = item.outcome;
      return typeof outcome === 'object' && outcome !== null && !Array.isArray(outcome)
        && Object.keys(outcome).length === 1 && Object.hasOwn(outcome, 'ids')
        && Array.isArray((outcome as { ids: unknown }).ids)
        && (outcome as { ids: unknown[] }).ids.length <= MAX_FINDING_BATCH
        && (outcome as { ids: unknown[] }).ids.every((id) => typeof id === 'string' && findingId.test(id));
    }) && new Set(value.map((entry: BatchReceipt) => entry.requestId)).size === value.length;
}

/** Reject corrupt records before exposing them to UI; never overwrite them with defaults. */
async function readLocalState(): Promise<{ state: LocalState; receipts: BatchReceipt[] }> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(null);
  const has = (key: string) => Object.hasOwn(stored, key);
  if (has('dismissed') && typeof stored.dismissed !== 'boolean') throw new Error('Corrupt local dismissed preference');
  if (has('version') && stored.version !== LOCAL_STATE_VERSION) throw new Error('Unsupported local state version');
  if (has('subscriptions') && !isSubscriptionCollection(stored.subscriptions)) throw new Error('Corrupt local subscriptions');
  if (has('reviewHistory') && !isFindingHistory(stored.reviewHistory)) throw new Error('Corrupt local review history');
  if (has('receipts') && !isReceipts(stored.receipts)) throw new Error('Corrupt local receipts');
  if (has('receipts') && !has('version')) throw new Error('Unversioned local receipts');
  if (!has('version') && (has('subscriptions') || has('reviewHistory'))) throw new Error('Unversioned local records');
  if (has('version') && (!has('subscriptions') || !has('reviewHistory'))) throw new Error('Incomplete local state');
  const state: LocalState = {
    version: LOCAL_STATE_VERSION,
    dismissed: stored.dismissed === true,
    subscriptions: has('subscriptions') ? stored.subscriptions as Subscription[] : [],
    reviewHistory: has('reviewHistory') ? stored.reviewHistory as FindingRecord[] : [],
  };
  if (!has('version')) {
    await chrome.storage.local.set({ version: state.version, subscriptions: [], reviewHistory: [] });
  }
  return { state, receipts: has('receipts') ? stored.receipts as BatchReceipt[] : [] };
}

export async function loadLocalState(): Promise<LocalState> {
  return (await readLocalState()).state;
}

/** One storage read supplies both history and receipt snapshot for a queued mutation. */
export async function loadReviewStoreState(): Promise<{ state: LocalState; receipts: BatchReceipt[] }> {
  return readLocalState();
}

/** Only an explicit confirmed/manual Save call should invoke this; scans write review history separately. */
export async function saveConfirmedSubscriptions(subscriptions: Subscription[]): Promise<void> {
  if (!isSubscriptionCollection(subscriptions)) throw new Error('Invalid confirmed subscriptions');
  await loadLocalState();
  await chrome.storage.local.set({ subscriptions });
}

export interface Preferences {
  dismissed: boolean;
}

const preferencesKey = 'dismissed';

export async function getDismissed(): Promise<boolean> {
  const stored = await chrome.storage.local.get(preferencesKey);
  return stored.dismissed === true;
}

export async function setDismissed(dismissed: boolean): Promise<void> {
  const preferences: Preferences = { dismissed };
  await chrome.storage.local.set(preferences);
}
