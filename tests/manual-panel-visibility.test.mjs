// @vitest-environment node
/* global document */
import { chromium } from 'playwright';
import { expect, test } from 'vitest';
import { observeMockPanelGeometry, waitForPanel } from '../scripts/manual-active-tab-qa.mjs';

// Synthetic DOM regression for the passive runner, NOT human gesture evidence.
async function syntheticPanel(page, mode) {
  await page.route('https://checkout-a.test:123/checkout/dynamic-beta', route => route.fulfill({ body: '<!doctype html><title>Mock</title>' }));
  await page.goto('https://checkout-a.test:123/checkout/dynamic-beta');
  await page.evaluate((mode) => {
    if (mode === 'absent') return;
    const panel = document.createElement('aside');
    panel.dataset.clearchoicePanel = '';
    // Constant synthetic markup only; no page text or untrusted HTML is inserted.
    panel.attachShadow({ mode: 'open' }).innerHTML = '<style>:host{all:initial}.clearchoice-panel{position:fixed;right:16px;bottom:16px;z-index:2;background:white}button{width:80px;height:44px}</style><section class="clearchoice-panel"><button data-clearchoice-dismiss>Dismiss</button></section>';
    document.documentElement.append(panel);
    const dismiss = panel.shadowRoot.querySelector('button');
    if (mode === 'hidden') dismiss.style.display = 'none';
    if (mode === 'offscreen') panel.shadowRoot.querySelector('section').style.right = '-1000px';
    if (mode === 'transparent') panel.style.opacity = '0';
    if (mode === 'disabled') dismiss.disabled = true;
    if (mode === 'missing') dismiss.remove();
    if (mode === 'duplicate') {
      const duplicate = document.createElement('aside');
      duplicate.dataset.clearchoicePanel = '';
      document.documentElement.append(duplicate);
    }
    if (mode === 'occluded') {
      const cover = document.createElement('div');
      cover.style.cssText = 'position:fixed;inset:0;z-index:3;background:white';
      document.documentElement.append(cover);
    }
  }, mode);
}

test('attached but hidden Dismiss cannot pass the manual panel checkpoint', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await syntheticPanel(page, 'hidden');
    const reports = [];
    await expect(waitForPanel(page, 'attached', { timeoutMs: 50, report: value => reports.push(value) })).rejects.toThrow('Dismiss is not visibly reachable');
    expect(reports).toHaveLength(2);
    expect(reports.every(value => !value.reachable)).toBe(true);
  } finally { await browser.close(); }
});

test.each(['absent', 'offscreen', 'transparent', 'disabled', 'missing', 'duplicate', 'occluded'])('passive panel gate rejects %s without leaking mock content', async mode => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await syntheticPanel(page, mode);
    const reports = [];
    await expect(waitForPanel(page, 'attached', { timeoutMs: 50, report: value => { reports.push(value); } })).rejects.toThrow('Dismiss is not visibly reachable');
    const geometry = reports.at(-1);
    expect(geometry.reachable).toBe(false);
    expect(Object.keys(geometry).sort()).toEqual(['uniquePanel', 'dismissPresent', 'visible', 'enabled', 'inViewport', 'pointerHit', 'reachable', 'viewport', 'hostBounds', 'panelBounds', 'dismissBounds'].sort());
    const encoded = JSON.stringify(geometry);
    for (const forbidden of ['Mock', 'Dismiss', 'checkout-a', 'textContent', 'reviewHistory']) expect(encoded).not.toContain(forbidden);
  } finally { await browser.close(); }
});

test('passive panel gate waits for visibility without activating or focusing Dismiss; detached remains exact', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await syntheticPanel(page, 'hidden');
    let passed = false;
    const pending = waitForPanel(page, 'attached', { timeoutMs: 2000, report: () => {} }).then(() => { passed = true; });
    await page.waitForTimeout(100);
    expect(passed).toBe(false);
    await page.evaluate(() => { document.querySelector('aside').shadowRoot.querySelector('button').style.display = ''; });
    await pending;
    const geometry = await page.evaluate(observeMockPanelGeometry);
    expect(geometry.hostBounds.width).toBe(0);
    expect(geometry.hostBounds.height).toBe(0);
    expect(geometry.reachable).toBe(true);
    expect(await page.evaluate(() => document.activeElement.tagName)).toBe('BODY');
    let detached = false;
    const removal = waitForPanel(page, 'detached', { timeoutMs: 2000, report: () => { throw Error('no detached report'); } }).then(() => { detached = true; });
    await page.waitForTimeout(100);
    expect(detached).toBe(false);
    await page.evaluate(() => document.querySelector('aside').remove());
    await removal;
  } finally { await browser.close(); }
});

test('panel diagnostics reject non-mock origins before reading the DOM', async () => {
  let read = false;
  await expect(waitForPanel({ url: () => 'https://example.com/checkout', evaluate: () => { read = true; }, locator: () => { read = true; } }, 'attached')).rejects.toThrow('fixture origin');
  expect(read).toBe(false);
});
