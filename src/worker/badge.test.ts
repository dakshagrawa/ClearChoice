import { afterEach, expect, it, vi } from 'vitest';
import { createTabBadges } from './badge';

const session: Record<string, unknown> = {};
const text = vi.fn<(details: { tabId: number; text: string }) => Promise<void>>().mockResolvedValue(undefined);
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); for (const key of Object.keys(session)) delete session[key]; });
function setup() {
  vi.stubGlobal('chrome', { action: { setBadgeText: text }, storage: { session: {
    set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(session, value); }),
    remove: vi.fn(async (key: string) => { delete session[key]; }),
  } } });
  return createTabBadges();
}
it('publishes a tab-local accepted count and displays zero as blank', async () => {
  const badges = setup();
  const a = badges.capture(1, 'https://a.test');
  const b = badges.capture(2, 'https://b.test');
  await badges.publish(a, 'a-doc', 3, 2);
  await badges.publish(b, 'b-doc', 5, 1);
  await badges.publish(a, 'a-doc', 3, 0);
  expect(text.mock.calls).toEqual([[{ tabId: 1, text: '2' }], [{ tabId: 2, text: '1' }], [{ tabId: 1, text: '' }]]);
  expect(session['clearchoice.badge.1']).toEqual({ documentId: 'a-doc', generation: 3, origin: 'https://a.test' });
  expect(await badges.trackAutomatic(a, 'a-doc')).toBe(true);
  expect(session['clearchoice.automatic.1']).toEqual({ tabId: 1, documentId: 'a-doc', origin: 'https://a.test' });
});
it('invalidates old work synchronously and queues navigation clear after a delayed badge write', async () => {
  const badges = setup();
  const old = badges.capture(1, 'https://a.test');
  let release!: () => void;
  text.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); });
  const writing = badges.publish(old, 'old-doc', 3, 1);
  await vi.waitFor(() => expect(release).toBeDefined());
  const clearing = badges.clearTab(1);
  release();
  await writing; await clearing;
  expect(await badges.publish(old, 'old-doc', 3, 9)).toBe(false);
  expect(text.mock.calls.at(-1)).toEqual([{ tabId: 1, text: '' }]);
  expect(session['clearchoice.badge.1']).toBeUndefined();
  const fresh = badges.capture(1, 'https://a.test');
  expect(await badges.publish(fresh, 'new-doc', 3, 2)).toBe(true);
});
it('revocation invalidates only the matching site and tab removal retires tokens', async () => {
  const badges = setup();
  const a = badges.capture(1, 'https://a.test');
  const b = badges.capture(2, 'https://b.test');
  await badges.publish(b, 'b-doc', 5, 2);
  await badges.clearOrigin('https://a.test');
  expect(await badges.publish(a, 'a-doc', 3, 1)).toBe(false);
  expect(await badges.publish(b, 'b-doc', 5, 2)).toBe(true);
  expect(text.mock.calls.filter(([call]) => call.tabId === 2).every(([call]) => call.text === '2')).toBe(true);
  await badges.clearTab(2);
  expect(await badges.publish(b, 'b-doc', 5, 3)).toBe(false);
  expect(session['clearchoice.document.2']).toBeUndefined();
  expect(session['clearchoice.automatic.2']).toBeUndefined();
});
