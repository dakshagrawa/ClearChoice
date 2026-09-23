import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const archive = resolve(root, 'ClearChoice-v0.2.0-unpacked.zip');
const releaseMatch = 'http://127.0.0.1/*';
const releasePermissions = ['storage'];
const tailnetHostname = /(?:^|[^a-z0-9-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net(?:$|[^a-z0-9-])/i;

function run(command, args) {
  process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`);
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function fail(message) {
  throw new Error(`release gate failed: ${message}`);
}

function zipText(path) {
  return execFileSync('unzip', ['-p', archive, path], { cwd: root, encoding: 'utf8' });
}

function assertReleaseArchive() {
  if (!existsSync(archive)) fail(`missing archive ${archive}`);
  const names = execFileSync('unzip', ['-Z1', archive], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  if (!names.includes('manifest.json')) fail('ZIP does not contain manifest.json at its root');
  if (names.some((name) => name.startsWith('dist/'))) fail('ZIP must not wrap files in dist/');
  const archiveText = names.map((name) => `${name}\n${zipText(name)}`).join('\n');
  if (tailnetHostname.test(archiveText)) fail('ZIP contains a Tailnet hostname');

  let manifest;
  try {
    manifest = JSON.parse(zipText('manifest.json'));
  } catch (error) {
    fail(`ZIP manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(manifest.permissions) || manifest.permissions.length !== releasePermissions.length ||
    !releasePermissions.every((permission) => manifest.permissions.includes(permission))) {
    fail('manifest permissions must be exactly storage');
  }
  if (!Array.isArray(manifest.host_permissions) || manifest.host_permissions.length !== 0) fail('manifest host_permissions must be []');
  if ('optional_permissions' in manifest || 'optional_host_permissions' in manifest) fail('manifest must not declare optional permissions');
  if (manifest.background?.service_worker) fail('manifest must not declare a service worker');
  if ('externally_connectable' in manifest) fail('manifest must not declare externally_connectable');
  const matches = manifest.content_scripts?.flatMap((script) => script.matches ?? []) ?? [];
  if (matches.length !== 1 || matches[0] !== releaseMatch) fail(`content-script matches must be exactly ${releaseMatch}`);
  process.stdout.write(`ZIP integrity passed: ${names.length} entries; parsed manifest version ${manifest.version}.\n`);
}

run('npm', ['test', '--', '--run']);
run('npm', ['run', 'lint']);
run('npm', ['run', 'build']);
run('npm', ['run', 'e2e']);
run('npm', ['run', 'package:unpacked']);
assertReleaseArchive();
