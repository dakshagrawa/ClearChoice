import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from 'playwright/test';

const checkoutFixture = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Local ClearChoice checkout fixture</title></head>
  <body>
    <main>
      <h1>Mock checkout</h1>
      <section id="membership">Membership renews automatically for $12 per month.</section>
      <label><input type="checkbox" checked> Add purchase protection for $5</label>
    </main>
  </body>
</html>`;

function startFixtureServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolveServer, reject) => {
    const server = createServer((request, response) => {
      if (request.url === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.url !== '/checkout') {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('Not found');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(checkoutFixture);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fixture server did not expose a TCP port.'));
        return;
      }
      resolveServer({ server, url: `http://127.0.0.1:${address.port}/checkout` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
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

function watchErrors(page: Page, errors: string[]): void {
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
}

test('built extension analyzes a local checkout, dismisses its panel, and preserves dismissal after reload', async () => {
  const { server, url } = await startFixtureServer();
  const profile = await mkdtemp(resolve(tmpdir(), 'clearchoice-e2e-'));
  const extensionPath = resolve(process.cwd(), 'dist');
  const errors: string[] = [];
  let context: BrowserContext | undefined;

  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    const checkout = await context.newPage();
    watchErrors(checkout, errors);
    await checkout.goto(url);

    const id = await extensionId(context);
    const popup = await context.newPage();
    watchErrors(popup, errors);
    await popup.goto(`chrome-extension://${id}/popup/index.html`);
    await checkout.bringToFront();
    await popup.getByRole('button', { name: 'Analyze' }).click();

    await expect(popup.getByRole('status')).toHaveText('2 findings shown on this page.');
    const panel = checkout.locator('aside[data-clearchoice-panel]');
    await expect(panel).toHaveCount(1);
    await expect(panel).toContainText('Possible recurring charge');
    await expect(panel).toContainText('Membership renews automatically for $12 per month.');
    await expect(panel).toContainText('Preselected paid option');
    await expect(panel).toContainText('Add purchase protection for $5');

    await panel.getByRole('button', { name: 'Dismiss ClearChoice findings' }).click();
    await expect(panel).toHaveCount(0);

    await checkout.reload();
    await expect(checkout.locator('aside[data-clearchoice-panel]')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await closeServer(server);
    await rm(profile, { force: true, recursive: true });
  }
});
