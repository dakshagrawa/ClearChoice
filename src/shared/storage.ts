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
