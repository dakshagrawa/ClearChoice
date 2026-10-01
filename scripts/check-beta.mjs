import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManualActiveTabMarker } from './active-tab-qa.mjs';
import { prepareCandidateArchive } from './release-artifact.mjs';

const root = resolve(import.meta.dirname, '..');

function fail(message) {
  process.stderr.write(`check:beta failed: ${message}\n`);
  process.exit(1);
}

function isInsideRepository(path) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !pathFromRoot.startsWith('/'));
}

export function readManualActiveTabMarker(markerPath, {
  platform = process.platform,
  testHooks = {},
} = {}) {
  if (platform !== 'linux') {
    throw new Error(`check:beta manual active-tab QA marker validation is supported only on Linux because it validates the opened descriptor through /proc/self/fd; current platform: ${platform}`);
  }

  const resolvedMarkerPath = resolve(markerPath);
  if (isInsideRepository(resolvedMarkerPath)) {
    throw new Error('CLEARCHOICE_ACTIVE_TAB_QA_MARKER must point outside the repository so it cannot be committed or archived');
  }

  testHooks.beforeOpen?.();
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
    testHooks.afterOpen?.();
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

  const candidate = prepareCandidateArchive(root);
  try {
    const result = validateManualActiveTabMarker(marker, candidate);
    if (!result.ok) throw new Error(result.error);
    process.stdout.write('manual active-tab QA marker accepted; existing ZIP policy and exact bytes validated (no rebuild)\n');
  } finally {
    candidate.cleanup();
  }
}

const argv = process.argv.slice(2);
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (argv.length !== 0 && !(argv.length === 1 && argv[0] === '--validate-marker-only')) {
    fail('usage: node scripts/check-beta.mjs [--validate-marker-only]');
  }
  try {
    assertManualActiveTabMarker();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
