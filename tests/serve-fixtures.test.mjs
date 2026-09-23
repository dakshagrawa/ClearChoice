// @vitest-environment node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, test } from 'vitest';

const fakeDataBanner = 'This is a local demonstration with fake products and no real customer, account, or payment data.';
const expectedSignals = {
  '/checkout/clean': [],
  '/checkout/recurring': ['Membership renews automatically for $12 per month until cancelled.'],
  '/checkout/addon': ['Add purchase protection for $5'],
  '/checkout/mixed': [
    'Membership renews automatically for $12 per month until cancelled.',
    'Add purchase protection for $5',
  ],
};

async function startFixtureServer() {
  const child = spawn(process.execPath, ['scripts/serve-fixtures.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const readyUrl = await Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.on('data', () => {
        const match = stdout.match(/^Mock checkout: (http:\/\/127\.0\.0\.1:(\d+))$/m);
        if (match) resolve(match[1]);
      });
      child.once('exit', (code, signal) => reject(new Error(`fixture server exited with ${code ?? signal}: ${stderr}`)));
      child.once('error', reject);
    }),
    new Promise((_, reject) => globalThis.setTimeout(() => reject(new Error('fixture server did not become ready')), 5_000)),
  ]);

  return { child, getOutput: () => ({ stderr, stdout }), readyUrl };
}

async function stopFixtureServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

test('controlled checkout fixtures expose only the scenario matrix with exact fake signals', async () => {
  const { child, getOutput, readyUrl } = await startFixtureServer();

  try {
    expect(readyUrl).not.toContain(':4173');

    for (const [route, signals] of Object.entries(expectedSignals)) {
      const response = await globalThis.fetch(`${readyUrl}${route}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const html = await response.text();
      expect(html).toContain(fakeDataBanner);
      expect(html.match(/renews automatically for \$12 per month until cancelled\./g) ?? []).toHaveLength(
        signals.includes('Membership renews automatically for $12 per month until cancelled.') ? 1 : 0,
      );
      expect(html.match(/<input type="checkbox" checked> Add purchase protection for \$5/g) ?? []).toHaveLength(
        signals.includes('Add purchase protection for $5') ? 1 : 0,
      );
    }

    for (const path of [
      '/unsupported/marketing-article',
      '/unsupported/account-settings',
    ]) {
      const response = await globalThis.fetch(`${readyUrl}${path}`);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html).toContain(path.includes('marketing') ? 'How to pay now for subscriptions' : 'Account settings');
    }

    for (const path of [
      '/checkout',
      '/checkout/unknown',
      '/checkout/clean?unexpected=true',
      '/fixtures/clean-checkout.html',
      '/package.json',
      '/%2e%2e/package.json',
      '/checkout/%2e%2e/package.json',
    ]) {
      const response = await globalThis.fetch(`${readyUrl}${path}`);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('content-type'), path).toBe('text/plain; charset=utf-8');
      expect(await response.text(), path).toBe('Not found');
    }

    expect(getOutput().stdout).toBe(`Mock checkout: ${readyUrl}\n`);
  } finally {
    await stopFixtureServer(child);
  }
});
