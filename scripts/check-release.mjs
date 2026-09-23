import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const archive = resolve(root, 'ClearChoice-v0.2.0-unpacked.zip');

function run(command, args) {
  process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`);
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function assertReleaseArchive() {
  if (!existsSync(archive)) throw new Error(`release gate failed: missing archive ${archive}`);
  run('node', ['scripts/verify-package.mjs', '--zip', archive]);
}

run('npm', ['test', '--', '--run']);
run('npm', ['run', 'lint']);
run('npm', ['run', 'build']);
run('npm', ['run', 'e2e']);
run('npm', ['run', 'package:unpacked']);
assertReleaseArchive();
