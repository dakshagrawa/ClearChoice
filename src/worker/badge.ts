interface BadgeCapture { tabId: number; origin: string }
/** Separate from the history queue: navigation never waits for a scan challenge. */
export function createTabBadges() {
  const captures = new Map<number, BadgeCapture>();
  const queues = new Map<number, Promise<unknown>>();
  function enqueue<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const next = (queues.get(tabId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    queues.set(tabId, next);
    void next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(() => undefined);
    return next;
  }
  function capture(tabId: number, origin: string): BadgeCapture {
    const previous = captures.get(tabId);
    if (previous?.origin === origin) return previous;
    if (!previous && captures.size >= 512) throw new Error('Badge tracking capacity');
    const current = { tabId, origin };
    captures.set(tabId, current);
    return current;
  }
  function clearTab(tabId: number, documents = true): Promise<void> {
    captures.delete(tabId); // Retire before any await, including blocked browser writes.
    return enqueue(tabId, async () => {
      // Cleanup steps are independent: a session failure must not skip visual clearing.
      const results = await Promise.allSettled([
        chrome.action.setBadgeText({ tabId, text: '' }),
        ...(documents ? ['badge', 'automatic', 'document'] : ['badge']).map((kind) => chrome.storage.session.remove(`clearchoice.${kind}.${tabId}`)),
      ]);
      if (results.some((result) => result.status === 'rejected')) throw new Error('Badge cleanup failed');
    });
  }
  return {
    capture,
    current: (value: BadgeCapture) => captures.get(value.tabId) === value,
    origins: () => [...new Set([...captures.values()].map((value) => value.origin))],
    clearTab,
    async clearOrigin(origin: string): Promise<void> {
      await Promise.all([...captures.values()].filter((value) => value.origin === origin).map((value) => clearTab(value.tabId, false)));
    },
    trackAutomatic(value: BadgeCapture, documentId: string): Promise<boolean> {
      return enqueue(value.tabId, async () => {
        if (captures.get(value.tabId) !== value) return false;
        await chrome.storage.session.set({ [`clearchoice.automatic.${value.tabId}`]: { tabId: value.tabId, documentId, origin: value.origin } });
        return captures.get(value.tabId) === value;
      });
    },
    publish(value: BadgeCapture, documentId: string, generation: number, count: number): Promise<boolean> {
      return enqueue(value.tabId, async () => {
        if (captures.get(value.tabId) !== value) return false;
        await chrome.storage.session.set({ [`clearchoice.badge.${value.tabId}`]: { documentId, generation, origin: value.origin } });
        if (captures.get(value.tabId) !== value) return false;
        await chrome.action.setBadgeText({ tabId: value.tabId, text: count ? String(count) : '' });
        return captures.get(value.tabId) === value;
      });
    },
  };
}
