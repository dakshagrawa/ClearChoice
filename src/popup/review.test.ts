import { afterEach, expect, it, vi } from 'vitest';
import type { ReviewItem } from '../shared/messages';

const item = (id = 'legacy-record'): ReviewItem => ({ id, origin: 'https://shop.test', kind: 'recurring-charge', reason: 'renewal-language', screenedExcerpt: 'Renews monthly for $10.00', firstSeen: '2026-09-28T00:00:00.000Z', latestSeen: '2026-09-28T01:00:00.000Z', status: 'needs-review' });
const page = (findings = [item()], total = findings.length, offset = 0) => ({ type: 'CLEARCHOICE_REVIEW_LIST', version: 1, offset, total, needsReviewCount: total, retentionPolicy: 30, findings });
async function setup(handler: (message: Record<string, unknown>) => unknown = () => page()) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const sendMessage = vi.fn((message: Record<string, unknown>) => message.type === 'CLEARCHOICE_SUBSCRIPTION_LIST'
    ? { type: message.type, version: 1, subscriptions: [] } : handler(message));
  vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockRejectedValue(new Error('restricted')) }, runtime: { sendMessage } });
  await import('./main');
  return sendMessage;
}
it('hides pagination for confirmed empty history without hiding refresh or retention', async () => {
  await setup(() => page([], 0));
  await vi.waitFor(() => expect(document.querySelector('[data-review-status]')?.textContent).toBe('No retained observations.'));
  expect(document.querySelector<HTMLElement>('nav[aria-label="Review history pages"]')!.hidden).toBe(true);
  expect(button('review-previous').disabled).toBe(true);
  expect(button('review-next').disabled).toBe(true);
  expect(button('review-refresh').disabled).toBe(false);
  expect(document.querySelector<HTMLSelectElement>('[data-review-retention]')!.disabled).toBe(false);
});

it('keeps pagination stable during reads and recovers through populated, failed and empty history', async () => {
  let records: ReviewItem[] = [];
  let fail = false;
  let hold = false;
  let finish!: (value: unknown) => void;
  await setup((message) => {
    if (fail) throw new Error('read unavailable');
    const response = page(records.slice(Number(message.offset), Number(message.offset) + 100), records.length, Number(message.offset));
    return hold ? new Promise((resolve) => { finish = resolve; }) : response;
  });
  const pagination = document.querySelector<HTMLElement>('nav[aria-label="Review history pages"]')!;
  await vi.waitFor(() => expect(document.querySelector('[data-review-status]')?.textContent).toBe('No retained observations.'));
  expect(pagination.hidden).toBe(true);
  records = Array.from({ length: 101 }, (_, i) => item(`record-${i}`));
  button('review-refresh').click();
  await vi.waitFor(() => expect(button('review-next').disabled).toBe(false));
  expect(pagination.hidden).toBe(false);
  hold = true;
  button('review-next').click();
  expect(pagination.hidden).toBe(false);
  expect(button('review-next').disabled).toBe(true);
  finish(page(records.slice(100), 101, 100));
  await vi.waitFor(() => expect(document.querySelector('[data-review-id="record-100"]')).not.toBeNull());
  expect(pagination.hidden).toBe(false);
  expect(button('review-previous').disabled).toBe(false);
  hold = false; fail = true;
  button('review-refresh').click();
  await vi.waitFor(() => expect(document.querySelector('[data-review-status]')?.textContent).toContain('Could not load'));
  expect(pagination.hidden).toBe(false);
  expect(button('review-previous').disabled).toBe(true);
  expect(button('review-next').disabled).toBe(true);
  fail = false; records = [];
  button('review-refresh').click();
  await vi.waitFor(() => expect(document.querySelector('[data-review-status]')?.textContent).toBe('No retained observations.'));
  expect(pagination.hidden).toBe(true);
});

it('paginates all 500 retained records with stable IDs, including pages beyond 100', async () => {
  const records = Array.from({ length: 500 }, (_, i) => item(`record-${i}`));
  const send = await setup((message) => page(records.slice(Number(message.offset), Number(message.offset) + 100), 500, Number(message.offset)));
  await vi.waitFor(() => expect(document.querySelectorAll('[data-review-id]').length).toBe(100));
  for (const offset of [100, 200, 300, 400]) {
    button('review-next').click();
    await vi.waitFor(() => expect(document.querySelector(`[data-review-id="record-${offset}"]`)).not.toBeNull());
  }
  expect(button('review-next').disabled).toBe(true);
  button('review-previous').click();
  await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith({ type: 'CLEARCHOICE_REVIEW_LIST', version: 1, offset: 300, limit: 100 }));
});

it('rejects malformed or incomplete pages without displaying a zero success and can retry', async () => {
  const send = await setup(() => ({ ...page([], 10), needsReviewCount: 0 }));
  await vi.waitFor(() => expect(document.querySelector('[data-review-status]')?.textContent).toContain('Could not load'));
  expect(document.querySelector('[data-review-count]')?.textContent).toContain('unavailable');
  send.mockResolvedValue(page([], 0));
  button('review-refresh').click();
  await vi.waitFor(() => expect(document.querySelector('[data-review-status]')?.textContent).toBe('No retained observations.'));
});

it('prevents earlier overlapping reads from overwriting a newer response and renders hostile text literally', async () => {
  let finish!: (value: unknown) => void;
  const send = await setup(() => new Promise((resolve) => { finish = resolve; }));
  const old = finish;
  send.mockResolvedValue(page([{ ...item('new'), screenedExcerpt: '<img onerror=alert(1)> Renews monthly' }]));
  button('review-refresh').click();
  await vi.waitFor(() => expect(document.querySelector('[data-review-id="new"]')).not.toBeNull());
  old(page([item('old')]));
  await Promise.resolve();
  expect(document.querySelector('[data-review-id="old"]')).toBeNull();
  expect(document.querySelector('[data-review-items] img')).toBeNull();
  expect(document.querySelector('[data-review-id="new"]')?.textContent).toContain('<img onerror=alert(1)>');
});

it.each(['review-mark', 'review-delete'])('keeps records unchanged during %s failure and disables duplicate mutations', async (action) => {
  let finish!: (value: unknown) => void;
  const send = await setup((message) => message.type === 'CLEARCHOICE_REVIEW_LIST' ? page() : new Promise((resolve) => { finish = resolve; }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await vi.waitFor(() => expect(document.querySelector('[data-review-id]')).not.toBeNull());
  button(action).click();
  expect(button(action).disabled).toBe(true);
  expect(button('review-refresh').disabled).toBe(true);
  expect(document.querySelector('[data-review-id]')).not.toBeNull();
  button(action).click();
  expect(send.mock.calls.filter(([message]) => message.type !== 'CLEARCHOICE_REVIEW_LIST' && message.type !== 'CLEARCHOICE_SUBSCRIPTION_LIST')).toHaveLength(1);
  finish({ ok: false, error: 'request-failed' });
  await vi.waitFor(() => expect(document.querySelector('[data-review-status]')?.textContent).toContain('Could not save'));
  expect(document.querySelector('[data-review-id]')?.textContent).toContain('Needs review');
  expect(button(action).disabled).toBe(false);
});

it('does not delete when confirmation is cancelled; successful mark and delete read back the first page', async () => {
  let records = [item()];
  const send = await setup((message) => {
    if (message.type === 'CLEARCHOICE_REVIEW_LIST') return { ...page(records), needsReviewCount: records.filter((entry) => entry.status === 'needs-review').length };
    if (message.type === 'CLEARCHOICE_REVIEW_MARK') records = records.map((entry) => ({ ...entry, status: 'reviewed' }));
    if (message.type === 'CLEARCHOICE_REVIEW_DELETE') records = [];
    return { ok: true };
  });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await vi.waitFor(() => expect(document.querySelector('[data-review-id]')).not.toBeNull());
  button('review-delete').click();
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'CLEARCHOICE_REVIEW_DELETE' }));
  button('review-mark').click();
  await vi.waitFor(() => expect(document.querySelector('[data-review-id]')?.textContent).toContain('Reviewed'));
  expect(send).toHaveBeenCalledWith({ type: 'CLEARCHOICE_REVIEW_MARK', version: 1, id: 'legacy-record' });
  expect(button('review-mark').disabled).toBe(true);
  confirm.mockReturnValue(true);
  button('review-delete').click();
  await vi.waitFor(() => expect(document.querySelector('[data-review-status]')?.textContent).toBe('No retained observations.'));
  expect(send).toHaveBeenLastCalledWith({ type: 'CLEARCHOICE_REVIEW_LIST', version: 1, offset: 0, limit: 100 });
});

it('rolls retention back on failure and reads back success rather than claiming optimistic settings', async () => {
  let policy: number | string = 30;
  let succeed = false;
  const send = await setup((message) => {
    if (message.type === 'CLEARCHOICE_REVIEW_LIST') return { ...page(), retentionPolicy: policy };
    if (!succeed) return { ok: true, unexpected: true };
    policy = message.policy as number | string;
    return { ok: true };
  });
  await vi.waitFor(() => expect(document.querySelector('[data-review-id]')).not.toBeNull());
  const select = document.querySelector<HTMLSelectElement>('[data-review-retention]')!;
  expect(Array.from(select.options, (option) => option.value)).toEqual(['7', '30', '90', 'never']);
  select.value = '7'; select.dispatchEvent(new Event('change'));
  button('retention-apply').click();
  await vi.waitFor(() => expect(select.value).toBe('30'));
  expect(document.querySelector('[data-review-status]')?.textContent).toContain('Could not save');
  succeed = true;
  select.value = 'never'; select.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'CLEARCHOICE_REVIEW_RETENTION', version: 1, policy: 'never' }));
  await vi.waitFor(() => expect(select.disabled).toBe(false));
  expect(select.value).toBe('never');
});

it('refreshes history after manual Analyze without site opt-in', async () => {
  let records: ReviewItem[] = [];
  const send = await setup((message) => {
    if (message.type === 'CLEARCHOICE_REVIEW_LIST') return page(records);
    if (message.type === 'CLEARCHOICE_ANALYZE') { records = [item('manual')]; return { ok: true, status: 'supported', findingCount: 1 }; }
    return { ok: false, error: 'request-failed' };
  });
  await vi.waitFor(() => expect(document.querySelector('[data-review-status]')?.textContent).toBe('No retained observations.'));
  button('analyze').click();
  await vi.waitFor(() => expect(document.querySelector('[data-review-id="manual"]')).not.toBeNull());
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'CLEARCHOICE_SITE_ENABLE' }));
});

it('queues manual Analyze refresh while a mutation is pending, even if the mutation fails', async () => {
  let finish!: (value: unknown) => void;
  let records = [item()];
  await setup((message) => {
    if (message.type === 'CLEARCHOICE_REVIEW_LIST') return page(records);
    if (message.type === 'CLEARCHOICE_REVIEW_MARK') return new Promise((resolve) => { finish = resolve; });
    records = [...records, item('manual-during-mutation')];
    return { ok: true, status: 'supported', findingCount: 1 };
  });
  await vi.waitFor(() => expect(document.querySelector('[data-review-id]')).not.toBeNull());
  button('review-mark').click();
  button('analyze').click();
  await vi.waitFor(() => expect(button('analyze').disabled).toBe(false));
  finish({ ok: false, error: 'request-failed' });
  await vi.waitFor(() => expect(document.querySelector('[data-review-id="manual-during-mutation"]')).not.toBeNull());
});

it('clears stale counts and mutation controls when post-write readback fails', async () => {
  let wrote = false;
  await setup((message) => {
    if (message.type !== 'CLEARCHOICE_REVIEW_LIST') { wrote = true; return { ok: true }; }
    if (wrote) throw new Error('read unavailable');
    return page();
  });
  await vi.waitFor(() => expect(document.querySelector('[data-review-id]')).not.toBeNull());
  button('review-mark').click();
  await vi.waitFor(() => expect(document.querySelector('[data-review-status]')?.textContent).toContain('Could not load'));
  expect(document.querySelector('[data-review-count]')?.textContent).toContain('unavailable');
  expect(document.querySelector('[data-review-id]')).toBeNull();
  expect(document.querySelector<HTMLSelectElement>('[data-review-retention]')?.disabled).toBe(true);
});

it.each([null, { ok: false, error: 'request-failed' }, { ...page(), offset: 100 }, { ...page(), extra: 'untrusted' }])('fails closed on malformed history response %j', async (response) => {
  await setup(() => response);
  await vi.waitFor(() => expect(document.querySelector('[data-review-status]')?.textContent).toContain('Could not load'));
  expect(document.querySelector('[data-review-count]')?.textContent).toContain('unavailable');
  expect(document.querySelector<HTMLSelectElement>('[data-review-retention]')?.value).toBe('');
});

it('returns keyboard focus to Refresh after replacing a focused record on mutation readback', async () => {
  let reviewed = false;
  await setup((message) => {
    if (message.type === 'CLEARCHOICE_REVIEW_MARK') { reviewed = true; return { ok: true }; }
    return { ...page([{ ...item(), status: reviewed ? 'reviewed' : 'needs-review' }]), needsReviewCount: reviewed ? 0 : 1 };
  });
  await vi.waitFor(() => expect(document.querySelector('[data-review-id]')).not.toBeNull());
  button('review-mark').focus();
  button('review-mark').click();
  await vi.waitFor(() => expect(document.querySelector('[data-review-id]')?.textContent).toContain('Reviewed'));
  expect(document.activeElement).toBe(button('review-refresh'));
});

it('resets pagination to the first page after deleting from a later page', async () => {
  let records = Array.from({ length: 101 }, (_, i) => item(`record-${i}`));
  const send = await setup((message) => {
    if (message.type === 'CLEARCHOICE_REVIEW_DELETE') { records = records.filter((record) => record.id !== message.id); return { ok: true }; }
    return page(records.slice(Number(message.offset), Number(message.offset) + 100), records.length, Number(message.offset));
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await vi.waitFor(() => expect(document.querySelectorAll('[data-review-id]')).toHaveLength(100));
  button('review-next').click();
  await vi.waitFor(() => expect(document.querySelector('[data-review-id="record-100"]')).not.toBeNull());
  button('review-delete').click();
  await vi.waitFor(() => expect(document.querySelector('[data-review-id="record-0"]')).not.toBeNull());
  expect(send).toHaveBeenLastCalledWith({ type: 'CLEARCHOICE_REVIEW_LIST', version: 1, offset: 0, limit: 100 });
});

const button = (action: string) => document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

it('loads local review history independently of unavailable site detection and never creates subscriptions', async () => {
  const send = await setup();
  await vi.waitFor(() => expect(document.querySelector('[data-review-count]')?.textContent).toBe('1 observation needs review.'));
  expect(send).toHaveBeenCalledWith({ type: 'CLEARCHOICE_REVIEW_LIST', version: 1, offset: 0, limit: 100 });
  const record = document.querySelector('[data-review-id="legacy-record"]');
  expect(record?.textContent).toContain('https://shop.test');
  expect(record?.textContent).toContain('Renews monthly');
  expect(record?.querySelector('time[datetime="2026-09-28T01:00:00.000Z"]')).not.toBeNull();
  expect(record?.textContent).toContain('Needs review');
  expect(document.body.textContent).toContain('not confirmed subscriptions');
  expect(send.mock.calls.every(([message]) => message.type === 'CLEARCHOICE_REVIEW_LIST' || message.type === 'CLEARCHOICE_SUBSCRIPTION_LIST')).toBe(true);
  expect(button('analyze')).toBe(document.querySelector('button'));
});

it('stages shorter retention with cancel and applies only the confirmed exact policy', async () => {
  let policy = 30;
  const send = await setup((message) => {
    if (message.type === 'CLEARCHOICE_REVIEW_RETENTION') { policy = Number(message.policy); return { ok: true }; }
    return { ...page(), retentionPolicy: policy };
  });
  const select = document.querySelector<HTMLSelectElement>('[data-review-retention]')!;
  await vi.waitFor(() => expect(select.disabled).toBe(false));
  select.value = '7'; select.dispatchEvent(new Event('change'));
  expect(select.value).toBe('30');
  expect(document.querySelector('[data-retention-confirmation]')?.textContent).toContain('7 days');
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'CLEARCHOICE_REVIEW_RETENTION' }));
  button('retention-cancel').click();
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'CLEARCHOICE_REVIEW_RETENTION' }));
  select.value = '7'; select.dispatchEvent(new Event('change')); button('retention-apply').click();
  await vi.waitFor(() => expect(select.value).toBe('7'));
  expect(send).toHaveBeenCalledWith({ type: 'CLEARCHOICE_REVIEW_RETENTION', version: 1, policy: 7 });
});
