import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const verifier = resolve(process.cwd(), 'scripts/verify-package.mjs');

const safeManifest = {
  manifest_version: 3,
  name: 'ClearChoice',
  version: '0.1.0',
  description: 'A local extension popup.',
  action: { default_popup: 'popup/index.html' },
  permissions: ['activeTab', 'scripting', 'storage'],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  host_permissions: [],
};

function verify(manifest) {
  const directory = mkdtempSync(join(tmpdir(), 'clearchoice-manifest-'));
  const manifestPath = join(directory, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));

  try {
    const result = spawnSync(process.execPath, [verifier, '--manifest', manifestPath], {
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('package verifier accepts only the safe MV3 manifest contract', () => {
  const safe = verify(safeManifest);
  expect(safe.status, safe.stderr).toBe(0);
  expect(safe.stdout).toBe('manifest contract passed\n');

  for (const [label, manifest] of [
    ['all URLs', { ...safeManifest, host_permissions: ['<all_urls>'] }],
    ['tabs', { ...safeManifest, permissions: [...safeManifest.permissions, 'tabs'] }],
    ['webRequest', { ...safeManifest, permissions: [...safeManifest.permissions, 'webRequest'] }],
    ['nonempty host permissions', { ...safeManifest, host_permissions: ['https://example.test/*'] }],
    ['externally connectable', { ...safeManifest, externally_connectable: { matches: ['https://example.test/*'] } }],
  ]) {
    const result = verify(manifest);
    expect(result.status, `${label} manifest unexpectedly passed`).not.toBe(0);
  }
});
