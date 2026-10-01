// @vitest-environment node
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import * as artifacts from '../scripts/release-artifact.mjs';
import { sha256, WORKFLOW_PREDICATES } from '../scripts/active-tab-qa.mjs';

const scratch = '/home/daksh/.hermes/cache/scratch';
function fixture(run) {
  const dir = mkdtempSync(resolve(scratch, 'exact-archive-test-'));
  const root = resolve(dir, 'repo');
  mkdirSync(root);
  cpSync(resolve('scripts'), resolve(root, 'scripts'), { recursive: true });
  cpSync(resolve('manifest.json'), resolve(root, 'manifest.json'));
  cpSync(resolve('package.json'), resolve(root, 'package.json'));
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'test fixture']]) execFileSync('git', args, { cwd: root });
  const assets = resolve(dir, 'assets');
  mkdirSync(resolve(assets, 'popup'), { recursive: true });
  execFileSync(process.execPath, ['scripts/build-manifest.mjs', '--release', '--output', resolve(assets, 'manifest.json')], { cwd: root });
  writeFileSync(resolve(assets, 'content.js'), 'void 0;');
  writeFileSync(resolve(assets, 'worker.js'), 'void 0;');
  writeFileSync(resolve(assets, 'popup/index.html'), '<html>fixture</html>');
  const archive = artifacts.unpackedArchivePath(root);
  execFileSync('zip', ['-qr', archive, '.'], { cwd: assets });
  const expected = {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    manifestSha256: sha256(readFileSync(resolve(assets, 'manifest.json'))),
    archiveSha256: sha256(readFileSync(archive)),
  };
  const marker = resolve(dir, 'synthetic-unit-marker.json');
  writeFileSync(marker, JSON.stringify({ schemaVersion: 4, ...Object.fromEntries(WORKFLOW_PREDICATES.map((field) => [field, field === 'accessibility' ? true : 'passed'])), outcome: 'passed', cleanFixtureIntegrity: 'passed', dynamicFixtureIntegrity: 'passed', accessibility: true, reviewer: 'local-human-attestation', ...expected }));
  const bin = resolve(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(resolve(bin, 'npm'), '#!/bin/sh\nprintf forbidden-npm-invocation >&2\nexit 99\n', { mode: 0o700 });
  const gate = (args = []) => spawnSync(process.execPath, ['scripts/check-beta.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLEARCHOICE_ACTIVE_TAB_QA_MARKER: marker } });
  try { run({ dir, root, assets, archive, expected, gate }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('candidate accepts approved generated manifest bytes and hashes those packaged bytes', () => fixture(({ root, assets, expected }) => {
  const source = readFileSync(resolve(root, 'manifest.json'), 'utf8');
  const generated = readFileSync(resolve(assets, 'manifest.json'), 'utf8');
  expect(JSON.parse(generated)).toEqual(JSON.parse(source));
  expect(generated).not.toBe(source);
  const candidate = artifacts.prepareCandidateArchive(root);
  try { expect(candidate.manifestSha256).toBe(expected.manifestSha256); }
  finally { candidate.cleanup(); }
}));

test('default gate validates an existing exact archive without rebuilding or npm', () => fixture(({ archive, gate }) => {
  const before = readFileSync(archive);
  const result = gate();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).not.toMatch(/\$ npm|npm run build|package:unpacked/);
  expect(readFileSync(archive)).toEqual(before);
}));

test('gate rejects missing archive even in validate-marker-only mode', () => fixture(({ archive, gate }) => {
  unlinkSync(archive);
  expect(gate(['--validate-marker-only']).status).not.toBe(0);
}));

test('gate rejects changed archive bytes', () => fixture(({ archive, gate }) => {
  writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from('changed')]));
  expect(gate().stderr).toContain('current archive');
}));

test('gate rejects dirty tracked source and a changed current commit', () => fixture(({ root, gate }) => {
  writeFileSync(resolve(root, 'manifest.json'), `${readFileSync(resolve(root, 'manifest.json'), 'utf8')}\n`);
  expect(gate().stderr).toContain('dirty tracked files');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'change'], { cwd: root });
  expect(gate().stderr).toContain('current commit');
}));

test('gate verifies packaged policy even when the synthetic marker matches archive bytes', () => fixture(({ dir, assets, archive, gate }) => {
  writeFileSync(resolve(assets, 'content.js'), 'fetch("https://fixture.invalid");');
  execFileSync('zip', ['-qr', archive, '.'], { cwd: assets });
  const markerPath = resolve(dir, 'synthetic-unit-marker.json');
  const value = JSON.parse(readFileSync(markerPath, 'utf8'));
  value.archiveSha256 = sha256(readFileSync(archive));
  writeFileSync(markerPath, JSON.stringify(value));
  expect(gate().stderr).toContain('artifact policy');
}));

test('gate rejects stale commit and old schema synthetic markers', () => fixture(({ dir, gate }) => {
  const markerPath = resolve(dir, 'synthetic-unit-marker.json');
  const value = JSON.parse(readFileSync(markerPath, 'utf8'));
  writeFileSync(markerPath, JSON.stringify({ ...value, commit: '0'.repeat(40) }));
  expect(gate().stderr).toContain('current commit');
  writeFileSync(markerPath, JSON.stringify({ ...value, schemaVersion: 2 }));
  expect(gate().stderr).toContain('schemaVersion must be 4');
}));

test('candidate rejects ZIP paths that alias the same extraction target', () => fixture(({ root, archive }) => {
  execFileSync('python3', ['-c', 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "a") as z:\n    z.writestr("extra//same.txt", "first")\n    z.writestr("extra/same.txt", "second")', archive]);
  let candidate;
  try {
    expect(() => { candidate = artifacts.prepareCandidateArchive(root); }).toThrow(/unsafe ZIP entry/);
  } finally { candidate?.cleanup(); }
}));

test('candidate rejects source changes during archive preparation', () => fixture(({ root }) => {
  expect(() => artifacts.prepareCandidateArchive(root, { testHooks: { afterOpen() {
    writeFileSync(resolve(root, 'manifest.json'), `${readFileSync(resolve(root, 'manifest.json'), 'utf8')} `);
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'racing commit'], { cwd: root });
    // Restore the same manifest bytes under a new commit: hashes alone cannot detect this.
    execFileSync('git', ['checkout', 'HEAD~1', '--', 'manifest.json'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'restore bytes'], { cwd: root });
  } } })).toThrow('commit changed');
}));

test('archive preparation stays bound to opened bytes across parent symlink replacement', () => fixture(({ dir, root, archive, expected }) => {
  const parent = resolve(dir, 'parent');
  const other = resolve(dir, 'other');
  mkdirSync(other);
  writeFileSync(resolve(other, 'candidate.zip'), 'not a zip');
  const original = resolve(dir, 'original');
  mkdirSync(original);
  cpSync(archive, resolve(original, 'candidate.zip'));
  symlinkSync(original, parent);
  expect(typeof artifacts.prepareCandidateArchive).toBe('function');
  const candidate = artifacts.prepareCandidateArchive(root, { archivePath: resolve(parent, 'candidate.zip'), testHooks: { afterOpen() { unlinkSync(parent); symlinkSync(other, parent); } } });
  try {
    expect(candidate.archiveSha256).toBe(expected.archiveSha256);
    expect(sha256(readFileSync(resolve(candidate.extensionPath, 'manifest.json')))).toBe(expected.manifestSha256);
  } finally { candidate.cleanup(); }
}));
