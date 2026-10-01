// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { readManualActiveTabMarker } from '../scripts/check-beta.mjs';
import { validateManualActiveTabMarker } from '../scripts/active-tab-qa.mjs';

const root = resolve(process.cwd());
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const manifestSha256 = createHash('sha256').update(readFileSync(resolve(root, 'manifest.json'))).digest('hex');
const reviewer = 'local-human-attestation';

function marker(overrides = {}) {
  return {
    schemaVersion: 3,
    archiveSha256: 'c'.repeat(64),
    outcome: 'passed',
    cleanFixtureIntegrity: 'passed',
    dynamicFixtureIntegrity: 'passed',
    accessibility: true,
    commit,
    manifestSha256,
    reviewer,
    ...overrides,
  };
}

test('schema 3 binds the complete archive and rejects old or changed archive attestations', () => {
  const archiveSha256 = 'c'.repeat(64);
  const expected = { commit, manifestSha256, archiveSha256 };
  expect(validateManualActiveTabMarker(marker({ schemaVersion: 3, archiveSha256 }), expected)).toEqual({ ok: true });
  expect(validateManualActiveTabMarker(marker({ schemaVersion: 2 }), expected).ok).toBe(false);
  expect(validateManualActiveTabMarker(marker({ schemaVersion: 3, archiveSha256: 'd'.repeat(64) }), expected).ok).toBe(false);
});

test.each([
  ['a non-pass outcome', marker({ outcome: 'failed' })],
  ['a missing clean fixture integrity attestation', marker({ cleanFixtureIntegrity: 'failed' })],
  ['a missing dynamic fixture integrity attestation', marker({ dynamicFixtureIntegrity: 'failed' })],
  ['a missing accessibility attestation', marker({ accessibility: false })],
  ['a missing reviewer attestation', marker({ reviewer: '' })],
  ['a free-text reviewer value', marker({ reviewer: 'local-qa' })],
  ['a marker for another commit', marker({ commit: '0'.repeat(40) })],
  ['a marker for another manifest', marker({ manifestSha256: '0'.repeat(64) })],
])('rejects %s', (_label, value) => {
  expect(validateManualActiveTabMarker(value, { commit, manifestSha256, archiveSha256: 'c'.repeat(64) }).ok).toBe(false);
});

test.each([
  ['page title', 'pageTitle', 'ClearChoice'],
  ['page HTML', 'pageHtml', '<html><body>ClearChoice</body></html>'],
  ['URL', 'url', 'https://example.test/'],
  ['evidence', 'evidence', 'checked active tab'],
  ['selector', 'selector', '#app'],
  ['form value', 'formValue', '4111 1111 1111 1111'],
  ['an unrelated key', 'unexpected', true],
])('rejects markers containing %s data', (_label, key, value) => {
  const result = validateManualActiveTabMarker(marker({ [key]: value }), { commit, manifestSha256, archiveSha256: 'c'.repeat(64) });
  expect(result).toEqual({ ok: false, error: 'marker must contain exactly the required attestation fields' });
});

test('rejects required fields inherited through the prototype', () => {
  const inheritedMarker = Object.create(marker());
  expect(validateManualActiveTabMarker(inheritedMarker, { commit, manifestSha256, archiveSha256: 'c'.repeat(64) })).toEqual({
    ok: false,
    error: 'marker must be a JSON object',
  });
});

test.each([null, [], Object.assign(Object.create(null), marker())])('rejects malformed non-JSON marker objects', (value) => {
  expect(validateManualActiveTabMarker(value, { commit, manifestSha256, archiveSha256: 'c'.repeat(64) })).toEqual({
    ok: false,
    error: 'marker must be a JSON object',
  });
});

test.each([
  ['page title', 'pageTitle', 'ClearChoice'],
  ['page HTML', 'pageHtml', '<html><body>ClearChoice</body></html>'],
  ['URL', 'url', 'https://example.test/'],
  ['evidence', 'evidence', 'checked active tab'],
  ['selector', 'selector', '#app'],
  ['form value', 'formValue', '4111 1111 1111 1111'],
  ['unexpected data', 'unexpected', true],
])('rejects %s inherited through the prototype', (_label, key, value) => {
  const inheritedMarker = Object.assign(Object.create({ [key]: value }), marker());
  expect(validateManualActiveTabMarker(inheritedMarker, { commit, manifestSha256, archiveSha256: 'c'.repeat(64) })).toEqual({
    ok: false,
    error: 'marker must be a JSON object',
  });
});

test('check:beta rejects a marker path inside the repository before reading it', () => {
  const result = spawnSync(process.execPath, ['scripts/check-beta.mjs', '--validate-marker-only'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLEARCHOICE_ACTIVE_TAB_QA_MARKER: 'manual-active-tab-qa.json' },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('outside the repository');
});

test('check:beta fails closed with a Linux-only diagnostic before opening a marker on another platform', () => {
  expect(() => readManualActiveTabMarker('/external/marker.json', {
    platform: 'darwin',
    testHooks: {
      beforeOpen() {
        throw new Error('marker must not be opened on an unsupported platform');
      },
    },
  })).toThrow('supported only on Linux because it validates the opened descriptor through /proc/self/fd; current platform: darwin');
});

test('check:beta rejects an external marker symlink before reading it', async () => {
  const markerDirectory = await mkdtemp(resolve(tmpdir(), 'clearchoice-beta-marker-symlink-'));
  try {
    const target = resolve(markerDirectory, 'marker.json');
    const markerPath = resolve(markerDirectory, 'marker-link.json');
    await writeFile(target, `${JSON.stringify(marker())}\n`);
    await symlink(target, markerPath);

    const result = spawnSync(process.execPath, ['scripts/check-beta.mjs', '--validate-marker-only'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CLEARCHOICE_ACTIVE_TAB_QA_MARKER: markerPath },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must not be a symlink');
  } finally {
    await rm(markerDirectory, { recursive: true, force: true });
  }
});

test('check:beta accepts a marker reached through an external parent-directory symlink', async () => {
  const markerDirectory = await mkdtemp(resolve(tmpdir(), 'clearchoice-beta-marker-parent-external-'));
  const parentPath = resolve(markerDirectory, 'parent');
  const targetDirectory = resolve(markerDirectory, 'target');
  try {
    await mkdir(targetDirectory);
    await writeFile(resolve(targetDirectory, 'marker.json'), `${JSON.stringify(marker())}\n`);
    await symlink(targetDirectory, parentPath);

    expect(readManualActiveTabMarker(resolve(parentPath, 'marker.json'))).toEqual(marker());
  } finally {
    await rm(markerDirectory, { recursive: true, force: true });
  }
});

test('check:beta rejects a marker reached through a parent-directory symlink into the repository', async () => {
  const markerDirectory = await mkdtemp(resolve(tmpdir(), 'clearchoice-beta-marker-parent-repo-'));
  try {
    const parentPath = resolve(markerDirectory, 'parent');
    await symlink(root, parentPath);
    const result = spawnSync(process.execPath, ['scripts/check-beta.mjs', '--validate-marker-only'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CLEARCHOICE_ACTIVE_TAB_QA_MARKER: resolve(parentPath, 'manifest.json') },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('outside the repository');
  } finally {
    await rm(markerDirectory, { recursive: true, force: true });
  }
});

test('check:beta rejects a marker whose parent symlink is swapped into the repository before opening', async () => {
  const markerDirectory = await mkdtemp(resolve(tmpdir(), 'clearchoice-beta-marker-parent-swap-'));
  const parentPath = resolve(markerDirectory, 'parent');
  const targetDirectory = resolve(markerDirectory, 'target');
  const repositoryMarkerPath = resolve(root, '.beta-marker-race.json');
  const markerName = '.beta-marker-race.json';
  try {
    await mkdir(targetDirectory);
    await writeFile(resolve(targetDirectory, markerName), `${JSON.stringify(marker())}\n`);
    writeFileSync(repositoryMarkerPath, `${JSON.stringify(marker())}\n`);
    symlinkSync(targetDirectory, parentPath);

    expect(() => readManualActiveTabMarker(resolve(parentPath, markerName), {
      testHooks: {
        beforeOpen() {
          unlinkSync(parentPath);
          symlinkSync(root, parentPath);
        },
      },
    })).toThrow('outside the repository');
  } finally {
    await rm(repositoryMarkerPath, { force: true });
    await rm(markerDirectory, { recursive: true, force: true });
  }
});

test('check:beta keeps reading the opened external marker after a controlled parent symlink swap', async () => {
  const markerDirectory = await mkdtemp(resolve(tmpdir(), 'clearchoice-beta-marker-post-open-parent-swap-'));
  const parentPath = resolve(markerDirectory, 'parent');
  const targetDirectory = resolve(markerDirectory, 'target');
  const markerName = 'marker.json';
  let swapped = false;
  try {
    await mkdir(targetDirectory);
    await writeFile(resolve(targetDirectory, markerName), `${JSON.stringify(marker())}\n`);
    symlinkSync(targetDirectory, parentPath);

    expect(readManualActiveTabMarker(resolve(parentPath, markerName), {
      platform: 'linux',
      testHooks: {
        afterOpen() {
          unlinkSync(parentPath);
          symlinkSync(root, parentPath);
          swapped = true;
        },
      },
    })).toEqual(marker());
    expect(swapped).toBe(true);
  } finally {
    await rm(markerDirectory, { recursive: true, force: true });
  }
});

test('check:beta fails closed unless a marker path is deliberately supplied', () => {
  const result = spawnSync(process.execPath, ['scripts/check-beta.mjs', '--validate-marker-only'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLEARCHOICE_ACTIVE_TAB_QA_MARKER: '' },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('CLEARCHOICE_ACTIVE_TAB_QA_MARKER');
});
