// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { validateManualActiveTabMarker } from '../scripts/active-tab-qa.mjs';

const root = resolve(process.cwd());
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const manifestSha256 = createHash('sha256').update(readFileSync(resolve(root, 'manifest.json'))).digest('hex');

function marker(overrides = {}) {
  return {
    schemaVersion: 1,
    outcome: 'passed',
    commit,
    manifestSha256,
    reviewer: 'local-qa',
    ...overrides,
  };
}

test('accepts a deliberately supplied pass-only manual active-tab marker for this commit and manifest', () => {
  expect(validateManualActiveTabMarker(marker(), { commit, manifestSha256 })).toEqual({ ok: true });
});

test.each([
  ['a non-pass outcome', marker({ outcome: 'failed' })],
  ['a missing reviewer sign-off', marker({ reviewer: '' })],
  ['a marker for another commit', marker({ commit: '0'.repeat(40) })],
  ['a marker for another manifest', marker({ manifestSha256: '0'.repeat(64) })],
])('rejects %s', (_label, value) => {
  expect(validateManualActiveTabMarker(value, { commit, manifestSha256 }).ok).toBe(false);
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
