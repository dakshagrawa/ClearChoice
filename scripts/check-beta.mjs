import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateManualActiveTabMarker } from './active-tab-qa.mjs';

const root = resolve(import.meta.dirname, '..');

function fail(message) {
  process.stderr.write(`check:beta failed: ${message}\n`);
  process.exit(1);
}

function expectedMarker() {
  return {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    manifestSha256: sha256(readFileSync(resolve(root, 'manifest.json'))),
  };
}

function isInsideRepository(path) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !pathFromRoot.startsWith('/'));
}

export function readManualActiveTabMarker(markerPath, { beforeOpen } = {}) {
  const resolvedMarkerPath = resolve(markerPath);
  if (isInsideRepository(resolvedMarkerPath)) {
    throw new Error('CLEARCHOICE_ACTIVE_TAB_QA_MARKER must point outside the repository so it cannot be committed or archived');
  }

  beforeOpen?.();
  let descriptor;
  try {
    try {
      descriptor = openSync(resolvedMarkerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ELOOP') {
        throw new Error('CLEARCHOICE_ACTIVE_TAB_QA_MARKER must not be a symlink (terminal symlink)');
      }
      throw error;
    }
    if (!fstatSync(descriptor).isFile()) {
      throw new Error('CLEARCHOICE_ACTIVE_TAB_QA_MARKER must be a regular file');
    }
    const openedMarkerPath = realpathSync(`/proc/self/fd/${descriptor}`);
    if (isInsideRepository(openedMarkerPath)) {
      throw new Error('CLEARCHOICE_ACTIVE_TAB_QA_MARKER must resolve outside the repository at read time so it cannot be committed or archived');
    }
    return JSON.parse(readFileSync(descriptor, 'utf8'));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertManualActiveTabMarker() {
  const markerPath = process.env.CLEARCHOICE_ACTIVE_TAB_QA_MARKER;
  if (!markerPath) fail('CLEARCHOICE_ACTIVE_TAB_QA_MARKER must point to a deliberate local manual-QA marker');
  let marker;
  try {
    marker = readManualActiveTabMarker(markerPath);
  } catch (error) {
    fail(`unable to read CLEARCHOICE_ACTIVE_TAB_QA_MARKER: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = validateManualActiveTabMarker(marker, expectedMarker());
  if (!result.ok) fail(result.error);
  process.stdout.write('manual active-tab QA marker accepted\n');
}

function run(command, args) {
  process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`);
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

const argv = process.argv.slice(2);
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (argv.length === 1 && argv[0] === '--validate-marker-only') {
    assertManualActiveTabMarker();
  } else if (argv.length === 0) {
    assertManualActiveTabMarker();
    run('npm', ['test', '--', '--run']);
    run('npm', ['run', 'lint']);
    run('npm', ['run', 'build']);
    run('npm', ['run', 'e2e']);
    run('npm', ['run', 'package:unpacked']);
    run('node', ['scripts/verify-package.mjs', '--zip', resolve(root, 'ClearChoice-v0.2.0-unpacked.zip')]);
  } else {
    fail('usage: node scripts/check-beta.mjs [--validate-marker-only]');
  }
}
