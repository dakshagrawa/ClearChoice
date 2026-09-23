import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

function assertManualActiveTabMarker() {
  const markerPath = process.env.CLEARCHOICE_ACTIVE_TAB_QA_MARKER;
  if (!markerPath) fail('CLEARCHOICE_ACTIVE_TAB_QA_MARKER must point to a deliberate local manual-QA marker');

  let marker;
  try {
    marker = JSON.parse(readFileSync(resolve(markerPath), 'utf8'));
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
