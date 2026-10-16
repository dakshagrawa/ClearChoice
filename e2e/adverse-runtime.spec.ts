import { resolveContentReplyDebugger } from './content-reply-debugger';
import ts from 'typescript';
import { expect, test, type CDPSession } from 'playwright/test';
import { readFile } from 'node:fs/promises';
import { PackagedRuntime } from './packaged-runtime';

// Only debugger scheduling and read-only lexical observations. No Chrome API,
// authorization, message, response, application registry or receipt replacements.
async function contentProbe(runtime: PackagedRuntime) {
  const session = await runtime.context.newCDPSession(runtime.page);
  const source = await readFile(runtime.extension + '/content.js', 'utf8');
  const reply = resolveContentReplyDebugger(source);
  await session.send('Debugger.enable');
  const events: Parameters<Parameters<CDPSession['on']>[1]>[0][] = [];
  session.on('Debugger.paused', event => events.push(event));
  const breakpoint = async (statement: string | number, condition: string) => {
    const offset = typeof statement === 'number' ? statement : source.indexOf(statement);
    if (offset < 0 || (typeof statement === 'string' && source.indexOf(statement, offset + 1) !== -1)) throw Error('Packaged diagnostic statement changed: ' + statement);
    const lines = source.slice(0, offset).split('\n');
    return session.send('Debugger.setBreakpointByUrl', {
      url: `chrome-extension://${runtime.extensionId}/content.js`,
      lineNumber: lines.length - 1, columnNumber: lines.at(-1)!.length, condition,
    });
  };
  const next = async (id: string, expression: string) => {
    await expect.poll(() => events.length, { timeout: 15_000, message: 'Real packaged debugger observation required' }).toBeGreaterThan(0);
    const event = events.shift()!;
    expect(event.hitBreakpoints).toContain(id);
    const result = await session.send('Debugger.evaluateOnCallFrame', {
      callFrameId: event.callFrames[0].callFrameId, expression, returnByValue: true, throwOnSideEffect: true,
    });
    if (result.exceptionDetails) throw Error('Packaged diagnostic locals unavailable: ' + JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const protocolBranch = (messageType: string) => {
    // Resolve the minifier's alias from the real bundled protocol literal.
    // Never substitute a guessed name or silently skip the adverse checkpoint.
    const aliases = [...source.matchAll(/(?:const|,)([A-Za-z_$][\w$]*)="(CLEARCHOICE_[A-Z_]+)"/g)]
      .filter(match => match[2] === messageType);
    if (aliases.length !== 1) throw Error('Packaged protocol constant unavailable: ' + messageType);
    const file = ts.createSourceFile('content.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const branches: ts.IfStatement[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIfStatement(node) && ts.isBinaryExpression(node.expression)
        && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        && ts.isPropertyAccessExpression(node.expression.left) && node.expression.left.name.text === 'type'
        && ts.isIdentifier(node.expression.left.expression)
        && node.expression.right.getText(file) === aliases[0][1]) branches.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (branches.length !== 1) throw Error('Packaged challenge branch missing or ambiguous');
    const branch = branches[0];
    const message = ((branch.expression as ts.BinaryExpression).left as ts.PropertyAccessExpression).expression.getText(file);
    return { statement: source.slice(branch.getStart(file), branch.thenStatement.getStart(file)), message };
  };
  return { session, breakpoint, protocolBranch, next, reply, close: async () => {
    await session.send('Debugger.disable');
    await session.detach();
  } };
}
async function badge(runtime: PackagedRuntime) {
  return runtime.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.action.getBadgeText({ tabId: tab.id });
  });
}
async function enable(runtime: PackagedRuntime) {
  const popup = await runtime.popup();
  await popup.click('[data-action="site-enable"]');
  await popup.wait(`document.querySelector('[data-site-status]').textContent.startsWith('Detection enabled for')`);
  return popup;
}
async function positiveMutation(runtime: PackagedRuntime) {
  await runtime.page.evaluate(() => {
    document.querySelector('main > p')!.textContent = 'Your subscription renews automatically at $12.00 per month until canceled.';
  });
}

// Installation-only host pregrant in disposable Chrome is NOT human consent QA.
test('packaged in-flight real challenge is vetoed by native-popup revoke before history/receipt commit (NOT consent QA)', async () => {
  test.setTimeout(60_000);
  const runtime = new PackagedRuntime();
  try {
    const inventory = await runtime.inventory();
    await runtime.start();
    const popup = await enable(runtime);
    const enabled = await runtime.storage();
    const probe = await contentProbe(runtime);
    try {
      const protocol = probe.protocolBranch('CLEARCHOICE_FINDINGS_CHALLENGE');
      const challenge = await probe.breakpoint(protocol.statement, `${probe.reply.pending}.has(${protocol.message}.requestId)`);
      const settlement = await probe.breakpoint(probe.reply.offset, probe.reply.condition);
      await positiveMutation(runtime);
      const inFlight = await probe.next(challenge.breakpointId,
        `({requestId:${protocol.message}.requestId,pending:${probe.reply.pending}.has(${protocol.message}.requestId),origin:location.origin,nonce:${protocol.message}.nonce})`);
      expect(inFlight).toMatchObject({ pending: true, origin: runtime.a, requestId: expect.any(String), nonce: expect.any(String) });
      expect(inFlight.requestId).not.toBe('');
      expect((await runtime.storage()).reviewHistory ?? []).toEqual([]);
      await popup.click('[data-action="site-disable"]');
      // disable() deliberately awaits content cleanup. While content is paused,
      // verify the actual worker persisted generation 2 and unregistered scripts;
      // resume to let cleanup and the popup's original response complete.
      await expect.poll(async () => (await runtime.storage()).grantState).toEqual({
        version: 1, sites: { [runtime.a]: { enabled: false, generation: 2 } },
      });
      await expect.poll(async () => (await runtime.permissions()).scripts).toEqual([]);
      await probe.session.send('Debugger.removeBreakpoint', { breakpointId: challenge.breakpointId });
      await probe.session.send('Debugger.resume');
      const reply = await probe.next(settlement.breakpointId, probe.reply.expression);
      expect(reply).toMatchObject({ requestId: inFlight.requestId, generation: 1, findings: 1,
        reply: { ok: false, error: 'request-failed' } });
      await probe.session.send('Debugger.removeBreakpoint', { breakpointId: settlement.breakpointId });
      await probe.session.send('Debugger.resume');
      await popup.wait(`document.querySelector('[data-site-status]').textContent.startsWith('Detection disabled and browser site access removed')`);
      const revoked = await runtime.storage();
      expect(revoked.reviewHistory ?? []).toEqual(enabled.reviewHistory ?? []);
      expect(revoked.receipts ?? []).toEqual(enabled.receipts ?? []);
      expect(revoked.subscriptions ?? []).toEqual(enabled.subscriptions ?? []);
      expect((await runtime.permissions()).permissions.origins).toEqual([]);
      expect((await runtime.permissions()).scripts).toEqual([]);
      await expect(runtime.page.locator('[data-clearchoice-panel]')).toHaveCount(0);
      expect(await badge(runtime)).toBe('');
      await popup.close();
      await runtime.page.waitForTimeout(300);
      expect((await runtime.storage()).reviewHistory ?? []).toEqual([]);
      expect((await runtime.storage()).receipts ?? []).toEqual([]);
      expect(await runtime.inventory()).toEqual(inventory);
      await test.info().attach('real-in-flight-revocation', { body: JSON.stringify({
        scope: 'Installation pregrant, real native popup revoke; NOT human consent QA',
        inFlight, originalResponse: reply, revokedGrant: revoked.grantState,
        api: await runtime.permissions(), historyCount: 0, receiptCount: 0, panelCount: 0, badge: '',
      }), contentType: 'application/json' });
    } finally { await probe.close(); }
  } finally { await runtime.stop(); }
});

test('packaged real Chrome storage quota rejects atomic finding/receipt write and automatic retry succeeds after filler removal (NOT consent QA)', async () => {
  test.setTimeout(60_000);
  const runtime = new PackagedRuntime();
  try {
    const inventory = await runtime.inventory();
    await runtime.start();
    const popup = await enable(runtime);
    await popup.close();
    await runtime.page.waitForTimeout(200);
    const baseline = await runtime.storage();
    const api = await runtime.permissions();
    // This unrelated test-only key consumes genuine Chrome storage quota. No
    // application records are seeded and storage.local.set is never overridden.
    const quota = await runtime.worker.evaluate(async () => {
      const key = '__clearchoice_test_only_quota_filler__';
      const limit = chrome.storage.local.QUOTA_BYTES;
      const used = await chrome.storage.local.getBytesInUse(null);
      const size = limit - used - key.length - 2;
      await chrome.storage.local.set({ [key]: 'x'.repeat(size) });
      const filled = await chrome.storage.local.getBytesInUse(null);
      let error = '';
      try { await chrome.storage.local.set({ [key]: 'x'.repeat(size + 1) }); }
      catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
      return { key, limit, used, filled, error };
    });
    expect(quota.filled).toBe(quota.limit);
    expect(quota.error).toMatch(/QUOTA_BYTES|quota/i);
    const probe = await contentProbe(runtime);
    try {
      const settlement = await probe.breakpoint(probe.reply.offset, probe.reply.condition);
      await positiveMutation(runtime);
      const failed = await probe.next(settlement.breakpointId, probe.reply.expression);
      expect(failed).toMatchObject({ generation: 1, findings: 1, pending: true, aborted: false,
        reply: { ok: false, error: 'retryable-failure' } });
      const rejected = await runtime.worker.evaluate(async (key) => {
        const state = await chrome.storage.local.get(null);
        delete state[key];
        return state;
      }, quota.key);
      expect(rejected).toEqual(baseline);
      // The original content promise has not processed its retryable response.
      // Free capacity now, then let its unmodified one-shot retry run naturally.
      await runtime.worker.evaluate(async key => { await chrome.storage.local.remove(key); }, quota.key);
      expect(await runtime.storage()).toEqual(baseline);
      // DOM-domain read works while the renderer's JavaScript is suspended.
      const document = await probe.session.send('DOM.getDocument');
      const panels = await probe.session.send('DOM.querySelectorAll', {
        nodeId: document.root.nodeId, selector: '[data-clearchoice-panel]',
      });
      expect(panels.nodeIds).toEqual([]);
      expect(await badge(runtime)).toBe('');
      await probe.session.send('Debugger.resume');
      const retried = await probe.next(settlement.breakpointId, probe.reply.expression);
      expect(retried).toMatchObject({ generation: 1, findings: 1, pending: true, aborted: false,
        reply: { ok: true, findingCount: 1 } });
      expect(retried.requestId).not.toBe(failed.requestId);
      await probe.session.send('Debugger.removeBreakpoint', { breakpointId: settlement.breakpointId });
      await probe.session.send('Debugger.resume');
      await expect(runtime.page.locator('[data-clearchoice-panel]')).toHaveCount(1);
      await expect.poll(() => badge(runtime)).toBe('1');
      const recovered = await runtime.storage();
      expect(recovered.reviewHistory).toHaveLength(1);
      expect(recovered.receipts).toHaveLength(1);
      expect((recovered.receipts as { requestId: string }[])[0].requestId).toBe(retried.requestId);
      expect(recovered.subscriptions).toEqual(baseline.subscriptions);
      expect(recovered.grantState).toEqual(baseline.grantState);
      expect(await runtime.permissions()).toEqual(api);
      expect(await runtime.inventory()).toEqual(inventory);
      await test.info().attach('real-quota-and-automatic-retry', { body: JSON.stringify({
        scope: 'Unrelated disposable-profile filler; genuine quota, no API stubs; NOT consent QA',
        quota, originalFailure: failed, originalRetry: retried, rejectedStateUnchanged: true,
        recoveredHistoryCount: 1, recoveredReceiptCount: 1, recoveredPanelCount: 1, recoveredBadge: '1',
      }), contentType: 'application/json' });
    } finally { await probe.close(); }
  } finally { await runtime.stop(); }
});
