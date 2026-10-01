import { Buffer } from 'node:buffer';
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sha256 } from './active-tab-qa.mjs';
import { tmpdir } from 'node:os';
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

export function assertCleanCandidateCommit(repositoryRoot) {
  const commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('candidate commit must be readable');
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()) {
    throw new Error('candidate repository has dirty tracked files; finish and commit source before human QA');
  }
  return commit;
}

// The private bounded snapshot is the ONLY input to policy, hashing and extraction.
// Path replacement after open cannot change the reviewed/validated archive.
export function prepareCandidateArchive(repositoryRoot, {
  archivePath = unpackedArchivePath(repositoryRoot),
  testHooks = {},
} = {}) {
  const commit = assertCleanCandidateCommit(repositoryRoot);
  const scratchRoot = resolve(tmpdir());
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(resolve(scratchRoot, 'clearchoice-candidate-'));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  let descriptor;
  try {
    descriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > 32 * 1024 * 1024) throw new Error('candidate archive must be a regular file between 1 byte and 32 MiB');
    testHooks.afterOpen?.();
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('candidate archive changed while reading');
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('candidate archive changed while reading');
    const snapshot = resolve(scratch, 'candidate.zip');
    writeFileSync(snapshot, bytes, { mode: 0o400, flag: 'wx' });
    const extensionPath = resolve(scratch, 'extension');
    // Reject traversal, duplicates, links, encrypted/oversized entries before extraction.
    execFileSync('python3', ['-c', `
import pathlib, stat, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    entries = z.infolist()
    names = [i.filename for i in entries]
    if len(entries) > 4096 or len(set(names)) != len(names): raise ValueError('duplicate or excessive ZIP entries')
    if sum(i.file_size for i in entries) > 64 * 1024 * 1024: raise ValueError('ZIP expanded size exceeds 64 MiB')
    for i in entries:
        p = pathlib.PurePosixPath(i.filename)
        mode = i.external_attr >> 16
        if not i.filename or i.filename.startswith('/') or '\\\\' in i.filename or ':' in i.filename or '..' in p.parts or '.' in i.filename.split('/') or i.flag_bits & 1 or stat.S_ISLNK(mode): raise ValueError('unsafe ZIP entry')
        if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR): raise ValueError('non-regular ZIP entry')
    z.extractall(sys.argv[2])
`, snapshot, extensionPath], { stdio: 'pipe' });
    execFileSync(process.execPath, [resolve(repositoryRoot, 'scripts/verify-package.mjs'), '--zip', snapshot], { stdio: 'pipe' });
    const manifestSha256 = sha256(readFileSync(resolve(extensionPath, 'manifest.json')));
    if (manifestSha256 !== sha256(readFileSync(resolve(repositoryRoot, 'manifest.json')))) throw new Error('packaged manifest does not match the current source manifest');
    if (assertCleanCandidateCommit(repositoryRoot) !== commit) throw new Error('candidate commit changed during archive preparation');
    return { commit, manifestSha256, archiveSha256: sha256(bytes), extensionPath, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
