export async function getDismissed(): Promise<boolean> {
  const stored = await chrome.storage.local.get('dismissed');
  return stored.dismissed === true;
}

export async function setDismissed(dismissed: boolean): Promise<void> {
  await chrome.storage.local.set({ dismissed });
}
