import { readFileSync } from 'node:fs';

const allowedPermissions = ['activeTab', 'scripting', 'storage'];
const secretManifestKeys = new Set(['api_key', 'apiKey', 'token', 'secret', 'password']);
const executableManifestKeys = new Set(['service_worker', 'js']);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseManifestPath(argv) {
  if (argv.length !== 2 || argv[0] !== '--manifest') {
    fail('usage: node scripts/verify-package.mjs --manifest PATH');
  }

  return argv[1];
}

function findUnsafeString(value, path = '$') {
  if (typeof value === 'string') {
    if (/<all_urls>/i.test(value)) return `${path} contains <all_urls>`;
    if (/(fetch|xhr|websocket)/i.test(value)) return `${path} contains a network API string`;
    return null;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const result = findUnsafeString(item, `${path}[${index}]`);
      if (result) return result;
    }
  }

  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (secretManifestKeys.has(key)) return `manifest key ${key} is not allowed`;
      const result = findUnsafeString(item, `${path}.${key}`);
      if (result) return result;
    }
  }

  return null;
}

function findRemoteExecutableUrl(value, path = '$') {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const result = findRemoteExecutableUrl(item, `${path}[${index}]`);
      if (result) return result;
    }
  }

  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const itemPath = `${path}.${key}`;
      if (executableManifestKeys.has(key)) {
        const executableUrls = Array.isArray(item) ? item : [item];
        for (const executableUrl of executableUrls) {
          if (typeof executableUrl === 'string' && /^https?:\/\//i.test(executableUrl)) {
            return `${itemPath} contains a remote executable URL`;
          }
        }
      }

      const result = findRemoteExecutableUrl(item, itemPath);
      if (result) return result;
    }
  }

  return null;
}

const manifestPath = parseManifestPath(process.argv.slice(2));
let manifest;

try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  fail(`unable to read manifest: ${error.message}`);
}

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
if (!Array.isArray(manifest.permissions) || manifest.permissions.length !== allowedPermissions.length ||
  !allowedPermissions.every((permission) => manifest.permissions.includes(permission))) {
  fail('permissions must be exactly activeTab, scripting, storage');
}
if (!Array.isArray(manifest.host_permissions) || manifest.host_permissions.length !== 0) {
  fail('host_permissions must be exactly []');
}
if (Object.hasOwn(manifest, 'externally_connectable')) {
  fail('externally_connectable is not allowed');
}
if (manifest.background?.service_worker) {
  fail('background.service_worker is not allowed');
}

const remoteExecutableUrl = findRemoteExecutableUrl(manifest);
if (remoteExecutableUrl) fail(remoteExecutableUrl);

const unsafeString = findUnsafeString(manifest);
if (unsafeString) fail(unsafeString);

process.stdout.write('manifest contract passed\n');
