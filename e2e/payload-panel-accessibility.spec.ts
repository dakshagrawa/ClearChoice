import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import { expect, test, type Page } from 'playwright/test';

const repositoryRoot = resolve(process.cwd());
let payloadDir = '';

async function installMinimalContentBridge(page: Page): Promise<void> {
  await page.evaluate(() => {
    let dismissed = false;
    window.__clearchoiceContentListener = undefined;
    Object.assign(window, {
      chrome: {
        runtime: {
          onMessage: {
            addListener(listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | undefined) {
              window.__clearchoiceContentListener = listener;
            },
          },
        },
        storage: {
          local: {
            async get() { return { dismissed }; },
            async set(value: { dismissed?: boolean }) { dismissed = value.dismissed === true; },
          },
        },
      },
    });
  });
}

async function analyze(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const listener = window.__clearchoiceContentListener;
    if (!listener) throw new Error('Content payload did not register its message listener.');
    await new Promise<void>((resolveResponse) => {
      const keepChannelOpen = listener({ type: 'CLEARCHOICE_ANALYZE' }, {}, () => resolveResponse());
      if (keepChannelOpen !== true) throw new Error('Content payload did not keep its asynchronous response channel open.');
    });
  });
}

test.beforeAll(async () => {
  payloadDir = await mkdtemp(resolve(repositoryRoot, '.payload-a11y-'));
  process.env.CLEARCHOICE_CONTENT_BUILD = '1';
  try {
    await build({
      configFile: resolve(repositoryRoot, 'vite.config.ts'),
      build: { emptyOutDir: true, outDir: payloadDir },
    });
  } finally {
    delete process.env.CLEARCHOICE_CONTENT_BUILD;
  }
});

test.afterAll(async () => {
  await rm(payloadDir, { recursive: true, force: true });
});

test('browser payload-level accessibility injects only the content payload in light and dark fixture contexts', async ({ browser }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    await page.setContent(`
      <main>
        <h1>Checkout</h1>
        <aside>Order summary — Subtotal: $24</aside>
        <button>Place order</button>
        <label><input type="checkbox" checked> Add protection for $5</label>
        <aside data-unrelated-panel>Host checkout sidebar</aside>
      </main>
    `);
    await installMinimalContentBridge(page);
    await page.addScriptTag({ path: resolve(payloadDir, 'content.js') });
    await analyze(page);

    const dismiss = page.locator('aside[data-clearchoice-panel]').locator('button', { hasText: 'Dismiss' });
    await expect(dismiss).toBeVisible();
    const box = await dismiss.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);

    await page.locator('body').focus();
    let dismissReached = false;
    for (let tabCount = 0; tabCount < 4; tabCount += 1) {
      await page.keyboard.press('Tab');
      dismissReached = await page.evaluate(() => {
        const panel = document.querySelector('aside[data-clearchoice-panel]');
        return panel?.shadowRoot?.activeElement?.matches('[data-clearchoice-dismiss]') ?? false;
      });
      if (dismissReached) break;
    }
    expect(dismissReached).toBe(true);
    const focusIndicator = await page.evaluate(() => {
      const panel = document.querySelector('aside[data-clearchoice-panel]');
      const dismiss = panel?.shadowRoot?.querySelector<HTMLButtonElement>('[data-clearchoice-dismiss]');
      if (!dismiss || !dismiss.matches(':focus-visible')) return null;

      const style = getComputedStyle(dismiss);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        outlineOffset: Number.parseFloat(style.outlineOffset),
      };
    });
    expect(focusIndicator).not.toBeNull();
    expect(focusIndicator?.outlineStyle).toBe('solid');
    expect(focusIndicator?.outlineWidth).toBeGreaterThanOrEqual(3);
    expect(focusIndicator?.outlineOffset).toBeGreaterThanOrEqual(2);

    await page.keyboard.press('Escape');
    await expect(page.locator('aside[data-clearchoice-panel]')).toHaveCount(0);
    await expect(page.locator('aside[data-unrelated-panel]')).toHaveCount(1);
    await context.close();
  }
});

declare global {
  interface Window {
    __clearchoiceContentListener?: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | undefined;
  }
}
