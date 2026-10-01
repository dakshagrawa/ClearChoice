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
    tabs: { query: vi.fn().mockResolvedValue([]), onUpdated: event, onRemoved: event },
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
  await vi.waitFor(() => expect(root.textContent).not.toContain('Loading subscriptions'));
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

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

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
