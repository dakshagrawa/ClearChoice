import { isFindingHistory, isSubscriptionCollection } from './models';
import type { FindingRecord, Subscription } from './models';

export const LOCAL_STATE_VERSION = 1 as const;

export interface LocalState {
  version: typeof LOCAL_STATE_VERSION;
  dismissed: boolean;
  subscriptions: Subscription[];
  reviewHistory: FindingRecord[];
}

/** Reject corrupt records before exposing them to UI; never overwrite them with defaults. */
export async function loadLocalState(): Promise<LocalState> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(null);
  const has = (key: string) => Object.hasOwn(stored, key);
  if (has('dismissed') && typeof stored.dismissed !== 'boolean') throw new Error('Corrupt local dismissed preference');
  if (has('version') && stored.version !== LOCAL_STATE_VERSION) throw new Error('Unsupported local state version');
  if (has('subscriptions') && !isSubscriptionCollection(stored.subscriptions)) throw new Error('Corrupt local subscriptions');
  if (has('reviewHistory') && !isFindingHistory(stored.reviewHistory)) throw new Error('Corrupt local review history');
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
  return state;
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
