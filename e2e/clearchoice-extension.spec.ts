import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from 'playwright/test';

const repositoryRoot = resolve(process.cwd());
const contentPayload = resolve(repositoryRoot, 'dist/content.js');

function startFixtureServer(): Promise<{ server: Server; origin: string }> {
  return new Promise((resolveServer, reject) => {
    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }
      const fixtureName = pathname.match(/^\/checkout\/(clean|recurring|addon|mixed)$/)?.[1];
      if (!fixtureName) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('Not found');
        return;
      }
      try {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(await readFile(resolve(repositoryRoot, 'fixtures', `${fixtureName === 'addon' ? 'paid-addon' : fixtureName}-checkout.html`)));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(error instanceof Error ? error.message : 'Unable to load fixture');
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fixture server did not expose a TCP port.'));
        return;
      }
      resolveServer({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

function watchErrors(page: Page, errors: string[]): void {
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
}

async function installContentApi(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const storageKey = '__clearchoice_e2e_dismissed__';
    let listener: ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean) | undefined;
    Object.assign(window, {
      chrome: {
        runtime: { onMessage: { addListener: (candidate: typeof listener) => { listener = candidate; } } },
        storage: {
          local: {
            get: async () => ({ dismissed: window.localStorage.getItem(storageKey) === 'true' }),
            set: async (value: { dismissed?: unknown }) => {
              window.localStorage.setItem(storageKey, value.dismissed === true ? 'true' : 'false');
            },
          },
        },
      },
      __clearchoiceE2eMessage: (message: unknown) => new Promise((resolveMessage, rejectMessage) => {
        if (!listener) {
          rejectMessage(new Error('Content payload did not register a message listener.'));
          return;
        }
        const keepChannel = listener(message, {}, resolveMessage);
        if (keepChannel !== true) rejectMessage(new Error('Content payload did not keep its async message channel open.'));
      }),
    });
  });
}

async function injectContent(page: Page): Promise<void> {
  await page.addScriptTag({ path: contentPayload });
}

async function sendContentMessage(page: Page, type: 'CLEARCHOICE_ANALYZE' | 'CLEARCHOICE_RESTORE'): Promise<unknown> {
  return page.evaluate((messageType) => {
    const target = window as Window & { __clearchoiceE2eMessage?: (message: unknown) => Promise<unknown> };
    if (!target.__clearchoiceE2eMessage) throw new Error('E2E content message bridge is unavailable.');
    return target.__clearchoiceE2eMessage({ type: messageType });
  }, type);
}

async function openFixture(page: Page, origin: string, fixture: string, errors: string[]): Promise<void> {
  watchErrors(page, errors);
  await installContentApi(page);
  await page.goto(`${origin}/checkout/${fixture}`);
}

test.beforeAll(async () => {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'dist/manifest.json'), 'utf8')) as { version?: unknown; content_scripts?: unknown };
  expect(manifest.version).toBe('0.2.0');
  expect(manifest.content_scripts).toBeUndefined();
});

const cases = [
  ['clean', 0, []],
  ['recurring', 1, ['Possible recurring charge']],
  ['addon', 1, ['Preselected paid option']],
  ['mixed', 2, ['Possible recurring charge', 'Preselected paid option']],
] as const;

for (const [fixture, findingCount, expectedTitles] of cases) {
  test(`programmatically injected built payload reports ${findingCount} finding type(s) for ${fixture}`, async ({ page }) => {
    const { server, origin } = await startFixtureServer();
    const errors: string[] = [];
    try {
      await openFixture(page, origin, fixture, errors);
      await injectContent(page);
      await injectContent(page);
      await expect.poll(() => sendContentMessage(page, 'CLEARCHOICE_ANALYZE')).toEqual({ ok: true, status: 'supported', findingCount });
      const panel = page.locator('aside[data-clearchoice-panel]');
      await expect(panel).toHaveCount(1);
      await expect(panel.locator('article')).toHaveCount(findingCount);
      for (const title of expectedTitles) await expect(panel).toContainText(title);
      expect(errors).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });
}

test('programmatic injection preserves checkbox and URL through dismiss, reload, and Restore', async ({ page }) => {
  const { server, origin } = await startFixtureServer();
  const url = `${origin}/checkout/mixed`;
  const errors: string[] = [];
  try {
    await openFixture(page, origin, 'mixed', errors);
    await injectContent(page);
    await expect.poll(() => sendContentMessage(page, 'CLEARCHOICE_ANALYZE')).toEqual({ ok: true, status: 'supported', findingCount: 2 });
    const panel = page.locator('aside[data-clearchoice-panel]');
    await expect(panel).toHaveCount(1);
    await panel.locator('[data-clearchoice-dismiss]').click();
    await expect(panel).toHaveCount(0);
    await page.reload();
    await injectContent(page);
    await expect(panel).toHaveCount(0);
    await expect(page).toHaveURL(url);
    await expect(page.locator('input[type="checkbox"]')).toBeChecked();

    await expect.poll(() => sendContentMessage(page, 'CLEARCHOICE_RESTORE')).toEqual({ ok: true });
    await expect(page).toHaveURL(url);
    await expect(page.locator('input[type="checkbox"]')).toBeChecked();
    expect(errors).toEqual([]);
  } finally {
    await closeServer(server);
  }
});
