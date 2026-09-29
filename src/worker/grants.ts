import { isGrantOrigin, loadGrantState, saveGrantState } from '../shared/storage';
import type { GrantState } from '../shared/storage';
import type { createWorkerStore } from './store';

type Queue = Pick<ReturnType<typeof createWorkerStore>, 'enqueue'>;
const prefix = 'clearchoice-site-';
const match = (origin: string) => `${origin}/*`;

async function scriptId(origin: string): Promise<string> {
  const bytes = new TextEncoder().encode(origin);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return prefix + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function registered(origin: string, id: string): Promise<boolean> {
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  return scripts.length === 1 && scripts[0].id === id && scripts[0].matches?.length === 1
    && scripts[0].matches[0] === match(origin) && scripts[0].js?.length === 1
    && scripts[0].js[0] === 'content.js' && scripts[0].allFrames === false
    && scripts[0].persistAcrossSessions === true && scripts[0].world === 'ISOLATED';
}

async function unregister(id: string): Promise<void> {
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (scripts.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
}

export function createGrantManager(store: Queue) {
  // A failed browser/storage cleanup must not authorize an old scan in this worker.
  const locallyDisabled = new Set<string>();
  async function enabled(origin: string, generation: number): Promise<boolean> {
    if (!isGrantOrigin(origin) || locallyDisabled.has(origin) || !Number.isSafeInteger(generation) || generation < 1) return false;
    const state = await loadGrantState();
    return state.sites[origin]?.enabled === true && state.sites[origin].generation === generation
      && await chrome.permissions.contains({ origins: [match(origin)] })
      && await registered(origin, await scriptId(origin));
  }

  async function disable(origin: string): Promise<void> {
    if (!isGrantOrigin(origin)) throw new Error('Invalid HTTPS origin');
    locallyDisabled.add(origin);
    let failure: unknown;
    let failed = false;
    try {
      const state = await loadGrantState();
      const previous = state.sites[origin];
      if (previous) {
        if (previous.generation === Number.MAX_SAFE_INTEGER) throw new Error('Grant generation exhausted');
        const next: GrantState = { version: 1, sites: { ...state.sites, [origin]: { enabled: false, generation: previous.generation + 1 } } };
        await saveGrantState(next);
      }
    } catch (error) { failure = error; failed = true; }
    try { await unregister(await scriptId(origin)); }
    catch (error) { if (!failed) { failure = error; failed = true; } }
    // Even a failed storage or scripting operation must not skip best-effort UI cleanup.
    try {
      const tabs = await chrome.tabs.query({});
      await Promise.all(tabs.filter((tab) => tab.id !== undefined && typeof tab.url === 'string' && (() => {
        try { return new URL(tab.url!).origin === origin; } catch { return false; }
      })()).map(async (tab) => {
        const tabId = tab.id!;
        try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch { /* Best effort. */ }
        try {
          const key = `clearchoice.document.${tabId}`;
          const record: unknown = (await chrome.storage.session.get(key))[key];
          if (typeof record === 'object' && record !== null && !Array.isArray(record)) {
            const fields = record as Record<string, unknown>;
            if (Object.keys(fields).length === 3 && fields.tabId === tabId && fields.origin === origin
              && typeof fields.documentId === 'string' && fields.documentId.length > 0) {
              await chrome.tabs.sendMessage(tabId, { type: 'CLEARCHOICE_DISABLE' }, { documentId: fields.documentId });
            }
          }
        } catch { /* Missing/expired document or listener; never broadcast to a tab. */ }
      }));
    } catch { /* Badge and message cleanup are best effort; the persisted grant is disabled when storage succeeds. */ }
    if (failed) throw failure;
  }

  return {
    /** Caller must already hold the exact-origin browser permission from a popup click. */
    enable(origin: string): Promise<number> {
      return store.enqueue(async () => {
        if (!isGrantOrigin(origin)) throw new Error('Invalid HTTPS origin');
        const id = await scriptId(origin);
        const state = await loadGrantState();
        if (!await chrome.permissions.contains({ origins: [match(origin)] })) {
          if (state.sites[origin]?.enabled) await disable(origin);
          else await unregister(id);
          throw new Error('Origin permission not granted');
        }
        if (state.sites[origin]?.enabled && !locallyDisabled.has(origin) && await registered(origin, id)) return state.sites[origin].generation;
        // Never leave a mismatched/old registration active while enabling.
        await unregister(id);
        const previous = state.sites[origin]?.generation ?? 0;
        if (previous === Number.MAX_SAFE_INTEGER) throw new Error('Grant generation exhausted');
        try {
          await chrome.scripting.registerContentScripts([{ id, matches: [match(origin)], js: ['content.js'], allFrames: false, persistAcrossSessions: true, world: 'ISOLATED' }]);
          await saveGrantState({ version: 1, sites: { ...state.sites, [origin]: { enabled: true, generation: previous + 1 } } });
          locallyDisabled.delete(origin);
          return previous + 1;
        } catch (error) {
          locallyDisabled.add(origin);
          // If a former grant was enabled, invalidate it before reporting failure.
          if (state.sites[origin]?.enabled) {
            try { await saveGrantState({ version: 1, sites: { ...state.sites, [origin]: { enabled: false, generation: previous + 1 } } }); } catch { /* A missing script still fails isEnabled. */ }
          }
          try { await unregister(id); } catch { /* Reconciliation cleans up orphans on restart. */ }
          throw error;
        }
      });
    },
    revoke(origin: string): Promise<void> { return store.enqueue(() => disable(origin)); },
    // Read-only so it can run in upsertFindings' queued beforeCommit checkpoint (Task 9).
    // Calling enqueue here would deadlock that callback against itself.
    isEnabled(origin: string, generation: number): Promise<boolean> { return enabled(origin, generation); },
    reconcile(): Promise<void> {
      return store.enqueue(async () => {
        const state = await loadGrantState();
        const scripts = await chrome.scripting.getRegisteredContentScripts();
        for (const [origin, grant] of Object.entries(state.sites)) {
          if (grant.enabled && (!await chrome.permissions.contains({ origins: [match(origin)] })
            || !await registered(origin, await scriptId(origin)))) await disable(origin);
        }
        const updated = await loadGrantState();
        for (const script of scripts.filter((item) => item.id.startsWith(prefix))) {
          const owners = await Promise.all(Object.keys(updated.sites).filter((origin) => updated.sites[origin].enabled).map(async (origin) => await scriptId(origin)));
          if (!owners.includes(script.id)) await unregister(script.id);
        }
      });
    },
    /** Invoke only for Chrome's permission-removal event; never remove another site's access. */
    onRemoved(_origins: string[]): Promise<void> {
      // Event patterns can be broader than a saved site; inspect current permissions instead.
      void _origins;
      return store.enqueue(async () => {
        const state = await loadGrantState();
        for (const origin of Object.keys(state.sites)) {
          if (state.sites[origin].enabled
            && !await chrome.permissions.contains({ origins: [match(origin)] })) await disable(origin);
        }
      });
    },
  };
}
