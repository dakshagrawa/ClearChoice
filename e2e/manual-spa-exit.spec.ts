import { expect, test } from 'playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PackagedRuntime } from './packaged-runtime';
import { mockCheckoutHtml } from '../scripts/manual-qa-fixtures.mjs';

// Exact human fixture; synthetic pregrant, NOT consent/QA attestation.
// Set CLEARCHOICE_SPA_ARCHIVE to reproduce against extracted candidate ZIP bytes.
for (const manualReplacement of [false, true]) test(`built exact human identical/repeat/reload/SPA exit clears panel and badge (manual replacement: ${manualReplacement})`, async () => {
  test.setTimeout(90_000);
  const extracted = await mkdtemp(join(tmpdir(), 'clearchoice-spa-zip-'));
  const runtime = new PackagedRuntime();
  try {
    if (process.env.CLEARCHOICE_SPA_ARCHIVE) {
      execFileSync('unzip', ['-q', process.env.CLEARCHOICE_SPA_ARCHIVE, '-d', extracted]);
      runtime.extension = extracted;
    }
    await runtime.start();
    runtime.title = 'Mock checkout';
    await runtime.context.route(runtime.a + '/checkout/**', route => route.fulfill({ contentType: 'text/html', body: mockCheckoutHtml(new URL(route.request().url()).pathname.endsWith('/identical') ? 'identical' : true) }));
    await runtime.page.goto(runtime.a + '/checkout/dynamic-beta');
    const popup = await runtime.popup();
    await popup.click('[data-action="analyze"]');
    await popup.wait(`document.querySelector('main > [role="status"]').textContent.includes('1')`);
    await popup.click('[data-action="site-enable"]');
    await popup.wait(`document.querySelector('[data-site-status]').textContent.startsWith('Detection enabled for')`);
    await popup.close();
    await runtime.page.goto(runtime.a + '/checkout/identical');
    const panel = runtime.page.locator('aside[data-clearchoice-panel]');
    await expect(panel.locator('article')).toHaveCount(2);
    const ids = (await runtime.storage()).reviewHistory.map((item: { id: string }) => item.id).sort();
    await runtime.page.locator('#replace-order-summary').click();
    await runtime.page.locator('#replace-order-summary').click();
    await runtime.page.reload();
    await expect(panel.locator('article')).toHaveCount(2);
    const badge = () => runtime.worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return chrome.action.getBadgeText({ tabId: tab.id }); });
    await expect.poll(badge).toBe('2');
    // An ordinary native Analyze can replace the automatic panel while its
    // signature stays deduplicated. Close the action before the real page click.
    if (manualReplacement) {
      const manual = await runtime.popup();
      await manual.click('[data-action="analyze"]');
      await manual.wait(`document.querySelector('main > [role="status"]').textContent.includes('2')`);
      await manual.close();
    }
    await runtime.page.locator('#spa-exit').click();
    await expect(runtime.page.locator('#information-view')).toBeVisible();
    await expect(runtime.page.locator('#checkout-view')).toBeHidden();
    await runtime.page.waitForTimeout(500);
    console.log(JSON.stringify({ checkpoint: 'exact-SPA-exit', panelCount: await panel.count(), articles: await panel.locator('article').count(), badge: await badge(), historyCount: (await runtime.storage()).reviewHistory.length }));
    await expect(panel).toHaveCount(0);
    await expect.poll(badge).toBe('');
    expect((await runtime.storage()).reviewHistory.map((item: { id: string }) => item.id).sort()).toEqual(ids);
    await runtime.page.locator('#spa-return').click();
    await expect(panel.locator('article')).toHaveCount(2);
    await expect.poll(badge).toBe('2');
    expect((await runtime.storage()).reviewHistory.map((item: { id: string }) => item.id).sort()).toEqual(ids);
    expect((await runtime.storage()).subscriptions ?? []).toEqual([]);
    console.log(JSON.stringify({ checkpoint: 'exact-SPA-return', manualReplacement, panelCount: await panel.count(), articles: await panel.locator('article').count(), badge: await badge(), historyIdsUnchanged: (await runtime.storage()).reviewHistory.map((item: { id: string }) => item.id).sort().every((id: string, index: number) => id === ids[index]), subscriptions: 0 }));
  } finally { await runtime.stop(); await rm(extracted, { recursive: true, force: true }); }
});
