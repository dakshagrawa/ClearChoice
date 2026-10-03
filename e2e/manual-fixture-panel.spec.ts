import { expect, test } from 'playwright/test';
import { writeFile } from 'node:fs/promises';
import { PackagedRuntime } from './packaged-runtime';
import { mockCheckoutHtml } from '../scripts/manual-qa-fixtures.mjs';
import { observeMockPanelGeometry, reviewBrowserLaunchOptions, waitForPanel } from '../scripts/manual-active-tab-qa.mjs';

// Isolated, pre-granted reserved mock regression ONLY. Never human consent QA.
test('actual manual dynamic fixture: native built Analyze renders reachable Dismiss (NOT human consent QA)', async () => {
  test.setTimeout(90_000);
  const runtime = new PackagedRuntime();
  try {
    await runtime.start();
    runtime.title = 'Mock checkout';
    await runtime.context.route(runtime.a + '/checkout/**', async route => {
      const dynamic = new URL(route.request().url()).pathname === '/checkout/dynamic-beta';
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: mockCheckoutHtml(dynamic) });
    });
    await runtime.page.goto(runtime.a + '/checkout/clean');
    let popup = await runtime.popup();
    await popup.click('[data-action="analyze"]');
    await popup.wait(`document.querySelector('main > [role="status"]').textContent === 'No matching signals found on this page.'`);
    await popup.close();
    runtime.page = await runtime.context.newPage();
    await runtime.page.goto(runtime.a + '/checkout/dynamic-beta#checkout');
    for (const width of [1280, 640, 360]) {
      await runtime.page.setViewportSize({ width, height: 720 });
      popup = await runtime.popup();
      await popup.click('[data-action="analyze"]');
      await popup.wait(`document.querySelector('main > [role="status"]').textContent.includes('1')`);
      await popup.close();
      await waitForPanel(runtime.page, 'attached', { timeoutMs: 5000, report: () => {} });
      const evidence = await runtime.page.evaluate(observeMockPanelGeometry);
      console.log(JSON.stringify(evidence));
      await runtime.page.screenshot({path:test.info().outputPath(`manual-dynamic-${width}.png`)});
      expect(evidence.inViewport).toBe(true);
      expect(evidence.pointerHit).toBe(true);
      const dismiss = runtime.page.locator('aside[data-clearchoice-panel] [data-clearchoice-dismiss]');
      await expect(dismiss).toBeVisible();
      if (width === 1280) {
        await runtime.page.locator('body').focus();
        let reached = false;
        for (let n = 0; n < 8; n++) {
          await runtime.page.keyboard.press('Tab');
          reached = await runtime.page.evaluate(() => document.querySelector('aside[data-clearchoice-panel]')?.shadowRoot?.activeElement?.matches('[data-clearchoice-dismiss]') === true);
          if (reached) break;
        }
        expect(reached).toBe(true);
        await expect(dismiss).toBeFocused();
        await runtime.page.keyboard.press('Escape');
        await waitForPanel(runtime.page, 'detached', { timeoutMs: 5000, report: () => {} });
        await expect.poll(async () => (await runtime.storage()).dismissed).toBe(true);
        popup = await runtime.popup();
        await popup.click('[data-action="restore"]');
        await expect.poll(async () => (await runtime.storage()).dismissed).toBe(false);
        await popup.click('[data-action="analyze"]');
        await popup.wait(`document.querySelector('main > [role="status"]').textContent.includes('1')`);
        await popup.close();
        await waitForPanel(runtime.page, 'attached', { timeoutMs: 5000, report: () => {} });
      }
      await dismiss.click();
      await expect(runtime.page.locator('aside[data-clearchoice-panel]')).toHaveCount(0);
      await expect.poll(async () => (await runtime.storage()).dismissed).toBe(true);
      expect((await runtime.storage()).reviewHistory).toHaveLength(1);
      expect((await runtime.storage()).subscriptions ?? []).toHaveLength(0);
      expect(await runtime.worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return chrome.action.getBadgeText({ tabId: tab.id });
      })).toBe('1');
      popup = await runtime.popup();
      await popup.click('[data-action="restore"]');
      await expect.poll(async () => (await runtime.storage()).dismissed).toBe(false);
      await popup.close();
    }
  } finally { await runtime.stop(); }
});

test('physical split-window: built native Analyze keeps Dismiss inside the human runner viewport (NOT human consent QA)', async () => {
  test.setTimeout(60_000);
  const runtime = new PackagedRuntime();
  runtime.viewport = reviewBrowserLaunchOptions(runtime.extension).viewport;
  try {
    await runtime.start();
    runtime.title = 'Mock checkout';
    await runtime.context.route(runtime.a + '/checkout/dynamic-beta', route => route.fulfill({ status: 200, contentType: 'text/html', body: mockCheckoutHtml(true) }));
    await runtime.page.goto(runtime.a + '/checkout/dynamic-beta#checkout');
    const popup = await runtime.popup();
    await popup.click('[data-action="analyze"]');
    await popup.wait(`document.querySelector('main > [role="status"]').textContent.includes('1')`);
    await popup.close();
    const session = await runtime.context.newCDPSession(runtime.page);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId, bounds: { width: 640, height: 600, windowState: 'normal' } });
    const nativeBounds = (await session.send('Browser.getWindowBounds', { windowId })).bounds;
    await expect.poll(() => runtime.page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(nativeBounds.width!);
    const geometry = await runtime.page.evaluate(observeMockPanelGeometry);
    const physical = Buffer.from((await session.send('Page.captureScreenshot', { format: 'png', fromSurface: false })).data, 'base64');
    await writeFile(test.info().outputPath('physical-split-window.png'), physical);
    const devicePixelRatio = await runtime.page.evaluate(() => window.devicePixelRatio);
    const physicalPixels = { width: physical.readUInt32BE(16), height: physical.readUInt32BE(20) };
    // Native screenshot dimensions are device pixels, not CSS pixels. Preserve
    // the physical check at HiDPI too; compositor rounding allows at most 1 CSS px.
    const physicalViewport = { width: physicalPixels.width / devicePixelRatio, height: physicalPixels.height / devicePixelRatio };
    console.log(JSON.stringify({ geometry, nativeBounds, physicalPixels, devicePixelRatio, physicalViewport }));
    expect(Math.abs(geometry.viewport.width - physicalViewport.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.viewport.height - physicalViewport.height)).toBeLessThanOrEqual(1);
    expect(geometry.dismissBounds!.x + geometry.dismissBounds!.width).toBeLessThanOrEqual(physicalViewport.width);
    expect(geometry.dismissBounds!.y + geometry.dismissBounds!.height).toBeLessThanOrEqual(physicalViewport.height);
    await waitForPanel(runtime.page, 'attached', { timeoutMs: 5000, report: () => {} });
    await runtime.page.mouse.click(geometry.dismissBounds!.x + geometry.dismissBounds!.width / 2, geometry.dismissBounds!.y + geometry.dismissBounds!.height / 2);
    await waitForPanel(runtime.page, 'detached', { timeoutMs: 5000, report: () => {} });
    await expect.poll(async () => (await runtime.storage()).dismissed).toBe(true);
    const restore = await runtime.popup();
    await restore.click('[data-action="restore"]');
    await expect.poll(async () => (await runtime.storage()).dismissed).toBe(false);
    await restore.click('[data-action="analyze"]');
    await restore.wait(`document.querySelector('main > [role="status"]').textContent.includes('1')`);
    await restore.close();
    await waitForPanel(runtime.page, 'attached', { timeoutMs: 5000, report: () => {} });
    expect((await runtime.page.evaluate(observeMockPanelGeometry)).reachable).toBe(true);
    expect((await runtime.storage()).reviewHistory).toHaveLength(1);
    expect((await runtime.storage()).subscriptions ?? []).toHaveLength(0);
    await session.detach();
  } finally { await runtime.stop(); }
});
