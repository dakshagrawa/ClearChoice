import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

it('mounts manual subscriptions separately from history without an active site and keeps Analyze/Restore first', async () => {
  vi.resetModules(); document.body.innerHTML = '<div id="app"></div>';
  const request = vi.fn();
  const sendMessage = vi.fn(async (message: { type: string }) => message.type === 'CLEARCHOICE_SUBSCRIPTION_LIST'
    ? { type: message.type, version: 1, subscriptions: [] }
    : { type: message.type, version: 1, offset: 0, total: 0, needsReviewCount: 0, findings: [], retentionPolicy: 30 });
  vi.stubGlobal('chrome', { runtime: { sendMessage }, tabs: { query: vi.fn().mockResolvedValue([]) }, permissions: { request } });
  await import('./main');
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Subscriptions"]')?.textContent).toContain('No subscriptions saved.'));
  expect(document.querySelector('#review-heading')).not.toBeNull();
  const buttons = [...document.querySelectorAll('button')];
  expect(buttons.slice(0, 2).map((button) => button.textContent)).toEqual(['Analyze', 'Restore dismissed findings']);
  document.querySelector<HTMLButtonElement>('[data-subscription-action="add"]')!.click();
  expect(document.querySelector('[name="merchant"]')).not.toBeNull(); expect(request).not.toHaveBeenCalled();
});

it('keeps an explicit analysis live region directly under main', async () => {
  const { app } = await renderPopupBeforeResponse();
  const status = app.querySelector('[data-analysis-status]');
  expect(status).not.toBeNull();
  expect(status?.parentElement).toBe(app.querySelector('main'));
  expect(status?.getAttribute('role')).toBe('status');
  expect(status?.getAttribute('aria-live')).toBe('polite');
  expect(app.querySelector('main > [role="status"]')).toBe(status);
  expect(status?.textContent).toContain('Analyzing');
});

it('places subscriptions before history and keeps site controls outside the disclosure', async () => {
  const { app } = await renderPopupBeforeResponse();
  const subscriptions = app.querySelector('section[aria-label="Subscriptions"]')!;
  const review = app.querySelector('#review-heading')!.closest('section')!;
  expect(subscriptions).not.toBeNull();
  expect(review).not.toBeNull();
  expect(subscriptions.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const site = app.querySelector('section[aria-label="Site detection"]')!;
  const details = site.querySelector('details')!;
  expect(details?.querySelector('summary')?.textContent).toBe('About site detection');
  expect(details?.open).toBe(false);
  expect(site.querySelector('[data-site-status]')?.closest('details')).toBeNull();
  for (const action of ['site-enable', 'site-disable']) {
    const button = site.querySelector(`button[data-action="${action}"]`)!;
    expect(button).not.toBeNull();
    expect(button.closest('details')).toBeNull();
  }
});

it('opens suggestion confirmation after subscriptions mount and invalidates unsaved suggestion on history refresh', async () => {
  vi.resetModules(); document.body.innerHTML = '<div id="app"></div>';
  const item = { id: 'f_source', origin: 'https://merchant.test', kind: 'recurring-charge', reason: 'price-cadence', screenedExcerpt: 'Monthly plan $10.00', firstSeen: '2026-09-29T00:00:00.000Z', latestSeen: '2026-09-29T00:00:00.000Z', status: 'reviewed' };
  const sendMessage = vi.fn(async (message: { type: string }) => message.type === 'CLEARCHOICE_SUBSCRIPTION_LIST'
    ? { type: message.type, version: 1, subscriptions: [] }
    : { type: message.type, version: 1, offset: 0, total: 1, needsReviewCount: 0, findings: [item], retentionPolicy: 'never' });
  vi.stubGlobal('chrome', { runtime: { sendMessage }, tabs: { query: vi.fn().mockResolvedValue([]) } });
  await import('./main');
  await vi.waitFor(() => expect(document.querySelector('[data-action="review-as-subscription"]')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('[data-action="review-as-subscription"]')!.click();
  const oldForm = document.querySelector('form')!;
  expect(oldForm.querySelector('h3')!.textContent).toContain('Confirm observation');
  expect(document.activeElement).toBe(oldForm.querySelector('[name="merchant"]'));
  document.querySelector<HTMLButtonElement>('[data-action="review-refresh"]')!.click();
  expect(document.querySelector('form')).toBeNull();
  oldForm.dispatchEvent(new Event('submit', { cancelable: true }));
  expect(sendMessage.mock.calls.some(([message]) => message.type === 'CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING')).toBe(false);
});

it.each(['rejected', 'invalid acknowledgement', 'readback failure', 'readback mismatch', 'saved'])('consumes history refresh invalidation after a pending suggestion Save: %s', async (outcome) => {
  vi.resetModules(); document.body.innerHTML = '<div id="app"></div>';
  const item = { id: 'f_source', origin: 'https://merchant.test', kind: 'recurring-charge', reason: 'price-cadence', screenedExcerpt: 'Monthly plan $10.00', firstSeen: '2026-09-29T00:00:00.000Z', latestSeen: '2026-09-29T00:00:00.000Z', status: 'reviewed' };
  const subscription = { id: 's_saved', merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly', createdAt: item.firstSeen, updatedAt: item.firstSeen, sourceFindingId: item.id };
  let settle!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  let pending = false;
  const sendMessage = vi.fn((message: { type: string }) => {
    if (message.type === 'CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING') {
      pending = true;
      return new Promise((resolve, fail) => { settle = resolve; reject = fail; });
    }
    if (message.type === 'CLEARCHOICE_SUBSCRIPTION_LIST') {
      if (pending && outcome === 'readback failure') return Promise.reject(new Error('read failed'));
      return Promise.resolve({ type: message.type, version: 1, subscriptions: pending && outcome === 'saved' ? [subscription] : [] });
    }
    return Promise.resolve({ type: message.type, version: 1, offset: 0, total: 1, needsReviewCount: 0, findings: [item], retentionPolicy: 'never' });
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage }, tabs: { query: vi.fn().mockResolvedValue([]) } });
  await import('./main');
  await vi.waitFor(() => expect(document.querySelector('[data-action="review-as-subscription"]')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('[data-action="review-as-subscription"]')!.click();
  const form = document.querySelector('form')!;
  for (const [name, value] of Object.entries({ merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly' }))
    (form.elements.namedItem(name) as HTMLInputElement).value = value;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  expect(sendMessage).toHaveBeenCalledWith({ type: 'CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING', version: 1, id: item.id, fields: { merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly' } });
  expect(form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  const refresh = document.querySelector<HTMLButtonElement>('[data-action="review-refresh"]')!;
  refresh.click();
  await vi.waitFor(() => expect(refresh.disabled).toBe(false));
  if (outcome === 'rejected') reject(new Error('save failed'));
  else settle(outcome === 'invalid acknowledgement' ? null : { type: 'CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING', version: 1, subscription });
  const root = document.querySelector<HTMLElement>('[aria-label="Subscriptions"]')!;
  await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[data-subscription-action="add"]')!.disabled).toBe(false));
  expect(root.querySelector('form')).toBeNull();
  expect(form.isConnected).toBe(false);
  expect(document.activeElement).toBe(root.querySelector('[data-subscription-action="add"]'));
  if (outcome === 'saved') {
    expect(root.textContent).toContain('Subscription saved locally.');
    expect(root.querySelector('[data-subscription-list]')!.textContent).toContain('Acme');
  } else {
    expect(root.textContent).toContain('Could not save local subscription. Check the list before retrying.');
    expect(root.textContent).toContain('Observation changed or refreshed. Review it again before saving a subscription.');
    expect(root.textContent).not.toContain('Subscription saved locally.');
  }
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  expect(sendMessage.mock.calls.filter(([message]) => message.type === 'CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING')).toHaveLength(1);
  // A fresh observation may be reviewed after settlement; the invalidation is consumed.
  document.querySelector<HTMLButtonElement>('[data-action="review-as-subscription"]')!.click();
  expect(root.querySelector('form')).not.toBeNull();
});

it('packages a popup stylesheet with visible keyboard focus and light/dark surfaces, without nested main landmarks', () => {
  const html = readFileSync('src/popup/index.html', 'utf8');
  expect(html).toContain('href="./popup.css"');
  expect(html).toContain('<div id="app"></div>');
  const css = readFileSync('src/popup/popup.css', 'utf8');
  expect(css).toContain(':focus-visible');
  expect(css).toContain('input:focus-visible');
  expect(css).toContain('textarea:focus-visible');
  expect(css).toContain('prefers-color-scheme: dark');
});

function installChrome(response: unknown): { query: ReturnType<typeof vi.fn>; executeScript: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue([{ id: 42, active: true }]);
  const executeScript = vi.fn().mockResolvedValue([]);
  const sendMessage = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('chrome', { tabs: { query, sendMessage: vi.fn() }, scripting: { executeScript }, runtime: { sendMessage } });
  return { query, executeScript, sendMessage };
}

async function renderPopup(response: unknown): Promise<HTMLElement> {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  installChrome(response);
  await import('./main');
  const button = document.querySelector<HTMLButtonElement>('button');
  button?.click();
  await vi.waitFor(() => expect(button?.disabled).toBe(false));
  return document.querySelector<HTMLElement>('#app')!;
}

async function renderPopupBeforeResponse(): Promise<{ app: HTMLElement; resolve: (response: unknown) => void }> {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  let resolveResponse!: (response: unknown) => void;
  installChrome(new Promise((resolve) => { resolveResponse = resolve; }));
  await import('./main');
  document.querySelector<HTMLButtonElement>('button')?.click();
  return { app: document.querySelector<HTMLElement>('#app')!, resolve: resolveResponse };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it('sends the worker-owned exact site request synchronously on click, never on load or Analyze', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const calls: string[] = [];
  const request = vi.fn(() => { calls.push('request'); return Promise.resolve(true); });
  const remove = vi.fn().mockResolvedValue(true);
  const query = vi.fn().mockResolvedValue([{ id: 42, url: 'https://a.test/checkout' }]);
  const get = vi.fn().mockResolvedValue({ id: 42, url: 'https://a.test/checkout' });
  const sendMessage = vi.fn(async (message: { type: string }) => {
    calls.push(message.type);
    if (message.type === 'CLEARCHOICE_SITE_STATUS') return { ok: true, enabled: false, permitted: false };
    if (message.type === 'CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION') return { ok: true, enabled: true, permitted: true };
    return { ok: true, status: 'unsupported-context', findingCount: 0 };
  });
  vi.stubGlobal('chrome', { tabs: { query, get }, permissions: { request, remove }, runtime: { sendMessage } });
  await import('./main');
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-action="site-enable"]')?.disabled).toBe(false));
  expect(request).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('[data-action="analyze"]')?.click();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'CLEARCHOICE_ANALYZE' }));
  expect(request).not.toHaveBeenCalled();
  const before = calls.length;
  document.querySelector<HTMLButtonElement>('[data-action="site-enable"]')?.click();
  expect(calls[before]).toBe('CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION');
  expect(request).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION', origin: 'https://a.test', tabId: 42 }));
  await vi.waitFor(() => expect(document.querySelector('[data-site-status]')?.textContent).toContain('enabled'));
  expect(document.body.textContent).toContain('supported English checkout');
  expect(document.body.textContent).not.toContain('automatic scanning is not available yet');
  expect(document.querySelector('[data-site-status]')?.textContent).toContain('not a completed scan');
  expect(remove).not.toHaveBeenCalled();
});

it.each(['activated', 'updated', 'loading', 'removed'])('invalidates cached site on tab %s before click without requesting permission', async (event) => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const activated: Array<(info: { tabId: number; windowId: number }) => void> = [];
  const updated: Array<(id: number, change: { url?: string; status?: string }) => void> = [];
  const removed: Array<(id: number) => void> = [];
  const request = vi.fn().mockResolvedValue(true);
  const sendMessage = vi.fn().mockResolvedValue({ ok: true, enabled: false, permitted: false });
  vi.stubGlobal('chrome', { tabs: {
    query: vi.fn().mockResolvedValue([{ id: 42 }]),
    get: vi.fn().mockResolvedValue({ id: 42, url: 'https://a.test/path' }),
    onActivated: { addListener: (fn: typeof activated[number]) => activated.push(fn) },
    onUpdated: { addListener: (fn: typeof updated[number]) => updated.push(fn) },
    onRemoved: { addListener: (fn: typeof removed[number]) => removed.push(fn) },
  }, permissions: { request }, runtime: { sendMessage } });
  await import('./main');
  const button = document.querySelector<HTMLButtonElement>('[data-action="site-enable"]')!;
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  if (event === 'activated') activated[0]({ tabId: 7, windowId: 1 });
  else if (event === 'updated') updated[0](42, { url: 'https://b.test/path' });
  else if (event === 'loading') updated[0](42, { status: 'loading' });
  else removed[0](42);
  expect(button.disabled).toBe(true);
  button.click();
  expect(request).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION' }));
});

it('displays worker denial and rejects a stale worker completion after tab navigation', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  let finish!: (response: unknown) => void;
  const request = vi.fn();
  const query = vi.fn().mockResolvedValue([{ id: 42, url: 'https://a.test/path' }]);
  const get = vi.fn().mockResolvedValue({ id: 42, url: 'https://a.test/path' });
  const sendMessage = vi.fn((message: { type: string }) => message.type === 'CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION'
    ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ ok: true, enabled: false, permitted: false }));
  vi.stubGlobal('chrome', { tabs: { query, get }, permissions: { request }, runtime: { sendMessage } });
  await import('./main');
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-action="site-enable"]')?.disabled).toBe(false));
  const button = document.querySelector<HTMLButtonElement>('[data-action="site-enable"]')!;
  button.click(); button.click();
  expect(sendMessage.mock.calls.filter(([message]) => message.type === 'CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION')).toHaveLength(1);
  expect(request).not.toHaveBeenCalled();
  finish({ ok: false, error: 'permission-denied' });
  await vi.waitFor(() => expect(document.querySelector('[data-site-status]')?.textContent).toContain('denied'));
  button.click();
  query.mockResolvedValue([{ id: 42, url: 'https://b.test/path' }]);
  get.mockResolvedValue({ id: 42, url: 'https://b.test/path' });
  finish({ ok: true, enabled: true, permitted: true });
  await vi.waitFor(() => expect(document.querySelector('[data-site-status]')?.textContent).toContain('changed'));
});

it('does not present a stale enabled status after focus changes while worker enable is pending', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  let finish!: (value: unknown) => void;
  const query = vi.fn().mockResolvedValue([{ id: 42 }]);
  const get = vi.fn().mockResolvedValue({ id: 42, url: 'https://a.test/path' });
  const sendMessage = vi.fn((message: { type: string }) => message.type === 'CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION'
    ? new Promise((resolve) => { finish = resolve; })
    : Promise.resolve({ ok: true, enabled: false, permitted: false }));
  vi.stubGlobal('chrome', { tabs: { query, get }, permissions: { request: vi.fn().mockResolvedValue(true) }, runtime: { sendMessage } });
  await import('./main');
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-action="site-enable"]')?.disabled).toBe(false));
  document.querySelector<HTMLButtonElement>('[data-action="site-enable"]')?.click();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION', origin: 'https://a.test', tabId: 42 }));
  query.mockResolvedValue([{ id: 7 }]);
  get.mockResolvedValue({ id: 7, url: 'https://b.test/path' });
  finish({ ok: true, enabled: true, permitted: true });
  await vi.waitFor(() => expect(document.querySelector('[data-site-status]')?.textContent).toContain('changed'));
  expect(document.querySelector('[data-site-status]')?.textContent).not.toContain('Detection enabled');
});

it('never requests access on a non-HTTPS active tab', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const request = vi.fn();
  const sendMessage = vi.fn();
  vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]), get: vi.fn().mockResolvedValue({ id: 42, url: 'http://a.test/path' }) }, permissions: { request }, runtime: { sendMessage } });
  await import('./main');
  await vi.waitFor(() => expect(document.querySelector('[data-site-status]')?.textContent).toContain('only on an HTTPS site'));
  document.querySelector<HTMLButtonElement>('[data-action="site-enable"]')?.click();
  expect(request).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith({ type: 'CLEARCHOICE_REVIEW_LIST', version: 1, offset: 0, limit: 100 });
  expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'CLEARCHOICE_SITE_STATUS' }));
});

it('removes only the current site after worker revocation and reports removal failure honestly', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const query = vi.fn().mockResolvedValue([{ id: 42, url: 'https://a.test/path' }]);
  const get = vi.fn().mockResolvedValue({ id: 42, url: 'https://a.test/path' });
  const remove = vi.fn().mockResolvedValue(false);
  const contains = vi.fn().mockResolvedValue(true);
  const sendMessage = vi.fn(async (message: { type: string }) => ({ ok: true, enabled: message.type === 'CLEARCHOICE_SITE_STATUS', permitted: true }));
  vi.stubGlobal('chrome', { tabs: { query, get }, permissions: { remove, contains, request: vi.fn() }, runtime: { sendMessage } });
  await import('./main');
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-action="site-disable"]')?.disabled).toBe(false));
  document.querySelector<HTMLButtonElement>('[data-action="site-disable"]')?.click();
  await vi.waitFor(() => expect(document.querySelector('[data-site-status]')?.textContent).toContain('Revocation incomplete'));
  expect(sendMessage).toHaveBeenCalledWith({ type: 'CLEARCHOICE_SITE_REVOKE', origin: 'https://a.test' });
  expect(remove).toHaveBeenCalledWith({ origins: ['https://a.test/*'] });
  expect(document.querySelector('[data-site-status]')?.textContent).toContain('Chrome settings');
});

it('confirms successful exact-site browser access removal without touching another site', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const permissions = new Set(['https://a.test/*', 'https://b.test/*']);
  const remove = vi.fn(async ({ origins }: { origins: string[] }) => permissions.delete(origins[0]));
  const contains = vi.fn(async ({ origins }: { origins: string[] }) => origins.every((origin) => permissions.has(origin)));
  const sendMessage = vi.fn(async (message: { type: string }) => ({ ok: true, enabled: message.type === 'CLEARCHOICE_SITE_STATUS', permitted: true }));
  vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]), get: vi.fn().mockResolvedValue({ id: 42, url: 'https://a.test/path' }) }, permissions: { remove, contains }, runtime: { sendMessage } });
  await import('./main');
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-action="site-disable"]')?.disabled).toBe(false));
  document.querySelector<HTMLButtonElement>('[data-action="site-disable"]')?.click();
  await vi.waitFor(() => expect(document.querySelector('[data-site-status]')?.textContent).toContain('browser site access removed'));
  expect(permissions.has('https://b.test/*')).toBe(true);
  expect(remove).toHaveBeenCalledTimes(1);
});

it('lets a user remove residual site permission when detection is off after registration fails', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const permissions = new Set(['https://a.test/*']);
  const remove = vi.fn(async ({ origins }: { origins: string[] }) => permissions.delete(origins[0]));
  const contains = vi.fn(async ({ origins }: { origins: string[] }) => origins.every((origin) => permissions.has(origin)));
  const sendMessage = vi.fn(async (message: { type: string }) => ({ ok: true, enabled: false, permitted: message.type !== 'CLEARCHOICE_SITE_REVOKE' }));
  vi.stubGlobal('chrome', {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]), get: vi.fn().mockResolvedValue({ id: 42, url: 'https://a.test/checkout' }) },
    permissions: { remove, contains, request: vi.fn() }, runtime: { sendMessage },
  });
  await import('./main');
  const disable = document.querySelector<HTMLButtonElement>('[data-action="site-disable"]')!;
  await vi.waitFor(() => expect(document.querySelector('[data-site-status]')?.textContent).toContain('Detection off'));
  expect(disable.disabled).toBe(false);
  disable.click();
  await vi.waitFor(() => expect(remove).toHaveBeenCalledWith({ origins: ['https://a.test/*'] }));
  expect(permissions.size).toBe(0);
});

it('keeps Disable available immediately when permission succeeds but worker registration fails', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const sendMessage = vi.fn(async (message: { type: string }) =>
    message.type === 'CLEARCHOICE_SITE_STATUS' ? { ok: true, enabled: false, permitted: false }
      : { ok: false, error: 'request-failed' });
  const request = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('chrome', {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]), get: vi.fn().mockResolvedValue({ id: 42, url: 'https://a.test/checkout' }) },
    permissions: { request, contains: vi.fn().mockResolvedValue(true) }, runtime: { sendMessage },
  });
  await import('./main');
  const enable = document.querySelector<HTMLButtonElement>('[data-action="site-enable"]')!;
  const disable = document.querySelector<HTMLButtonElement>('[data-action="site-disable"]')!;
  await vi.waitFor(() => expect(enable.disabled).toBe(false));
  enable.click();
  await vi.waitFor(() => expect(document.querySelector('[data-site-status]')?.textContent).toContain('Could not enable detection'));
  expect(request).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith({ type: 'CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION', origin: 'https://a.test', tabId: 42 });
  expect(disable.disabled).toBe(false);
});

it('offers browser-access removal when the worker cannot answer site status', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const permissions = new Set(['https://a.test/*']);
  const contains = vi.fn(async ({ origins }: { origins: string[] }) => origins.every((origin) => permissions.has(origin)));
  const remove = vi.fn(async ({ origins }: { origins: string[] }) => permissions.delete(origins[0]));
  const sendMessage = vi.fn().mockResolvedValue({ ok: false, error: 'request-failed' });
  vi.stubGlobal('chrome', {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]), get: vi.fn().mockResolvedValue({ id: 42, url: 'https://a.test/checkout' }) },
    permissions: { contains, remove, request: vi.fn() }, runtime: { sendMessage },
  });
  await import('./main');
  const disable = document.querySelector<HTMLButtonElement>('[data-action="site-disable"]')!;
  await vi.waitFor(() => expect(document.querySelector('[data-site-status]')?.textContent).toContain('Chrome settings'));
  expect(disable.disabled).toBe(false);
  disable.click();
  await vi.waitFor(() => expect(remove).toHaveBeenCalledWith({ origins: ['https://a.test/*'] }));
  expect(permissions.size).toBe(0);
  expect(document.querySelector('[data-site-status]')?.textContent).not.toContain('Detection disabled and browser site access removed');
});

it('does not offer stale-site removal after a tab event while permission lookup is pending', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const activated: Array<(info: { tabId: number; windowId: number }) => void> = [];
  let finishContains!: (permitted: boolean) => void;
  const contains = vi.fn(() => new Promise<boolean>((resolve) => { finishContains = resolve; }));
  const remove = vi.fn();
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 42 }]),
      get: vi.fn().mockResolvedValue({ id: 42, url: 'https://a.test/checkout' }),
      onActivated: { addListener: (fn: typeof activated[number]) => activated.push(fn) },
    },
    permissions: { contains, remove },
    runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: false, error: 'request-failed' }) },
  });
  await import('./main');
  await vi.waitFor(() => expect(contains).toHaveBeenCalledWith({ origins: ['https://a.test/*'] }));
  activated[0]({ tabId: 7, windowId: 1 });
  finishContains(true);
  const disable = document.querySelector<HTMLButtonElement>('[data-action="site-disable"]')!;
  await vi.waitFor(() => expect(document.querySelector('[data-site-status]')?.textContent).toContain('Active tab changed'));
  expect(disable.disabled).toBe(true);
  disable.click();
  expect(remove).not.toHaveBeenCalled();
});

it('reports revocation-unsafe enable errors with a Chrome settings before restart remedy', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const sendMessage = vi.fn(async (message: { type: string }) => message.type === 'CLEARCHOICE_SITE_STATUS'
    ? { ok: true, enabled: false, permitted: false } : { ok: false, error: 'revocation-unsafe' });
  vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]), get: vi.fn().mockResolvedValue({ url: 'https://a.test' }) }, permissions: { request: vi.fn().mockResolvedValue(true) }, runtime: { sendMessage } });
  await import('./main');
  const enable = document.querySelector<HTMLButtonElement>('[data-action="site-enable"]')!;
  await vi.waitFor(() => expect(enable.disabled).toBe(false));
  enable.click();
  await vi.waitFor(() => expect(document.querySelector('[data-site-status]')?.textContent).toContain('Chrome settings before restarting'));
});

it('directs unsafe initial site state to Chrome settings before restart without blocking history', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]), get: vi.fn().mockResolvedValue({ url: 'https://a.test' }) }, permissions: { contains: vi.fn().mockResolvedValue(true) }, runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: false, error: 'revocation-unsafe' }) } });
  await import('./main');
  await vi.waitFor(() => expect(document.querySelector('[data-site-status]')?.textContent).toContain('Chrome settings before restarting'));
  expect(document.querySelector<HTMLButtonElement>('[data-action="site-disable"]')?.disabled).toBe(false);
  expect(document.querySelector('[data-review-status]')).not.toBeNull();
});

it('uses the exact local-only initial, working, and singular successful statuses', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  installChrome({ ok: true, status: 'supported', findingCount: 1 });
  await import('./main');
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Analyze this tab locally.');

  const pending = await renderPopupBeforeResponse();
  expect(pending.app.querySelector('[role="status"]')?.textContent).toBe('Analyzing this tab locally…');
  pending.resolve({ ok: true, status: 'supported', findingCount: 1 });
  await vi.waitFor(() => expect(pending.app.querySelector('[role="status"]')?.textContent).toBe('1 possible signal found.'));
});

it('uses the exact zero and plural successful finding statuses', async () => {
  const zero = await renderPopup({ ok: true, status: 'supported', findingCount: 0 });
  expect(zero.querySelector('[role="status"]')?.textContent).toBe('No matching signals found on this page.');

  const plural = await renderPopup({ ok: true, status: 'supported', findingCount: 2 });
  expect(plural.querySelector('[role="status"]')?.textContent).toBe('2 possible signals found.');
});

it('uses a neutral unsupported checkout message without implying a language failure', async () => {
  const app = await renderPopup({ ok: true, status: 'unsupported-context', findingCount: 0 });
  expect(app.querySelector('[role="status"]')?.textContent).toBe('This isn’t a supported checkout page. Open a checkout page to use Analyze.');
});

it('uses the exact restricted-page status', async () => {
  const app = await renderPopup({ ok: false, error: 'restricted-page' });
  expect(app.querySelector('[role="status"]')?.textContent).toBe('Chrome does not allow ClearChoice to analyze this page.');
});

it('uses the exact generic injection failure status', async () => {
  const app = await renderPopup({ ok: false, error: 'injection-failed' });
  expect(app.querySelector('[role="status"]')?.textContent).toBe('ClearChoice could not analyze this tab. Reload it and try again.');
});

it('uses active current-tab injection for Restore without analyzing again', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const { query, executeScript, sendMessage } = installChrome({ ok: true });
  await import('./main');

  document.querySelector<HTMLButtonElement>('button:last-of-type')?.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('button:last-of-type')?.disabled).toBe(false));

  expect(query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  expect(executeScript).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith({ type: 'CLEARCHOICE_RESTORE' });
});


it.each(['enabled', 'unavailable', 'navigation', 'permission failure'])('recovers a lost enable acknowledgement: %s', async (outcome) => {
  vi.resetModules(); document.body.innerHTML = '<div id="app"></div>';
  let enabling = false;
  let finishContains!: (value: boolean) => void;
  const get = vi.fn().mockResolvedValue({ id: 42, url: 'https://a.test/checkout' });
  const contains = vi.fn(() => outcome === 'navigation'
    ? new Promise<boolean>((resolve) => { finishContains = resolve; })
    : outcome === 'permission failure' ? Promise.reject(new Error('permission unavailable')) : Promise.resolve(true));
  const remove = vi.fn().mockResolvedValue(true);
  const sendMessage = vi.fn((message: { type: string }) => {
    if (message.type === 'CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION') {
      enabling = true;
      return Promise.reject(new Error('acknowledgement lost'));
    }
    if (message.type === 'CLEARCHOICE_SITE_STATUS' && enabling) return outcome === 'unavailable'
      ? Promise.reject(new Error('worker unavailable')) : Promise.resolve({ ok: true, enabled: true, permitted: true });
    return Promise.resolve({ ok: true, enabled: false, permitted: false });
  });
  vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]), get }, permissions: { contains, remove }, runtime: { sendMessage } });
  await import('./main');
  const enable = document.querySelector<HTMLButtonElement>('[data-action="site-enable"]')!;
  const disable = document.querySelector<HTMLButtonElement>('[data-action="site-disable"]')!;
  const status = document.querySelector('[data-site-status]')!;
  await vi.waitFor(() => expect(enable.disabled).toBe(false));
  enable.click();
  if (outcome === 'navigation') {
    await vi.waitFor(() => expect(contains).toHaveBeenCalled());
    get.mockResolvedValue({ id: 42, url: 'https://b.test/checkout' });
    finishContains(true);
    await vi.waitFor(() => expect(status.textContent).toContain('Active tab changed'));
    expect(enable.disabled).toBe(true); expect(disable.disabled).toBe(true);
    enable.click(); disable.click();
    expect(remove).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'CLEARCHOICE_SITE_STATUS')).toHaveLength(1);
  } else {
    await vi.waitFor(() => expect(status.textContent).toContain(outcome === 'enabled' ? 'Detection enabled' : 'completion is unknown'));
    expect(status.textContent).not.toContain('remains off');
    expect(enable.disabled).toBe(true);
    if (outcome === 'permission failure') expect(status.textContent).toContain('Chrome settings');
    else expect(disable.disabled).toBe(false);
    if (outcome === 'unavailable') expect(status.textContent).toContain('browser site access remains');
  }
  expect(sendMessage.mock.calls.filter(([message]) => message.type === 'CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION')).toHaveLength(1);
});


it('keeps navigation invalidation when the enable caller receives an old tab snapshot', async () => {
  vi.resetModules(); document.body.innerHTML = '<div id="app"></div>';
  let activate!: (event: { tabId: number }) => void;
  let finishEnable!: (value: unknown) => void;
  let finishLookup!: (value: { id: number; url: string }) => void;
  const query = vi.fn().mockResolvedValue([{ id: 42 }]);
  const get = vi.fn().mockResolvedValue({ id: 42, url: 'https://a.test/checkout' });
  const request = vi.fn();
  const remove = vi.fn();
  const contains = vi.fn();
  const sendMessage = vi.fn((message: { type: string }) => message.type === 'CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION'
    ? new Promise((resolve) => { finishEnable = resolve; })
    : Promise.resolve({ ok: true, enabled: false, permitted: false }));
  vi.stubGlobal('chrome', {
    tabs: { query, get, onActivated: { addListener: (listener: typeof activate) => { activate = listener; } } },
    permissions: { request, remove, contains }, runtime: { sendMessage },
  });
  await import('./main');
  const enable = document.querySelector<HTMLButtonElement>('[data-action="site-enable"]')!;
  const disable = document.querySelector<HTMLButtonElement>('[data-action="site-disable"]')!;
  const status = document.querySelector('[data-site-status]')!;
  // The final initialization status is rendered only after its sameSite lookup completes.
  await vi.waitFor(() => expect(status.textContent).toBe('Detection off; no browser site access.'));
  expect(enable.disabled).toBe(false);
  get.mockImplementationOnce(() => new Promise((resolve) => { finishLookup = resolve; }));
  enable.click();
  finishEnable({ ok: true, enabled: true, permitted: true });
  await vi.waitFor(() => expect(finishLookup).toBeTypeOf('function'));
  activate({ tabId: 7 });
  expect(status.textContent).toContain('Active tab changed');
  finishLookup({ id: 42, url: 'https://a.test/checkout' });
  // Drain the caller continuation, including its finally block, before checking the UI.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(status.textContent).toContain('Active tab changed');
  expect(status.textContent).not.toContain('Detection enabled');
  expect(enable.disabled).toBe(true); expect(disable.disabled).toBe(true);
  enable.click(); disable.click();
  expect(sendMessage.mock.calls.filter(([message]) => message.type.startsWith('CLEARCHOICE_SITE_')).map(([message]) => message)).toEqual([
    { type: 'CLEARCHOICE_SITE_STATUS', origin: 'https://a.test' },
    { type: 'CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION', origin: 'https://a.test', tabId: 42 },
  ]);
  expect(request).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(contains).not.toHaveBeenCalled();
});

it('distinguishes an enabled preference from missing browser permission', async () => {
  vi.resetModules(); document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal('chrome', {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]), get: vi.fn().mockResolvedValue({ id: 42, url: 'https://a.test/checkout' }) },
    runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: true, enabled: true, permitted: false }) },
  });
  await import('./main');
  await vi.waitFor(() => expect(document.querySelector('[data-site-status]')?.textContent).not.toContain('Checking'));
  expect(document.querySelector('[data-site-origin]')?.textContent).toBe('https://a.test');
  expect(document.querySelector('[data-site-status]')?.textContent).toContain('browser site access is absent');
  expect(document.querySelector('[data-site-status]')?.textContent).not.toContain('access granted');
});

it('keeps Restore disabled during Analyze and exposes pending status without moving focus', async () => {
  const { app, resolve } = await renderPopupBeforeResponse();
  const restore = app.querySelector<HTMLButtonElement>('[data-action="restore"]')!;
  expect(restore.disabled).toBe(true);
  expect(app.querySelector('[data-analysis-status]')?.getAttribute('aria-busy')).toBe('true');
  const summary = app.querySelector<HTMLElement>('summary')!; summary.focus();
  resolve({ ok: true, status: 'supported', findingCount: 0 });
  await vi.waitFor(() => expect(restore.disabled).toBe(false));
  expect(document.activeElement).toBe(summary);
  expect(app.querySelector('[data-analysis-status]')?.getAttribute('aria-busy')).toBe('false');
});
