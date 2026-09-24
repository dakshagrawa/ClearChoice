import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext } from 'playwright/test';
import AxeBuilder from '@axe-core/playwright';

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

async function extensionIds(context: BrowserContext): Promise<string[]> {
  const extensionsPage = await context.newPage();
  await extensionsPage.goto('chrome://extensions/');
  const ids = await extensionsPage.locator('extensions-manager').evaluate((manager) => {
    const list = manager.shadowRoot?.querySelector('extensions-item-list');
    return [...(list?.shadowRoot?.querySelectorAll('extensions-item') ?? [])]
      .map((item) => item.id)
      .filter((id) => /^[a-p]{32}$/.test(id));
  });
  await extensionsPage.close();
  return ids;
}

async function extensionId(context: BrowserContext): Promise<string> {
  const [id] = await extensionIds(context);
  if (!id || !/^[a-p]{32}$/.test(id)) throw new Error('Could not discover the loaded extension ID from chrome://extensions.');
  return id;
}

async function closeExtension(context: BrowserContext, userDataDir: string): Promise<void> {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
}

test('built extension path loads in Chromium with the Chrome numeric beta manifest version', async () => {
  const userDataDir = await mkdtemp(resolve(tmpdir(), 'clearchoice-version-load-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const id = await extensionId(context);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup/index.html`);
    await expect(popup.getByRole('button', { name: 'Analyze' })).toBeVisible();
  } finally {
    await closeExtension(context, userDataDir);
  }
});

test('Chromium rejects a built extension whose manifest version is a prerelease string', async () => {
  const invalidExtensionPath = await mkdtemp(resolve(tmpdir(), 'clearchoice-invalid-version-extension-'));
  const userDataDir = await mkdtemp(resolve(tmpdir(), 'clearchoice-invalid-version-profile-'));
  await cp(extensionPath, invalidExtensionPath, { recursive: true });
  const manifestPath = resolve(invalidExtensionPath, 'manifest.json');
  const originalManifest = await readFile(manifestPath);
  const originalManifestText = originalManifest.toString('utf8');
  const numericVersion = /("version"\s*:\s*")0\.3\.0(")/g;
  const numericVersionMatches = [...originalManifestText.matchAll(numericVersion)];
  expect(numericVersionMatches).toHaveLength(1);
  const [numericVersionMatch] = numericVersionMatches;
  const versionStart = numericVersionMatch.index! + numericVersionMatch[1].length;
  const originalVersion = '0.3.0';
  const invalidVersion = '0.3.0-beta.1';
  const originalVersionEnd = versionStart + originalVersion.length;
  const invalidVersionEnd = versionStart + invalidVersion.length;
  const invalidManifest = Buffer.from(`${originalManifestText.slice(0, versionStart)}${invalidVersion}${originalManifestText.slice(originalVersionEnd)}`);
  expect(invalidManifest.subarray(0, versionStart)).toEqual(originalManifest.subarray(0, versionStart));
  expect(invalidManifest.subarray(invalidVersionEnd)).toEqual(originalManifest.subarray(originalVersionEnd));
  await writeFile(manifestPath, invalidManifest);
  expect(await readFile(manifestPath)).toEqual(invalidManifest);

  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: false,
      args: ['--noerrdialogs', `--disable-extensions-except=${invalidExtensionPath}`, `--load-extension=${invalidExtensionPath}`],
    });

    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    expect(await extensionIds(context)).toEqual([]);
  } finally {
    await context?.close();
    await rm(userDataDir, { recursive: true, force: true });
    await rm(invalidExtensionPath, { recursive: true, force: true });
  }
});

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

test('packaged-popup accessibility has no serious or critical Axe violations and reaches Analyze and Restore by Tab', async () => {
  const userDataDir = await mkdtemp(resolve(tmpdir(), 'clearchoice-popup-a11y-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const id = await extensionId(context);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup/index.html`);

    const results = await new AxeBuilder({ page: popup }).analyze();
    expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([]);

    await popup.locator('body').focus();
    await popup.keyboard.press('Tab');
    await expect(popup.getByRole('button', { name: 'Analyze' })).toBeFocused();
    await popup.keyboard.press('Tab');
    await expect(popup.getByRole('button', { name: 'Restore' })).toBeFocused();
  } finally {
    await closeExtension(context, userDataDir);
  }
});

declare global {
  interface Window {
    __clearchoiceKeyEvents: string[];
  }
}
