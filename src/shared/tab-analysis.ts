export async function isCurrentActiveTab(tabId: number): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id === tabId;
}
