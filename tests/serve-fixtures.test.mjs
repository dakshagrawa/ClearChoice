// @vitest-environment node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, test } from 'vitest';

const readyLine = 'Mock checkout: http://127.0.0.1:4173/checkout';

async function startFixtureServer() {
  const child = spawn(process.execPath, ['scripts/serve-fixtures.mjs'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  await Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.on('data', () => {
        if (stdout === `${readyLine}\n`) resolve();
      });
      child.once('exit', (code) => reject(new Error(`fixture server exited with ${code}: ${stderr}`)));
      child.once('error', reject);
    }),
    new Promise((_, reject) => globalThis.setTimeout(() => reject(new Error('fixture server did not become ready')), 5_000)),
  ]);

  return { child, getOutput: () => ({ stderr, stdout }) };
}

async function stopFixtureServer(child) {
  child.kill('SIGTERM');
  await once(child, 'exit');
}

test('standalone checkout fixture serves both detection signals and no other files', async () => {
  const { child, getOutput } = await startFixtureServer();

  try {
    const checkout = await globalThis.fetch('http://127.0.0.1:4173/checkout');
    expect(checkout.status).toBe(200);
    const html = await checkout.text();
    expect(html).toContain('renews automatically for $12 per month');
    expect(html).toContain('Add purchase protection for $5');
    expect(html).toMatch(/type="checkbox" checked/i);
    expect(html).toContain('<input type="checkbox"> Add gift wrapping for $3');

    const outsideFixture = await globalThis.fetch('http://127.0.0.1:4173/../package.json');
    expect(outsideFixture.status).toBe(404);
    expect(await outsideFixture.text()).toBe('Not found');
    expect(getOutput().stdout).toBe(`${readyLine}\n`);
  } finally {
    await stopFixtureServer(child);
  }
});
