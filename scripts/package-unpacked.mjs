import { existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const dist = resolve(repositoryRoot, 'dist');
const archive = resolve(repositoryRoot, 'ClearChoice-mvp-unpacked.zip');

if (!existsSync(resolve(dist, 'manifest.json'))) {
  throw new Error('dist/manifest.json is missing; run npm run build first.');
}

rmSync(archive, { force: true });
execFileSync('zip', ['-r', archive, '.'], { cwd: dist, stdio: 'inherit' });
process.stdout.write(`created ${archive}\n`);
