import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

async function extensionId(context: BrowserContext): Promise<string> {
  const extensions = await context.newPage();
  await extensions.goto('chrome://extensions/');
  const items = extensions.locator('extensions-item');
  await expect(items).toHaveCount(1);
  const id = await items.evaluate((item) => (item as HTMLElement & { data?: { id?: unknown } }).data?.id);
  await extensions.close();
  if (typeof id !== 'string' || id === '') throw new Error('ClearChoice extension ID is unavailable.');
  return id;
}

async function pointerClick(page: Page, locator: ReturnType<Page['getByRole']>): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Popup control is not visible for a pointer click.');
  await page.mouse.click(box.x + (box.width / 2), box.y + (box.height / 2));
}

async function launchScenario(origin: string): Promise<{
  context: BrowserContext;
  checkout: Page;
  popup: Page;
  errors: string[];
  profile: string;
}> {
  const profile = await mkdtemp(resolve(tmpdir(), 'clearchoice-e2e-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const errors: string[] = [];
  const checkout = await context.newPage();
  watchErrors(checkout, errors);
  const id = await extensionId(context);
  const popup = await context.newPage();
  watchErrors(popup, errors);
  await popup.goto(`chrome-extension://${id}/popup/index.html`);
  await checkout.goto(origin);
  return { context, checkout, popup, errors, profile };
}

async function closeScenario(context: BrowserContext, profile: string): Promise<void> {
  await context.close();
  await rm(profile, { force: true, recursive: true });
}

test.beforeAll(async () => {
  const manifest = JSON.parse(await readFile(resolve(extensionPath, 'manifest.json'), 'utf8')) as { version?: unknown };
  expect(manifest.version).toBe('0.2.0');
});

const cases = [
  ['clean', 0, []],
  ['recurring', 1, ['Possible recurring charge']],
  ['addon', 1, ['Preselected paid option']],
  ['mixed', 2, ['Possible recurring charge', 'Preselected paid option']],
] as const;

for (const [fixture, findingCount, expectedTitles] of cases) {
  test(`built extension reports ${findingCount} finding type(s) for ${fixture}`, async () => {
    const { server, origin } = await startFixtureServer();
    const scenario = await launchScenario(`${origin}/checkout/${fixture}`);
    try {
      await scenario.checkout.bringToFront();
      await pointerClick(scenario.popup, scenario.popup.getByRole('button', { name: 'Analyze' }));
      await expect(scenario.popup.getByRole('status')).toHaveText(
        findingCount === 0 ? 'No findings shown on this page.' : `${findingCount} finding${findingCount === 1 ? '' : 's'} shown on this page.`,
      );
      const panel = scenario.checkout.locator('aside[data-clearchoice-panel]');
      await expect(panel).toHaveCount(1);
      await expect(panel.locator('article')).toHaveCount(findingCount);
      for (const title of expectedTitles) await expect(panel).toContainText(title);
      expect(scenario.errors).toEqual([]);
    } finally {
      await closeScenario(scenario.context, scenario.profile);
      await closeServer(server);
    }
  });
}

test('dismiss, reload, and Restore preserve the checkout checkbox and URL', async () => {
  const { server, origin } = await startFixtureServer();
  const url = `${origin}/checkout/mixed`;
  const scenario = await launchScenario(url);
  try {
    await scenario.checkout.bringToFront();
    await pointerClick(scenario.popup, scenario.popup.getByRole('button', { name: 'Analyze' }));
    const panel = scenario.checkout.locator('aside[data-clearchoice-panel]');
    await expect(panel).toHaveCount(1);
    await panel.locator('[data-clearchoice-dismiss]').click();
    await expect(panel).toHaveCount(0);
    await scenario.checkout.reload();
    await expect(panel).toHaveCount(0);
    await expect(scenario.checkout).toHaveURL(url);
    await expect(scenario.checkout.locator('input[type="checkbox"]')).toBeChecked();

    await scenario.checkout.bringToFront();
    await pointerClick(scenario.popup, scenario.popup.getByRole('button', { name: 'Restore' }));
    await expect(scenario.popup.getByRole('status')).toHaveText('Dismissal restored. Analyze again to show findings.');
    await expect(scenario.checkout).toHaveURL(url);
    await expect(scenario.checkout.locator('input[type="checkbox"]')).toBeChecked();
    expect(scenario.errors).toEqual([]);
  } finally {
    await closeScenario(scenario.context, scenario.profile);
    await closeServer(server);
  }
});
