import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext } from 'playwright/test';

const repositoryRoot = resolve(process.cwd());
const extensionPath = resolve(repositoryRoot, 'dist');

function startFixtureServer(): Promise<{ server: Server; origin: string }> {
  return new Promise((resolveServer, reject) => {
    const server = createServer(async (request, response) => {
      const fixtureName = request.url === '/checkout/dynamic-beta' ? 'beta-dynamic-checkout.html' : 'clean-checkout.html';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(await readFile(resolve(repositoryRoot, `fixtures/${fixtureName}`)));
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

async function closeExtension(context: BrowserContext, userDataDir: string): Promise<void> {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
}

test('packaged direct-popup automation does not claim an activeTab grant', async () => {
  const { server, origin } = await startFixtureServer();
  const userDataDir = await mkdtemp(resolve(tmpdir(), 'clearchoice-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const id = await extensionId(context);
    const fixture = await context.newPage();
    await fixture.goto(origin);
    await fixture.evaluate(() => {
      window.__clearchoiceKeyEvents = [];
      addEventListener('keydown', (event) => window.__clearchoiceKeyEvents.push(event.key), true);
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup/index.html`);

    await fixture.bringToFront();
    await fixture.keyboard.press('Control+Shift+Y');
    await expect.poll(() => fixture.evaluate(() => window.__clearchoiceKeyEvents.includes('Y'))).toBe(true);
    await popup.getByRole('button', { name: 'Analyze' }).click();

    await expect(fixture.locator('aside[data-clearchoice-panel]')).toHaveCount(0);
    await expect(popup.getByRole('status')).toHaveText('ClearChoice could not analyze this tab. Reload it and try again.');
  } finally {
    await closeExtension(context, userDataDir);
    await closeServer(server);
  }
});


declare global {
  interface Window {
    __clearchoiceKeyEvents: string[];
  }
}
