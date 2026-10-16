import { afterEach, expect, it, vi } from 'vitest';
import type { Subscription } from '../shared/models';

async function install() {
  const data: Record<string, unknown> = { version: 1, subscriptions: [], reviewHistory: [], receipts: [], retentionPolicy: 'never' };
  const set = vi.fn(async (value: Record<string, unknown>) => { Object.assign(data, structuredClone(value)); });
  const get = vi.fn(async () => structuredClone(data));
  let listener: (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => boolean;
  const sendMessage = vi.fn((request: unknown) => new Promise<unknown>((resolve) => {
    listener(request, { id: 'extension', url: 'chrome-extension://extension/popup/index.html' }, resolve);
  }));
  const event = { addListener: vi.fn() };
  vi.stubGlobal('chrome', {
    runtime: { id: 'extension', sendMessage, onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
    storage: { local: { get, set, setAccessLevel: vi.fn().mockResolvedValue(undefined) }, session: { setAccessLevel: vi.fn().mockResolvedValue(undefined) } },
    tabs: { query: vi.fn().mockResolvedValue([]), onUpdated: event, onRemoved: event, onActivated: event },
    action: { setBadgeText: vi.fn().mockResolvedValue(undefined) },
    permissions: { contains: vi.fn().mockResolvedValue(false), onRemoved: event },
    scripting: { getRegisteredContentScripts: vi.fn().mockResolvedValue([]), unregisterContentScripts: vi.fn().mockResolvedValue(undefined) },
  });
  async function restart() { vi.resetModules(); await import('../worker/index'); await sendMessage({ type: 'INVALID' }); }
  await restart();
  return { data, set, get, sendMessage, restart };
}
async function mount() {
  const { mountSubscriptions } = await import('./subscriptions');
  document.body.innerHTML = '<div id="subscriptions"></div>';
  const root = document.querySelector<HTMLElement>('#subscriptions')!;
  const view = mountSubscriptions(root);
  await vi.waitFor(() => expect(root.querySelector('[data-subscription-list]')?.getAttribute('aria-busy')).toBe('false'));
  return { root, view };
}
function value(root: HTMLElement, name: string, value: string) {
  const field = root.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!;
  field.value = value;
  field.dispatchEvent(new Event('change', { bubbles: true }));
}
function fill(root: HTMLElement) {
  value(root, 'merchant', '  Acme  ');
  value(root, 'amount', '10.00');
  value(root, 'currency', 'usd');
  value(root, 'cadence', 'monthly');
  value(root, 'nextBillingDate', '2026-10-01');
  value(root, 'notes', 'Family plan');
}
function click(root: HTMLElement, action: string) { root.querySelector<HTMLButtonElement>(`[data-subscription-action="${action}"]`)!.click(); }
function submit(root: HTMLElement) { root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

it.each(['https://netflix.com', 'https://spotify.com', 'https://unknown.test', 'https://netflix.com.evil.test', undefined])('reveals help only after click using retained origin %s, never merchant guesses', async (origin) => {
  const { data, sendMessage } = await install();
  const timestamp = new Date().toISOString();
  data.subscriptions = [{ id: 's_help', merchant: '<Netflix>', amount: '10.00', currency: 'USD', cadence: 'monthly', createdAt: timestamp, updatedAt: timestamp, ...(origin ? { sourceFindingId: 'f_help' } : {}) }];
  data.reviewHistory = origin ? [{ id: 'f_help', origin, kind: 'recurring-charge', reason: 'price-cadence', screenedExcerpt: 'Monthly plan $10.00', opaqueFingerprint: 'a'.repeat(64), ordinal: 1, firstSeen: timestamp, latestSeen: timestamp, status: 'reviewed' }] : [];
  const { root } = await mount();
  expect(root.querySelector('a')).toBeNull(); expect(root.querySelector('b')).toBeNull();
  expect(sendMessage.mock.calls.some(([request]) => (request as { type: string }).type === 'CLEARCHOICE_SUBSCRIPTION_HELP')).toBe(false);
  expect(root.querySelector('[data-subscription-action="help"]')).not.toBeNull();
  click(root, 'help');
  await vi.waitFor(() => expect(root.textContent).not.toContain('Loading cancellation help'));
  const { resolveCancellationGuide } = await import('../shared/guide-catalog');
  const help = resolveCancellationGuide(origin);
  if (help.kind === 'none') {
    expect(root.textContent).toContain('No known provider site; check your billing provider'); expect(root.querySelector('a')).toBeNull();
  } else {
    const link = root.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(help.kind === 'guide' ? help.destination : origin);
    expect(link.target).toBe('_blank'); expect(link.rel).toBe('noopener noreferrer');
    if (help.kind === 'guide') {
      expect(link.textContent).toBe(`Official guide (reviewed ${help.lastReviewed})`);
      expect(root.textContent).toContain(help.title); expect(root.textContent).toContain(help.caveat);
    } else expect(link.textContent).toBe('Visit site — not a cancellation guide');
  }
});

it('makes explicit that local deletion never cancels billing', async () => {
  await install(); const { root } = await mount();
  expect(root.textContent).toContain('Deleting a record does not cancel billing.');
});

it.each(['refresh', 'delete', 'replace', 'unmount'])('discards delayed help after %s without detached DOM or focus side effects', async (operation) => {
  const { data, sendMessage } = await install(); const { root, view } = await mount();
  click(root, 'add'); fill(root); submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  const row = root.querySelector('article')!;
  let reply!: (response: unknown) => void;
  sendMessage.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
  click(root, 'help');
  if (operation === 'delete') { click(root, 'delete'); click(root, 'confirm-delete'); await vi.waitFor(() => expect(root.textContent).toContain('Subscription deleted locally.')); }
  else if (operation === 'refresh' || operation === 'replace') {
    if (operation === 'replace') data.subscriptions = (data.subscriptions as Subscription[]).map((entry) => ({ ...entry, merchant: 'Replacement', updatedAt: new Date().toISOString() }));
    await view.refresh();
  }
  else root.remove();
  const focused = document.activeElement;
  const { resolveCancellationGuide } = await import('../shared/guide-catalog');
  const request = sendMessage.mock.calls.find(([request]) => (request as { type: string }).type === 'CLEARCHOICE_SUBSCRIPTION_HELP')![0] as { id: string };
  reply({ type: 'CLEARCHOICE_SUBSCRIPTION_HELP', version: 1, id: request.id, help: resolveCancellationGuide('https://netflix.com') });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(root.querySelector('a')).toBeNull(); expect(row.querySelector('a')).toBeNull(); expect(document.activeElement).toBe(focused);
});

it.each(['wrong-id', 'surplus', 'malicious', 'error', 'reject'])('rejects %s help without exposing links or guessing', async (mode) => {
  const { sendMessage } = await install(); const { root } = await mount();
  click(root, 'add'); fill(root); submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  const { resolveCancellationGuide } = await import('../shared/guide-catalog');
  sendMessage.mockImplementationOnce((request) => {
    if (mode === 'reject') return Promise.reject(new Error('unavailable'));
    const response = { ...(request as object), help: resolveCancellationGuide('https://netflix.com') };
    return Promise.resolve(mode === 'wrong-id' ? { ...response, id: 's_other' } : mode === 'surplus' ? { ...response, extra: 'private' } : mode === 'malicious' ? { ...response, help: { kind: 'site', label: 'Visit site', originURL: 'https://evil.test/path?private' } } : { ok: false, error: 'request-failed' });
  });
  click(root, 'help');
  await vi.waitFor(() => expect(root.textContent).toContain('Could not load cancellation help.'));
  expect(root.querySelector('a')).toBeNull();
  expect(root.textContent).not.toContain('No known provider site');
});

it('allows a fresh help request on a retained row after a failed list refresh', async () => {
  const { sendMessage } = await install(); const { root, view } = await mount();
  click(root, 'add'); fill(root); submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  sendMessage.mockRejectedValueOnce(new Error('offline'));
  expect(await view.refresh()).toBe(false);
  click(root, 'help');
  await vi.waitFor(() => expect(root.textContent).toContain('No known provider site; check your billing provider'));
});

it('review observation and cancel never create; blank confirmation fields require explicit completion and Save persists provenance', async () => {
  const { data, set, restart } = await install();
  const item = { id: 'f_source', origin: 'https://merchant.test', kind: 'recurring-charge' as const, reason: 'price-cadence' as const, screenedExcerpt: 'Monthly plan $10.00', firstSeen: new Date().toISOString(), latestSeen: new Date().toISOString(), status: 'reviewed' as const };
  data.reviewHistory = [{ ...item, opaqueFingerprint: 'a'.repeat(64), ordinal: 1 }];
  const { root, view } = await mount();
  const reviewRoot = document.createElement('div'); document.body.append(reviewRoot);
  const { mountReview } = await import('./review');
  mountReview(reviewRoot, (item, control) => view.reviewAsSubscription(item, control));
  await vi.waitFor(() => expect(reviewRoot.querySelector('[data-action="review-as-subscription"]')).not.toBeNull());
  expect(data.subscriptions).toEqual([]);
  const control = reviewRoot.querySelector<HTMLButtonElement>('[data-action="review-as-subscription"]')!;
  control.click();
  for (const name of ['merchant', 'amount', 'currency', 'cadence']) expect((root.querySelector(`[name="${name}"]`) as HTMLInputElement).value).toBe('');
  expect(root.textContent).toContain(item.origin); expect(root.textContent).toContain(item.kind); expect(root.textContent).toContain(item.screenedExcerpt);
  submit(root); expect(root.textContent).toContain('Invalid subscription'); expect(set).not.toHaveBeenCalled();
  click(root, 'cancel'); expect(data.subscriptions).toEqual([]); expect(document.activeElement).toBe(control);
  control.click(); fill(root); submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  expect(data.subscriptions).toEqual([expect.objectContaining({ merchant: 'Acme', sourceFindingId: item.id })]);
  expect(data.reviewHistory).toEqual([{ ...item, opaqueFingerprint: 'a'.repeat(64), ordinal: 1 }]);
  expect(set).toHaveBeenCalledTimes(1);
  await restart(); expect((await mount()).root.textContent).toContain('Acme');
});

it.each(['add', 'edit'])('history refresh preserves unrelated manual %s after a failed pending Save', async (operation) => {
  const { set } = await install(); const { root, view } = await mount();
  if (operation === 'edit') {
    click(root, 'add'); fill(root); submit(root);
    await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  }
  const reviewRoot = document.createElement('div'); document.body.append(reviewRoot);
  const { mountReview } = await import('./review');
  mountReview(reviewRoot, view.reviewAsSubscription, view.invalidateSuggestion);
  await vi.waitFor(() => expect(reviewRoot.textContent).not.toContain('Loading local history'));
  click(root, operation); fill(root);
  const form = root.querySelector('form')!;
  const refresh = reviewRoot.querySelector<HTMLButtonElement>('[data-action="review-refresh"]')!;
  refresh.click();
  expect(root.querySelector('form')).toBe(form);
  let fail!: (error: Error) => void;
  set.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  submit(root);
  await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
  refresh.click();
  fail(new Error('quota'));
  await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false));
  expect(root.querySelector('form')).toBe(form);
  expect(root.querySelector<HTMLInputElement>('[name="merchant"]')!.value).toBe('  Acme  ');
  expect(root.textContent).toContain('Could not save local subscription.');
  expect(root.textContent).not.toContain('Observation changed or refreshed.');
});

it('does not leak suggestion invalidation through a failed deletion into a manual draft', async () => {
  const { set } = await install(); const { root, view } = await mount();
  click(root, 'add'); fill(root); submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  const source = { id: 'f_source', origin: 'https://merchant.test', kind: 'recurring-charge' as const, reason: 'price-cadence' as const, screenedExcerpt: 'Monthly plan $10.00', firstSeen: new Date().toISOString(), latestSeen: new Date().toISOString(), status: 'needs-review' as const };
  const control = document.createElement('button'); document.body.append(control);
  view.reviewAsSubscription(source, control);
  click(root, 'delete');
  let failDelete!: (error: Error) => void;
  set.mockImplementationOnce(() => new Promise((_, reject) => { failDelete = reject; }));
  click(root, 'confirm-delete');
  await vi.waitFor(() => expect(failDelete).toBeTypeOf('function'));
  const reviewRoot = document.createElement('div'); document.body.append(reviewRoot);
  const { mountReview } = await import('./review');
  mountReview(reviewRoot, view.reviewAsSubscription, view.invalidateSuggestion);
  reviewRoot.querySelector<HTMLButtonElement>('[data-action="review-refresh"]')!.click();
  failDelete(new Error('quota'));
  await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[data-subscription-action="add"]')!.disabled).toBe(false));
  click(root, 'add'); fill(root);
  const form = root.querySelector('form')!;
  set.mockRejectedValueOnce(new Error('quota'));
  submit(root);
  await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[data-subscription-action="add"]')!.disabled).toBe(false));
  expect(root.querySelector('form')).toBe(form);
  expect(root.querySelector<HTMLInputElement>('[name="merchant"]')!.value).toBe('  Acme  ');
  expect(root.textContent).toContain('Could not save local subscription.');
  expect(root.textContent).not.toContain('Observation changed or refreshed.');
});

it('switches suggestion sources without saving a detached old form or carrying old fields', async () => {
  await install(); const { root, view } = await mount();
  const source = { id: 'f_first', origin: 'https://merchant.test', kind: 'recurring-charge' as const, reason: 'price-cadence' as const, screenedExcerpt: 'Monthly plan $10.00', firstSeen: new Date().toISOString(), latestSeen: new Date().toISOString(), status: 'needs-review' as const };
  const control = document.createElement('button'); document.body.append(control);
  view.reviewAsSubscription(source, control); fill(root); const oldForm = root.querySelector('form')!;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  view.reviewAsSubscription({ ...source, id: 'f_second', screenedExcerpt: 'Annual plan $20.00' }, control);
  expect(root.textContent).toContain('Annual plan $20.00'); expect(root.textContent).not.toContain('Monthly plan $10.00');
  expect(root.querySelector<HTMLInputElement>('[name="merchant"]')!.value).toBe('');
  oldForm.dispatchEvent(new Event('submit', { cancelable: true }));
  expect(root.querySelector('form')).not.toBeNull();
  view.invalidateSuggestion(); expect(root.querySelector('form')).toBeNull();
});

it('does not falsely confirm a missing source or a mismatched provenance acknowledgement', async () => {
  const { data, sendMessage } = await install(); const { root, view } = await mount();
  const source = { id: 'f_missing', origin: 'https://merchant.test', kind: 'recurring-charge' as const, reason: 'price-cadence' as const, screenedExcerpt: 'Monthly plan $10.00', firstSeen: new Date().toISOString(), latestSeen: new Date().toISOString(), status: 'reviewed' as const };
  const control = document.createElement('button'); document.body.append(control);
  view.reviewAsSubscription(source, control); fill(root); submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Could not save local subscription'));
  expect(data.subscriptions).toEqual([]); expect(root.querySelector('form')).not.toBeNull();
  const subscription = { id: 's_forged', merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly', notes: 'Family plan', nextBillingDate: '2026-10-01', createdAt: source.firstSeen, updatedAt: source.firstSeen, sourceFindingId: 'f_other' };
  sendMessage.mockResolvedValueOnce({ type: 'CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING', version: 1, subscription });
  submit(root);
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING' })));
  await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false));
  expect(root.textContent).not.toContain('Subscription saved locally.'); expect(data.subscriptions).toEqual([]);
});

it('requires delete confirmation, cancellation leaves storage intact, and confirmation persists deletion', async () => {
  const { data, set, restart } = await install();
  const { root } = await mount();
  click(root, 'add'); fill(root); submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  const snapshot = structuredClone(data); const writes = set.mock.calls.length;
  click(root, 'delete'); expect(root.textContent).toContain('Delete subscription?');
  click(root, 'cancel'); expect(data).toEqual(snapshot); expect(set).toHaveBeenCalledTimes(writes);
  click(root, 'delete'); click(root, 'confirm-delete');
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription deleted locally.'));
  expect(data.subscriptions).toEqual([]);
  await restart(); expect((await mount()).root.textContent).not.toContain('Acme');
});

it('cancels an unsaved form without writing any subscription', async () => {
  const { data, set } = await install(); const { root } = await mount();
  click(root, 'add'); fill(root); click(root, 'cancel');
  expect(root.querySelector('form')).toBeNull(); expect(data.subscriptions).toEqual([]); expect(set).not.toHaveBeenCalled();
});

it('does not claim saved when acknowledgement is not present in persisted readback', async () => {
  const { data, set } = await install(); const { root } = await mount();
  set.mockResolvedValueOnce(undefined); // Chrome acknowledged, but storage did not retain the value.
  click(root, 'add'); fill(root); submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Could not save local subscription'));
  expect(root.textContent).not.toContain('Subscription saved locally.');
  expect(root.querySelector('form')).not.toBeNull(); expect(data.subscriptions).toEqual([]);
});

it('does not claim deletion when readback fails after the mutation', async () => {
  const { get, data } = await install(); const { root } = await mount();
  click(root, 'add'); fill(root); submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  click(root, 'delete');
  get.mockResolvedValueOnce(structuredClone(data));
  get.mockRejectedValueOnce(new Error('storage read failed'));
  click(root, 'confirm-delete');
  await vi.waitFor(() => expect(root.textContent).toContain('Could not delete local subscription'));
  expect(root.textContent).not.toContain('Subscription deleted locally.');
});

it('ignores stale list responses after a newer refresh completes', async () => {
  const { data, sendMessage } = await install(); const { root, view } = await mount();
  let release!: (value: unknown) => void;
  sendMessage.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const stale = view.refresh();
  const entry = { id: 's_fresh', merchant: 'Fresh merchant', amount: '2.00', currency: 'USD', cadence: 'monthly', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  data.subscriptions = [entry]; await view.refresh();
  expect(root.textContent).toContain('Fresh merchant');
  release({ type: 'CLEARCHOICE_SUBSCRIPTION_LIST', version: 1, subscriptions: [] }); await stale;
  expect(root.textContent).toContain('Fresh merchant');
});

it('rejects a valid-shaped acknowledgement for a different update target', async () => {
  const { data, sendMessage } = await install(); const { root, view } = await mount();
  const fields = { merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly' };
  const first = { ...fields, id: 's_first', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const other = { ...first, id: 's_other' }; data.subscriptions = [first, other]; await view.refresh();
  click(root, 'edit');
  sendMessage.mockResolvedValueOnce({ type: 'CLEARCHOICE_SUBSCRIPTION_UPDATE', version: 1, subscription: other });
  submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Could not save local subscription'));
  expect(root.querySelector('form')).not.toBeNull(); expect(data.subscriptions).toEqual([first, other]);
});

it('keeps one pending save and disables competing edits, refresh and cancel', async () => {
  const { set, data, sendMessage } = await install(); const { root } = await mount();
  let release!: () => void;
  set.mockImplementationOnce(async (payload) => { await new Promise<void>((resolve) => { release = resolve; }); Object.assign(data, structuredClone(payload)); });
  click(root, 'add'); fill(root); submit(root);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(root.querySelector<HTMLButtonElement>('[data-subscription-action="add"]')!.disabled).toBe(true);
  expect(root.querySelector<HTMLButtonElement>('[data-subscription-action="cancel"]')!.disabled).toBe(true);
  submit(root); release();
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  expect(root.querySelector<HTMLButtonElement>('[data-subscription-action="add"]')!.disabled).toBe(false);
  expect(document.activeElement).toBe(root.querySelector('[data-subscription-action="add"]'));
  expect(sendMessage.mock.calls.filter(([request]) => (request as { type: string }).type === 'CLEARCHOICE_SUBSCRIPTION_CREATE')).toHaveLength(1);
});

it.each([
  ['amount', '0.00'], ['amount', '10'], ['amount', '-1.00'], ['amount', '1e2'],
  ['nextBillingDate', '2026-02-30'], ['nextBillingDate', '2026-2-01'],
  ['currency', 'ZZZ'], ['merchant', 'account number 123456789'], ['notes', 'https://private.test'],
  ['cadence', 'custom'],
])('rejects invalid %s=%s before crossing the worker boundary', async (name, invalid) => {
  const { data, set, sendMessage } = await install(); const { root } = await mount();
  click(root, 'add'); fill(root); value(root, name, invalid); submit(root);
  expect(root.textContent).toContain('Invalid subscription.');
  expect(data.subscriptions).toEqual([]); expect(set).not.toHaveBeenCalled();
  expect(sendMessage.mock.calls.some(([request]) => (request as { type: string }).type === 'CLEARCHOICE_SUBSCRIPTION_CREATE')).toBe(false);
});

it.each(['create', 'update', 'delete'])('reports %s storage failure without claiming success or changing stored records', async (operation) => {
  const { data, set } = await install(); const { root } = await mount();
  if (operation !== 'create') {
    click(root, 'add'); fill(root); submit(root);
    await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  }
  const snapshot = structuredClone(data); set.mockRejectedValueOnce(new Error('quota'));
  if (operation === 'delete') { click(root, 'delete'); click(root, 'confirm-delete'); }
  else { click(root, operation === 'create' ? 'add' : 'edit'); fill(root); submit(root); }
  await vi.waitFor(() => expect(root.textContent).toContain(operation === 'delete' ? 'Could not delete local subscription' : 'Could not save local subscription'));
  expect(data).toEqual(snapshot);
  expect(root.textContent).not.toContain('Subscription saved locally.');
  expect(root.textContent).not.toContain('Subscription deleted locally.');
});

it('renders all 500 subscriptions safely without truncation', async () => {
  const { data } = await install();
  const instant = '2026-01-01T00:00:00.000Z';
  data.subscriptions = Array.from({ length: 500 }, (_, index) => ({ id: `s_${index}`, merchant: `Merchant ${index}`, amount: '1.00', currency: 'USD', cadence: 'monthly', createdAt: instant, updatedAt: instant }));
  const { root } = await mount();
  expect(root.querySelectorAll('article')).toHaveLength(500);
  expect(root.querySelectorAll('[data-subscription-action="edit"]')).toHaveLength(500);
  expect(root.textContent).toContain('Merchant 499');
  expect(root.querySelectorAll('[data-subscription-action="edit"]')[499].getAttribute('aria-label')).toBe('Edit subscription Merchant 499');
  expect(root.querySelectorAll('[data-subscription-action="delete"]')[499].getAttribute('aria-label')).toBe('Delete subscription Merchant 499');
});

it('provides a retry control after a local list read fails', async () => {
  const { get } = await install(); get.mockRejectedValueOnce(new Error('read failed'));
  const { root } = await mount(); expect(root.textContent).toContain('Could not load local subscriptions');
  click(root, 'refresh'); await vi.waitFor(() => expect(root.textContent).toContain('No subscriptions saved.'));
});

it('verifies persisted fields regardless of object key order', async () => {
  const { data, set } = await install(); const { root } = await mount();
  set.mockImplementationOnce(async (payload) => {
    data.subscriptions = (payload.subscriptions as Subscription[]).map((entry) => Object.fromEntries(Object.entries(entry).reverse()));
  });
  click(root, 'add'); fill(root); submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
});

it('renders user text literally through the real worker boundary', async () => {
  const { data } = await install(); const { root } = await mount();
  click(root, 'add'); fill(root); value(root, 'merchant', '<img onerror=alert(1)>'); submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  expect(root.querySelector('img')).toBeNull(); expect(root.textContent).toContain('<img onerror=alert(1)>');
  expect((data.subscriptions as Subscription[])[0].merchant).toBe('<img onerror=alert(1)>');
});

it.each([
  null, { type: 'CLEARCHOICE_SUBSCRIPTION_LIST', version: 2, subscriptions: [] },
  { type: 'CLEARCHOICE_SUBSCRIPTION_LIST', version: 1, subscriptions: [], extra: 'untrusted' },
  { type: 'CLEARCHOICE_SUBSCRIPTION_LIST', version: 1, subscriptions: [{ merchant: 'Unvalidated' }] },
])('rejects a malformed subscription list %j without rendering raw values', async (response) => {
  const { sendMessage } = await install(); sendMessage.mockResolvedValueOnce(response);
  const { root } = await mount(); expect(root.textContent).toContain('Could not load local subscriptions');
  expect(root.querySelectorAll('article')).toHaveLength(0); expect(root.textContent).not.toContain('No subscriptions saved.');
});

it('creates a locally confirmed subscription through the queued store and reopens it', async () => {
  const { data, sendMessage } = await install();
  const { root } = await mount();
  expect(root.textContent).toContain('Subscriptions');
  click(root, 'add');
  expect(document.activeElement).toBe(root.querySelector('[name="merchant"]'));
  fill(root);
  submit(root);
  await vi.waitFor(() => expect(data.subscriptions).toHaveLength(1));
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  expect(sendMessage).toHaveBeenCalledWith({ type: 'CLEARCHOICE_SUBSCRIPTION_CREATE', version: 1, fields: { merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly', nextBillingDate: '2026-10-01', notes: 'Family plan' } });
  expect((data.subscriptions as Subscription[])[0]).not.toHaveProperty('sourceFindingId');
  const reopened = await mount();
  expect(reopened.root.textContent).toContain('Acme');
  expect(reopened.root.textContent).toContain('10.00 USD');
  expect(reopened.root.textContent).toContain('2026-10-01');
});

it('edits fields explicitly and retains identity across worker recreation', async () => {
  const { data, restart } = await install();
  let { root } = await mount();
  click(root, 'add'); fill(root); submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  const prior = structuredClone((data.subscriptions as Subscription[])[0]);
  click(root, 'edit');
  expect(root.querySelector<HTMLInputElement>('[name="merchant"]')!.value).toBe('Acme');
  value(root, 'merchant', 'New merchant'); value(root, 'amount', '20.00');
  value(root, 'cadence', 'custom'); value(root, 'customDescription', 'Every six weeks');
  value(root, 'notes', ''); value(root, 'nextBillingDate', '');
  expect(data.subscriptions).toEqual([prior]);
  submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  expect((data.subscriptions as Subscription[])[0]).toMatchObject({ id: prior.id, createdAt: prior.createdAt, merchant: 'New merchant', amount: '20.00', cadence: 'custom', customDescription: 'Every six weeks' });
  expect((data.subscriptions as Subscription[])[0]).not.toHaveProperty('notes');
  await restart(); ({ root } = await mount());
  expect(root.textContent).toContain('Every six weeks');
});

it('associates field errors and focuses the first invalid field without losing input', async () => {
  await install(); const { root } = await mount(); click(root, 'add'); fill(root);
  value(root, 'amount', '0.00'); value(root, 'currency', 'ZZZ'); submit(root);
  const amount = root.querySelector<HTMLInputElement>('[name="amount"]')!;
  expect(document.activeElement).toBe(amount);
  expect(amount.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById(amount.getAttribute('aria-describedby')!)?.textContent).toContain('two decimal');
  expect(root.querySelector<HTMLInputElement>('[name="merchant"]')!.value).toBe('  Acme  ');
});

it('requires discard approval before replacing a dirty editor and preserves custom cadence input', async () => {
  await install(); const { root } = await mount(); click(root, 'add'); fill(root);
  value(root, 'cadence', 'custom'); value(root, 'customDescription', 'Every six weeks');
  value(root, 'cadence', 'monthly'); value(root, 'cadence', 'custom');
  expect(root.querySelector<HTMLInputElement>('[name="customDescription"]')!.value).toBe('Every six weeks');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  click(root, 'add'); expect(confirm).toHaveBeenCalled();
  expect(root.querySelector<HTMLInputElement>('[name="merchant"]')!.value).toBe('  Acme  ');
  confirm.mockReturnValue(true); click(root, 'add');
  expect(root.querySelector<HTMLInputElement>('[name="merchant"]')!.value).toBe('');
  confirm.mockRestore();
});

it('announces saving immediately and marks its editor busy', async () => {
  const { sendMessage } = await install(); const { root } = await mount(); click(root, 'add'); fill(root);
  sendMessage.mockImplementationOnce(() => new Promise(() => {})); submit(root);
  expect(root.textContent).toContain('Saving subscription…');
  expect(root.querySelector('[data-subscription-editor]')?.getAttribute('aria-busy')).toBe('true');
});

it.each(['edit', 'delete', 'observation'])('keeps dirty input when %s replacement is declined, then replaces only on approval', async (action) => {
  const { data, sendMessage } = await install(); const { root, view } = await mount();
  click(root, 'add'); fill(root); submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  click(root, 'edit'); value(root, 'merchant', 'Unsaved change');
  const originalForm = root.querySelector('form'); const snapshot = structuredClone(data);
  const source = { id: 'f_new', origin: 'https://merchant.test', kind: 'recurring-charge' as const, reason: 'price-cadence' as const, screenedExcerpt: 'Monthly plan $10.00', firstSeen: new Date().toISOString(), latestSeen: new Date().toISOString(), status: 'needs-review' as const };
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const replace = () => action === 'observation' ? view.reviewAsSubscription(source, root.querySelector('button')!) : click(root, action);
  const calls = sendMessage.mock.calls.length;
  replace(); expect(root.querySelector('form')).toBe(originalForm);
  expect(root.querySelector<HTMLInputElement>('[name="merchant"]')!.value).toBe('Unsaved change');
  expect(confirm).toHaveBeenCalledOnce(); expect(sendMessage.mock.calls).toHaveLength(calls);
  confirm.mockReturnValue(true); replace(); expect(originalForm?.isConnected).toBe(false);
  expect(data).toEqual(snapshot); expect(sendMessage.mock.calls).toHaveLength(calls);
});

it('Cancel intentionally discards without a replacement prompt or a write', async () => {
  const { sendMessage } = await install(); const { root } = await mount(); click(root, 'add'); fill(root);
  const confirm = vi.spyOn(window, 'confirm'); const calls = sendMessage.mock.calls.length;
  click(root, 'cancel'); expect(root.querySelector('form')).toBeNull();
  expect(confirm).not.toHaveBeenCalled(); expect(sendMessage.mock.calls).toHaveLength(calls);
  expect(document.activeElement).toBe(root.querySelector('[data-subscription-action="add"]'));
});

it('disables only the pending help button and does not move focus on settlement', async () => {
  const { sendMessage } = await install(); const { root } = await mount(); click(root, 'add'); fill(root); submit(root);
  await vi.waitFor(() => expect(root.textContent).toContain('Subscription saved locally.'));
  let resolve!: (value: unknown) => void;
  sendMessage.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  click(root, 'help'); const help = root.querySelector<HTMLButtonElement>('[data-subscription-action="help"]')!;
  expect(help.disabled).toBe(true); expect(root.querySelector('article [role="status"]')?.getAttribute('aria-busy')).toBe('true');
  const add = root.querySelector<HTMLButtonElement>('[data-subscription-action="add"]')!;
  expect(add.disabled).toBe(false); add.focus(); resolve(null);
  await vi.waitFor(() => expect(help.disabled).toBe(false)); expect(document.activeElement).toBe(add);
});
