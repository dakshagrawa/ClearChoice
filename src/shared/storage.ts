import { DEFAULT_RETENTION_POLICY, isFindingHistory, isRetentionPolicy, isSubscriptionCollection, MAX_REVIEW_HISTORY } from './models';
import { isValidRequestId, MAX_FINDING_BATCH } from './finding-dto';
import type { FindingRecord, RetentionPolicy, Subscription } from './models';

export const LOCAL_STATE_VERSION = 1 as const;
export const GRANT_STATE_VERSION = 1 as const;

export interface SiteGrant { enabled: boolean; generation: number; provisional?: true }
export interface GrantState { version: typeof GRANT_STATE_VERSION; sites: Record<string, SiteGrant> }

/** The permission-grant schema is separate from review data; unknown/corrupt grants fail closed. */
export function isGrantOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 255) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && url.hostname.includes('.')
      && !/^\d+(?:\.\d+){3}$/.test(url.hostname) && !url.hostname.includes(':')
      && url.hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  } catch { return false; }
}

export function isGrantState(value: unknown): value is GrantState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 2 || item.version !== GRANT_STATE_VERSION || !Object.hasOwn(item, 'sites')) return false;
  const sites = item.sites;
  if (typeof sites !== 'object' || sites === null || Array.isArray(sites) || Object.keys(sites).length > 500) return false;
  return Object.entries(sites).every(([origin, entry]) => {
    if (!isGrantOrigin(origin) || typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    const grant = entry as Record<string, unknown>;
    return (Object.keys(grant).length === 2 || (Object.keys(grant).length === 3
      && Object.hasOwn(grant, 'provisional') && grant.provisional === true && grant.enabled === true))
      && Object.hasOwn(grant, 'enabled') && Object.hasOwn(grant, 'generation') && typeof grant.enabled === 'boolean'
      && Number.isSafeInteger(grant.generation) && (grant.generation as number) > 0;
  });
}

export async function loadGrantState(): Promise<GrantState> {
  const stored = await chrome.storage.local.get('grantState');
  if (!Object.hasOwn(stored, 'grantState')) return { version: GRANT_STATE_VERSION, sites: {} };
  if (!isGrantState(stored.grantState)) throw new Error('Corrupt grant state');
  return stored.grantState;
}

export async function saveGrantState(state: GrantState): Promise<void> {
  if (!isGrantState(state)) throw new Error('Invalid grant state');
  await chrome.storage.local.set({ grantState: state });
}

export interface LocalState {
  version: typeof LOCAL_STATE_VERSION;
  dismissed: boolean;
  subscriptions: Subscription[];
  reviewHistory: FindingRecord[];
  retentionPolicy: RetentionPolicy;
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
  if (has('retentionPolicy') && !isRetentionPolicy(stored.retentionPolicy)) throw new Error('Corrupt local retention policy');
  if (has('retentionPolicy') && !has('version')) throw new Error('Unversioned local retention policy');
  if (has('receipts') && !isReceipts(stored.receipts)) throw new Error('Corrupt local receipts');
  if (has('receipts') && !has('version')) throw new Error('Unversioned local receipts');
  if (!has('version') && (has('subscriptions') || has('reviewHistory'))) throw new Error('Unversioned local records');
  if (has('version') && (!has('subscriptions') || !has('reviewHistory'))) throw new Error('Incomplete local state');
  const state: LocalState = {
    version: LOCAL_STATE_VERSION,
    dismissed: stored.dismissed === true,
    subscriptions: has('subscriptions') ? stored.subscriptions as Subscription[] : [],
    reviewHistory: has('reviewHistory') ? stored.reviewHistory as FindingRecord[] : [],
    retentionPolicy: has('retentionPolicy') ? stored.retentionPolicy as RetentionPolicy : DEFAULT_RETENTION_POLICY,
  };
  if (!has('version')) {
    await chrome.storage.local.set({ version: state.version, subscriptions: [], reviewHistory: [], retentionPolicy: state.retentionPolicy });
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

export async function getDismissed(): Promise<boolean> {
  const stored = await chrome.storage.local.get('dismissed');
  if (Object.hasOwn(stored, 'dismissed') && typeof stored.dismissed !== 'boolean')
    throw new Error('Corrupt local dismissed preference');
  return stored.dismissed === true;
}

export async function setDismissed(dismissed: boolean): Promise<void> {
  const preferences: Preferences = { dismissed };
  await chrome.storage.local.set(preferences);
}
