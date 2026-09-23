// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { validateManualActiveTabMarker } from '../scripts/active-tab-qa.mjs';

const root = resolve(process.cwd());
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const manifestSha256 = createHash('sha256').update(readFileSync(resolve(root, 'manifest.json'))).digest('hex');
const reviewer = 'local-human-attestation';

function marker(overrides = {}) {
  return {
    schemaVersion: 1,
    outcome: 'passed',
    commit,
    manifestSha256,
    reviewer,
    ...overrides,
  };
}

test('accepts a deliberately supplied local human attestation marker for this commit and manifest', () => {
  expect(validateManualActiveTabMarker(marker(), { commit, manifestSha256 })).toEqual({ ok: true });
});

test.each([
  ['a non-pass outcome', marker({ outcome: 'failed' })],
  ['a missing reviewer attestation', marker({ reviewer: '' })],
  ['a free-text reviewer value', marker({ reviewer: 'local-qa' })],
  ['a marker for another commit', marker({ commit: '0'.repeat(40) })],
  ['a marker for another manifest', marker({ manifestSha256: '0'.repeat(64) })],
])('rejects %s', (_label, value) => {
  expect(validateManualActiveTabMarker(value, { commit, manifestSha256 }).ok).toBe(false);
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
  const result = validateManualActiveTabMarker(marker({ [key]: value }), { commit, manifestSha256 });
  expect(result).toEqual({ ok: false, error: 'marker must contain exactly the required attestation fields' });
});

test('rejects required fields inherited through the prototype', () => {
  const inheritedMarker = Object.create(marker());
  expect(validateManualActiveTabMarker(inheritedMarker, { commit, manifestSha256 })).toEqual({
    ok: false,
    error: 'marker must be a JSON object',
  });
});

test.each([null, [], Object.assign(Object.create(null), marker())])('rejects malformed non-JSON marker objects', (value) => {
  expect(validateManualActiveTabMarker(value, { commit, manifestSha256 })).toEqual({
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
  expect(validateManualActiveTabMarker(inheritedMarker, { commit, manifestSha256 })).toEqual({
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

test('check:beta fails closed unless a marker path is deliberately supplied', () => {
  const result = spawnSync(process.execPath, ['scripts/check-beta.mjs', '--validate-marker-only'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLEARCHOICE_ACTIVE_TAB_QA_MARKER: '' },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('CLEARCHOICE_ACTIVE_TAB_QA_MARKER');
});
