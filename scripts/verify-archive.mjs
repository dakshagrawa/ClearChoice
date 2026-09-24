import { resolve } from 'node:path';
import { unpackedArchivePath } from './release-artifact.mjs';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['scripts/verify-package.mjs', '--zip', unpackedArchivePath(root)], {
  cwd: root,
  stdio: 'inherit',
});
