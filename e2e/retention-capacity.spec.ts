import { resolveContentReplyDebugger } from './content-reply-debugger';
import { resolveCapacityDebugger } from './capacity-debugger';
import { expect, test } from 'playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PackagedRuntime } from './packaged-runtime';
import { isFindingHistory, isSubscriptionCollection, MAX_REVIEW_HISTORY, type FindingRecord, type Subscription } from '../src/shared/models';
import { LOCAL_STATE_VERSION, type LocalState } from '../src/shared/storage';
import { semanticFingerprint } from '../src/shared/semantic-fingerprint';

// TEST-ONLY STORAGE FIXTURES: not organically collected history, elapsed-time,
// quota failure, in-flight revocation, human toolbar or permission-consent QA.
// Only disposable Chrome storage is seeded; no application grants/API replacements.
async function finding(origin: string, label: string, ageDays: number): Promise<FindingRecord> {
  const evidence = { kind: 'recurring-charge' as const, reason: 'price-cadence' as const,
    screenedExcerpt: `Local mock membership ${label} renews at $12.00 per month.` };
  const opaqueFingerprint = await semanticFingerprint(evidence);
  const id = `f_${createHash('sha256').update(JSON.stringify([origin, opaqueFingerprint, 1])).digest('hex')}`;
  const timestamp = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  return { ...evidence, id, origin, opaqueFingerprint, ordinal: 1,
    firstSeen: timestamp, latestSeen: timestamp, status: 'needs-review' };
}

async function seedAndRestart(runtime: PackagedRuntime, reviewHistory: FindingRecord[], subscriptions: Subscription[] = []) {
  expect(isFindingHistory(reviewHistory)).toBe(true);
  expect(isSubscriptionCollection(subscriptions)).toBe(true);
  const state: LocalState = { version: LOCAL_STATE_VERSION, dismissed: false,
    reviewHistory, subscriptions, retentionPolicy: 'never' };
  const baseline = await runtime.storage();
  expect(baseline.grantState ?? { version: 1, sites: {} }).toEqual({ version: 1, sites: {} });
  const fixture = { ...state, receipts: [] };
  await runtime.worker.evaluate(async value => { await chrome.storage.local.set(value); }, fixture);
  const seeded = await runtime.storage();
  expect(seeded).toEqual({ ...baseline, ...fixture });
  const permissions = await runtime.permissions();
  await runtime.restart(); // Genuine browser restart; no unpacked reload or startup bypass.
  expect(await runtime.storage()).toEqual(seeded);
  expect(await runtime.permissions()).toEqual(permissions);
  return seeded;
}

async function attachSnapshots(name: string, snapshots: Record<string, unknown>) {
  await test.info().attach(name, { body: JSON.stringify({
    scope: 'TEST-ONLY STORAGE FIXTURE; NOT organic history, elapsed-time or human consent coverage',
    ...snapshots,
  }, null, 2), contentType: 'application/json' });
}

async function selectRetention(runtime: PackagedRuntime, popup: Awaited<ReturnType<PackagedRuntime['popup']>>, policy: string) {
  // Open the owning disclosure through its actual summary before interacting.
  const summary = '[aria-labelledby="review-heading"] details:has([data-review-retention]) > summary';
  if (!await popup.evaluate(`document.querySelector('[data-review-retention]').closest('details').open`)) await popup.click(summary);
  await popup.wait(`!document.querySelector('[data-review-retention]').disabled`);
  const before = await runtime.storage();
  const confirmed = await popup.evaluate<string>(`document.querySelector('[data-review-retention]').value`);
  expect(confirmed).toBe(String(before.retentionPolicy));
  await popup.evaluate(`document.querySelector('[data-review-retention]').value=${JSON.stringify(policy)};document.querySelector('[data-review-retention]').dispatchEvent(new Event('change',{bubbles:true}));`);
  if (policy !== 'never' && (confirmed === 'never' || Number(policy) < Number(confirmed))) {
    await popup.wait(`document.querySelector('[data-action="retention-apply"]')?.textContent === 'Apply shorter retention'`);
    expect(await popup.evaluate(`document.querySelector('[data-review-retention]').value`)).toBe(confirmed);
    expect(await runtime.storage()).toEqual(before); // Policy, records and receipts remain confirmed until Apply.
    await popup.click('[data-action="retention-apply"]');
  }
  await popup.wait(`document.querySelector('[data-review-retention]').value === ${JSON.stringify(policy)} && !document.querySelector('[data-review-retention]').disabled`);
  await expect.poll(async () => (await runtime.storage()).retentionPolicy).toBe(policy === 'never' ? 'never' : Number(policy));
}

test('TEST-ONLY STORAGE FIXTURE: Never and 90 retain aged records; 7 expires old source without deleting confirmed subscription', async () => {
  test.setTimeout(90_000);
  const runtime = new PackagedRuntime();
  try {
    const inventory = await runtime.inventory();
    await runtime.start();
    const old = await finding(runtime.a, 'aged', 40);
    const fresh = await finding(runtime.a, 'fresh', 1);
    const subscriptions: Subscription[] = [{ id: 's_fixture_confirmed', merchant: 'Local mock membership',
      amount: '12.00', currency: 'USD', cadence: 'monthly', createdAt: old.firstSeen,
      updatedAt: old.latestSeen, sourceFindingId: old.id }];
    const seeded = await seedAndRestart(runtime, [old, fresh], subscriptions);
    let popup = await runtime.popup();
    await popup.wait(`document.querySelectorAll('[data-review-id]').length === 2`);
    const never = await runtime.storage();
    expect(never).toEqual(seeded); // Production read must not silently prune fixture.
    await selectRetention(runtime, popup, '90');
    const ninety = await runtime.storage();
    expect(ninety).toEqual({ ...seeded, retentionPolicy: 90 });
    await popup.close();
    await runtime.restart();
    popup = await runtime.popup();
    await popup.wait(`document.querySelectorAll('[data-review-id]').length === 2`);
    expect(await runtime.storage()).toEqual(ninety);
    await selectRetention(runtime, popup, '7');
    await popup.wait(`document.querySelectorAll('[data-review-id]').length === 1`);
    const pruned = await runtime.storage();
    expect(pruned).toEqual({ ...seeded, retentionPolicy: 7, reviewHistory: [fresh] });
    expect(pruned.subscriptions).toEqual(subscriptions);
    await popup.click('[data-subscription-action="help"]');
    await popup.wait(`document.querySelector('[data-subscription-list]').textContent.includes('No known provider site; check your billing provider')`);
    expect(await popup.evaluate(`document.querySelectorAll('[data-subscription-list] a').length`)).toBe(0);
    await popup.close();
    await runtime.restart();
    popup = await runtime.popup();
    await popup.wait(`document.querySelectorAll('[data-review-id]').length === 1`);
    expect(await runtime.storage()).toEqual(pruned);
    await popup.close();
    expect(await runtime.inventory()).toEqual(inventory);
    await attachSnapshots('fixture-retention-full-snapshots', { seeded, never, ninety, pruned, restarted: await runtime.storage() });
  } finally { await runtime.stop(); }
});

// Read-only debugger proof of the *original* production content response. It
// neither wraps Chrome APIs nor generates messages/replies. Fail closed if the
// packaged lexical statement changes; no quiet-page false-positive fallback.
async function observeCapacityReply(runtime: PackagedRuntime) {
  const session = await runtime.context.newCDPSession(runtime.page);
  const source = await readFile(runtime.extension + '/content.js', 'utf8');
  const content = resolveContentReplyDebugger(source);
  await session.send('Debugger.enable');
  const breakpoint = await session.send('Debugger.setBreakpointByUrl', {
    url: `chrome-extension://${runtime.extensionId}/content.js`, lineNumber: content.lineNumber,
    columnNumber: content.columnNumber, condition: content.rejectionCondition,
  });
  type ReplyProof = { requestId: string; origin: string; generation: number; reply: unknown;
    pending: boolean; aborted: boolean; findings: { opaqueFingerprint: string; ordinal: number }[] };
  let timer: ReturnType<typeof setTimeout>;
  const proof = new Promise<ReplyProof>((resolve, reject) => {
    timer = setTimeout(() => reject(Error('Original capacity rejection response not observed')), 15_000);
    session.on('Debugger.paused', event => { void (async () => {
      try {
        if (!event.hitBreakpoints?.includes(breakpoint.breakpointId)) throw Error('Unexpected debugger pause');
        const result = await session.send('Debugger.evaluateOnCallFrame', { callFrameId: event.callFrames[0].callFrameId,
          expression: content.identityExpression,
          returnByValue: true, throwOnSideEffect: true });
        if (result.exceptionDetails) throw Error('Production response locals unavailable');
        await session.send('Debugger.resume');
        clearTimeout(timer);
        resolve(result.result.value as ReplyProof);
      } catch (error) {
        await session.send('Debugger.resume').catch(() => undefined);
        clearTimeout(timer);
        reject(error as Error);
      }
    })(); });
  });
  void proof.catch(() => undefined);
  return { proof, close: async () => {
    clearTimeout(timer);
    await session.send('Debugger.disable');
    await session.detach();
  } };
}

// Distinguish capacity rejection from authorization/attestation failures, which
// can also return request-failed. Observe the real worker throw before settlement.
async function observeCapacityBranch(runtime: PackagedRuntime) {
  const session = await runtime.context.browser()!.newBrowserCDPSession();
  const target = (await session.send('Target.getTargets')).targetInfos.find(entry => entry.url === runtime.worker.url());
  if (!target) throw Error('Capacity worker target missing');
  const { sessionId } = await session.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let sequence = 0;
  const pending = new Map<number, (result: Record<string, unknown>) => void>();
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    const id = ++sequence;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(Error('Worker diagnostic timeout')); }, 5000);
      pending.set(id, value => { clearTimeout(timeout); resolve(value); });
    });
    await session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
    return response;
  };
  type Branch = { requestId: string; candidateCount: number; origin: string };
  let pause: (event: { callFrames: { callFrameId: string }[]; hitBreakpoints: string[] }) => void = () => undefined;
  session.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.id) { pending.get(message.id)?.(message.error ? { exceptionDetails: message.error } : message.result); pending.delete(message.id); }
    else if (message.method === 'Debugger.paused') pause(message.params);
  });
  const source = await readFile(runtime.extension + '/worker.js', 'utf8');
  const capacity = resolveCapacityDebugger(source);
  await send('Debugger.enable');
  const breakpoint = await send('Debugger.setBreakpointByUrl', { url: runtime.worker.url(),
    lineNumber: capacity.lineNumber, columnNumber: capacity.columnNumber });
  let timer: ReturnType<typeof setTimeout>;
  const proof = new Promise<Branch>((resolve, reject) => {
    timer = setTimeout(() => reject(Error('Production capacity throw not observed')), 15_000);
    pause = event => { void (async () => {
      try {
        if (!event.hitBreakpoints.includes(breakpoint.breakpointId as string)) throw Error('Unexpected worker pause');
        const result = await send('Debugger.evaluateOnCallFrame', { callFrameId: event.callFrames[0].callFrameId,
          expression: `({requestId:${capacity.request}.requestId,origin:${capacity.origin},candidateCount:${capacity.candidates}.length})`, returnByValue: true, throwOnSideEffect: true });
        if (result.exceptionDetails) throw Error('Capacity branch locals unavailable');
        await send('Debugger.resume');
        clearTimeout(timer);
        resolve((result.result as { value: Branch }).value);
      } catch (error) {
        await send('Debugger.resume').catch(() => undefined);
        clearTimeout(timer); reject(error as Error);
      }
    })(); };
  });
  void proof.catch(() => undefined);
  return { proof, close: async () => { clearTimeout(timer); await send('Debugger.disable'); await session.detach(); } };
}

test('TEST-ONLY STORAGE FIXTURE: 500-record boundary rejects a real new mock scan nonretryably with no partial receipt, panel or badge', async () => {
  test.setTimeout(90_000);
  const runtime = new PackagedRuntime();
  try {
    const inventory = await runtime.inventory();
    await runtime.start();
    const history = await Promise.all(Array.from({ length: MAX_REVIEW_HISTORY }, (_, index) => finding(runtime.a, `fixture ${index + 1}`, 1)));
    expect(history).toHaveLength(500);
    expect(new Set(history.map(record => record.opaqueFingerprint)).size).toBe(500);
    const seeded = await seedAndRestart(runtime, history);
    const popup = await runtime.popup();
    // Production popup paginates retained history; storage still contains all 500.
    await popup.wait(`document.querySelectorAll('[data-review-id]').length === 100 && document.body.textContent.includes('500 observations need review.') && document.body.textContent.includes('of 500 retained observations')`);
    expect(await runtime.storage()).toEqual(seeded);
    expect((await runtime.permissions()).scripts).toEqual([]);
    await popup.click('[data-action="site-enable"]');
    await popup.wait(`document.querySelector('[data-site-status]').textContent.startsWith('Detection enabled for')`);
    await popup.close();
    expect((await runtime.permissions()).scripts).toHaveLength(1);
    const enabled = await runtime.storage();
    expect(enabled.grantState).toEqual({ version: 1, sites: { [runtime.a]: { enabled: true, generation: 1 } } });
    expect(enabled.reviewHistory).toEqual(history);
    expect(enabled.receipts).toEqual([]);
    const observation = await observeCapacityReply(runtime);
    const branchObservation = await observeCapacityBranch(runtime);
    let reply: Awaited<typeof observation.proof>;
    let branch: Awaited<typeof branchObservation.proof>;
    try {
      const proofs = Promise.all([observation.proof, branchObservation.proof]);
      void proofs.catch(() => undefined);
      await runtime.page.goto(runtime.a + '/checkout/recurring');
      [reply, branch] = await proofs;
      expect(branch).toEqual({ requestId: reply.requestId, origin: runtime.a, candidateCount: 501 });
      expect(reply).toMatchObject({ origin: runtime.a, generation: 1,
        reply: { ok: false, error: 'request-failed' }, pending: true, aborted: false });
      expect(reply.requestId).not.toBe('');
      expect(reply.findings).toHaveLength(1);
      expect(history.some(record => record.opaqueFingerprint === reply.findings[0].opaqueFingerprint)).toBe(false);
    } finally { await Promise.all([observation.close(), branchObservation.close()]); }
    await expect(runtime.page.locator('[data-clearchoice-panel]')).toHaveCount(0);
    expect(await runtime.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.action.getBadgeText({ tabId: tab.id });
    })).toBe('');
    const rejected = await runtime.storage();
    expect(rejected).toEqual(enabled);
    expect(rejected.reviewHistory).toHaveLength(500);
    expect(rejected.receipts).toEqual([]);
    expect(await runtime.inventory()).toEqual(inventory);
    await attachSnapshots('fixture-capacity-full-snapshots', { seeded, enabled, capacityBranch: branch, originalResponse: reply, rejected });
  } finally { await runtime.stop(); }
});
