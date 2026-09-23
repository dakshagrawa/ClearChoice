// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { generateManifest } from '../scripts/build-manifest.mjs';

const repositoryRoot = resolve(process.cwd());
const releaseMatch = 'http://127.0.0.1/*';
const demoOrigin = 'http://demo-node.tailnet.ts.net:4173';

function temporaryOriginFile(contents) {
  const directory = mkdtempSync(join(tmpdir(), 'clearchoice-demo-origin-'));
  const originPath = join(directory, '.demo-origin.local');
  writeFileSync(originPath, contents);
  return { directory, originPath };
}

test('release manifest has only the local mock origin without an override', () => {
  const manifest = generateManifest({ mode: 'release' });

  expect(manifest.content_scripts[0].matches).toEqual([releaseMatch]);
});

test('demo manifest adds one valid private Tailnet origin only in demo mode', () => {
  const { directory, originPath } = temporaryOriginFile(`${demoOrigin}\n`);

  try {
    const manifest = generateManifest({ mode: 'demo', originFile: originPath });
    expect(manifest.content_scripts[0].matches).toEqual([releaseMatch, `${demoOrigin}/*`]);
    expect(generateManifest({ mode: 'release' }).content_scripts[0].matches).toEqual([releaseMatch]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  ['wildcard host', 'http://*.tailnet.ts.net:4173'],
  ['comma-separated origins', 'http://first.tailnet.ts.net:4173,http://second.tailnet.ts.net:4173'],
  ['HTTPS origin', 'https://demo-node.tailnet.ts.net:4173'],
  ['non-Tailnet origin', 'http://example.test:4173'],
  ['multiple lines', `${demoOrigin}\nhttp://other-node.tailnet.ts.net:4173`],
])('demo build rejects %s', (_label, contents) => {
  const { directory, originPath } = temporaryOriginFile(`${contents}\n`);

  try {
    expect(() => generateManifest({ mode: 'demo', originFile: originPath })).toThrow(/demo origin/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release source, release dist, and unpacked ZIP have no local demo override', () => {
  const { directory, originPath } = temporaryOriginFile(`${demoOrigin}\n`);

  try {
    const sourceManifest = JSON.parse(readFileSync(join(repositoryRoot, 'manifest.json'), 'utf8'));
    expect(sourceManifest.content_scripts[0].matches).toEqual([releaseMatch]);
    expect(generateManifest({ mode: 'release', originFile: originPath }).content_scripts[0].matches).toEqual([releaseMatch]);

    const packageResult = spawnSync('npm', ['run', 'package:unpacked'], { cwd: repositoryRoot, encoding: 'utf8' });
    expect(packageResult.status, packageResult.stderr).toBe(0);

    const distManifest = JSON.parse(readFileSync(join(repositoryRoot, 'dist', 'manifest.json'), 'utf8'));
    expect(distManifest.content_scripts[0].matches).toEqual([releaseMatch]);

    const archiveManifest = spawnSync('unzip', ['-p', 'ClearChoice-v0.2.0-unpacked.zip', 'manifest.json'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(archiveManifest.status, archiveManifest.stderr).toBe(0);
    expect(JSON.parse(archiveManifest.stdout).content_scripts[0].matches).toEqual([releaseMatch]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
