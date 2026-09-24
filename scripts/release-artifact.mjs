import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const chromeVersionPattern = /^\d+(?:\.\d+){0,3}$/;

export function readCandidateVersionMapping(repositoryRoot) {
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'manifest.json'), 'utf8'));
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('package.json version must be a nonempty semantic candidate identity');
  }
  if (typeof manifest.version !== 'string' || !chromeVersionPattern.test(manifest.version)) {
    throw new Error('manifest version must be one to four dot-separated integers for Chrome');
  }
  if (manifest.version_name !== packageJson.version) {
    throw new Error('manifest version_name must exactly match package.json version');
  }
  return {
    packageVersion: packageJson.version,
    manifestVersion: manifest.version,
    manifestVersionName: manifest.version_name,
  };
}

export function unpackedArchivePath(repositoryRoot) {
  const { packageVersion } = readCandidateVersionMapping(repositoryRoot);
  return resolve(repositoryRoot, `ClearChoice-v${packageVersion}-unpacked.zip`);
}
