import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from 'playwright/test';

const repositoryRoot = resolve(process.cwd());
const extensionPath = resolve(repositoryRoot, 'dist');

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
      if (!address || typeof address === 'string') return reject(new Error('Fixture server did not expose a TCP port.'));
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

async function extensionId(context: BrowserContext): Promise<string> {
  const extensionsPage = await context.newPage();
  await extensionsPage.goto('chrome://extensions/');
  const id = await extensionsPage.locator('extensions-manager').evaluate((manager) => {
    const list = manager.shadowRoot?.querySelector('extensions-item-list');
    return list?.shadowRoot?.querySelector('extensions-item')?.id;
  });
  await extensionsPage.close();
  if (!id || !/^[a-p]{32}$/.test(id)) throw new Error('Could not discover the loaded extension ID from chrome://extensions.');
  return id;
}

async function launchExtension(): Promise<{ context: BrowserContext; userDataDir: string; popup: Page }> {
  const userDataDir = await mkdtemp(resolve(tmpdir(), 'clearchoice-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const id = await extensionId(context);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup/index.html`);
  return { context, userDataDir, popup };
}

async function closeExtension(context: BrowserContext, userDataDir: string): Promise<void> {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
}

async function analyzeFixture(popup: Page, fixture: Page): Promise<void> {
  await fixture.bringToFront();
  await fixture.keyboard.press('Control+Shift+Y');
  await popup.getByRole('button', { name: 'Analyze' }).click();
}

const cases = [
  ['clean', 0, []],
  ['recurring', 1, ['Possible recurring charge']],
  ['addon', 1, ['Preselected paid option']],
  ['mixed', 2, ['Possible recurring charge', 'Preselected paid option']],
] as const;

for (const [fixture, findingCount, expectedTitles] of cases) {
  test(`packaged popup injects and analyzes ${fixture} through the MV3 scripting API`, async () => {
    const { server, origin } = await startFixtureServer();
    const { context, userDataDir, popup } = await launchExtension();
    const fixturePage = await context.newPage();
    const errors: string[] = [];
    watchErrors(popup, errors);
    watchErrors(fixturePage, errors);
    try {
      await fixturePage.goto(`${origin}/checkout/${fixture}`);
      await analyzeFixture(popup, fixturePage);
      const panel = fixturePage.locator('aside[data-clearchoice-panel]');
      await expect(panel).toHaveCount(1);
      await expect(panel.locator('article')).toHaveCount(findingCount);
      for (const title of expectedTitles) await expect(panel).toContainText(title);
      await expect(popup.getByRole('status')).toHaveText(findingCount === 1 ? '1 finding shown on this page.' : `${findingCount} findings shown on this page.`);
      expect(errors).toEqual([]);
    } finally {
      await closeExtension(context, userDataDir);
      await closeServer(server);
    }
  });
}

test('packaged popup preserves checkbox and URL through dismiss, reload, and Restore', async () => {
  const { server, origin } = await startFixtureServer();
  const { context, userDataDir, popup } = await launchExtension();
  const fixturePage = await context.newPage();
  const url = `${origin}/checkout/mixed`;
  const errors: string[] = [];
  watchErrors(popup, errors);
  watchErrors(fixturePage, errors);
  try {
    await fixturePage.goto(url);
    await analyzeFixture(popup, fixturePage);
    const panel = fixturePage.locator('aside[data-clearchoice-panel]');
    await expect(panel).toHaveCount(1);
    await panel.locator('[data-clearchoice-dismiss]').click();
    await expect(panel).toHaveCount(0);
    await fixturePage.reload();
    await expect(fixturePage).toHaveURL(url);
    await expect(fixturePage.locator('input[type="checkbox"]')).toBeChecked();

    await fixturePage.bringToFront();
    await popup.getByRole('button', { name: 'Restore' }).click();
    await expect(popup.getByRole('status')).toHaveText('Dismissal restored. Analyze again to show findings.');
    await expect(fixturePage).toHaveURL(url);
    await expect(fixturePage.locator('input[type="checkbox"]')).toBeChecked();
    expect(errors).toEqual([]);
  } finally {
    await closeExtension(context, userDataDir);
    await closeServer(server);
  }
});
