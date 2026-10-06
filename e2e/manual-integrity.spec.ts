import { expect, test } from 'playwright/test';
import { PackagedRuntime } from './packaged-runtime';
import { mockCheckoutHtml } from '../scripts/manual-qa-fixtures.mjs';
import { captureIntegrityBaseline, integrityPassed, waitForPanel } from '../scripts/manual-active-tab-qa.mjs';

// Synthetic, isolated exact-candidate regression; never human consent/attestation.
test('site A automatic positive integrity across native popup closure (NOT human consent QA)', async () => {
  test.setTimeout(90_000);
  const runtime = new PackagedRuntime();
  runtime.extension = process.env.CLEARCHOICE_PROBE_EXTENSION ?? runtime.extension;
  runtime.viewport = null;
  try {
    await runtime.start();
    runtime.title = 'Mock checkout';
    await runtime.context.route(runtime.a + '/checkout/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: mockCheckoutHtml(new URL(route.request().url()).pathname === '/checkout/dynamic-beta') }));
    await runtime.page.goto(runtime.a + '/checkout/clean');
    await captureIntegrityBaseline(runtime.page);
    expect((await runtime.permissions()).permissions.origins).toEqual([runtime.a + '/*']);
    expect((await runtime.permissions()).scripts).toEqual([]);
    expect(await runtime.worker.evaluate(async origin => chrome.permissions.contains({origins:[origin+'/*']}), runtime.a)).toBe(true);
    // Replay the preceding manual fixture stages with synthetic native input.
    let prior = await runtime.popup();
    await prior.click('[data-action="analyze"]');
    await prior.wait(`document.querySelector('main > [role="status"]').textContent === 'No matching signals found on this page.'`);
    await prior.close();
    runtime.page = await runtime.context.newPage();
    await runtime.page.goto(runtime.a + '/checkout/dynamic-beta#checkout');
    await captureIntegrityBaseline(runtime.page);
    const analyze = async () => {
      prior = await runtime.popup();
      await prior.click('[data-action="analyze"]');
      await prior.wait(`document.querySelector('main > [role="status"]').textContent.includes('1')`);
      await prior.close();
      await waitForPanel(runtime.page, 'attached', {timeoutMs:10000, report:()=>{}});
      expect(await integrityPassed(runtime.page)).toBe(true);
    };
    const restore = async () => {
      prior = await runtime.popup();
      await prior.click('[data-action="restore"]');
      await expect.poll(async () => (await runtime.storage()).dismissed).toBe(false);
      await prior.close();
    };
    await analyze();
    await runtime.page.locator('aside[data-clearchoice-panel] [data-clearchoice-dismiss]').focus();
    await runtime.page.keyboard.press('Escape');
    await expect(runtime.page.locator('aside[data-clearchoice-panel]')).toHaveCount(0);
    await expect.poll(async () => (await runtime.storage()).dismissed).toBe(true);
    await restore();
    await analyze();
    await runtime.page.locator('aside[data-clearchoice-panel] [data-clearchoice-dismiss]').click();
    await expect.poll(async () => (await runtime.storage()).dismissed).toBe(true);
    await restore();
    await analyze();
    await analyze();
    await runtime.page.locator('#replace-order-summary').click();
    expect(await integrityPassed(runtime.page)).toBe(true);
    await runtime.page.goto(runtime.a + '/checkout/clean');
    await captureIntegrityBaseline(runtime.page);
    const popup = await runtime.popup();
    await popup.click('[data-action="site-enable"]');
    await popup.wait(`document.querySelector('[data-site-status]').textContent.startsWith('Detection enabled')`);
    await popup.close();
    expect(await integrityPassed(runtime.page)).toBe(true);
    await runtime.page.goto(runtime.a + '/checkout/dynamic-beta#checkout');
    await captureIntegrityBaseline(runtime.page);
    const baselinePanelAbsent = await runtime.page.locator('aside[data-clearchoice-panel]').count() === 0;
    await runtime.page.bringToFront();
    await waitForPanel(runtime.page, 'attached', {timeoutMs:10000, report:()=>{}});
    await expect.poll(async () => (await runtime.storage()).reviewHistory.length).toBe(1);
    expect((await runtime.storage()).subscriptions ?? []).toHaveLength(0);
    expect(await runtime.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
      return chrome.action.getBadgeText({tabId:tab.id});
    })).toBe('1');
    expect(await integrityPassed(runtime.page)).toBe(true);
    const predicates = await runtime.page.evaluate(() => (window as unknown as {
      __clearchoiceManualIntegrityBaseline: { predicates: Record<string, boolean> }
    }).__clearchoiceManualIntegrityBaseline.predicates);
    console.log(JSON.stringify({browserVersion:runtime.context.browser()!.version(), baselinePanelAbsent, unchanged:predicates}));
    expect(await integrityPassed(runtime.page)).toBe(true);
    const readback = await runtime.popup();
    await readback.wait(`document.querySelector('[data-site-status]').textContent.startsWith('Detection enabled')`);
    await readback.close();
    await runtime.page.bringToFront();
    expect(await integrityPassed(runtime.page)).toBe(true);
    // The safety gate must still fail for genuine host-control mutation.
    await runtime.page.locator('#replace-order-summary').evaluate((node: HTMLButtonElement) => { node.disabled = true; });
    expect(await integrityPassed(runtime.page)).toBe(false);
  } finally { await runtime.stop(); }
});
