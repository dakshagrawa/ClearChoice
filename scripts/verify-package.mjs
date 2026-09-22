import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const allowedPermissions = ['activeTab', 'scripting', 'storage'];
const allowedContentScriptMatches = [
  'http://127.0.0.1/*',
  'http://penguin-brox.tailcd2f8e.ts.net:4173/*',
];
const secretManifestKeys = new Set(['api_key', 'apiKey', 'token', 'secret', 'password']);
const executableManifestKeys = new Set(['service_worker', 'js']);
// Extension runtime modules may be emitted as .mjs or .cjs as well as .js.
const runtimeAssetExtension = /\.(?:css|html|js|mjs|cjs|json)$/i;
const forbiddenArtifactPatterns = [
  ['network API', /\b(?:fetch|XMLHttpRequest|WebSocket)\b/],
  ['remote executable URL', /(?:\b(?:import|importScripts)\s*\(?\s*["']https?:\/\/|<script\b[^>]*\bsrc\s*=\s*["']https?:\/\/|https?:\/\/[^\s"'`<>]+\.(?:m?js|cjs)(?:[?#][^\s"'`<>]*)?)/i],
  ['secret-bearing token, key, or password', /\b(?:api[_-]?key|access[_-]?token|auth(?:entication)?[_-]?token|client[_-]?secret|private[_-]?key|token|key|password|secret)\b\s*[:=]/i],
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArguments(argv) {
  if (argv.length !== 2 || !['--manifest', '--dist'].includes(argv[0])) {
    fail('usage: node scripts/verify-package.mjs --manifest PATH | --dist DIRECTORY');
  }

  return { mode: argv[0], path: argv[1] };
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

function validateManifest(manifest) {
  if (manifest.manifest_version !== 3) return 'manifest_version must be 3';
  if (!Array.isArray(manifest.permissions) || manifest.permissions.length !== allowedPermissions.length ||
    !allowedPermissions.every((permission) => manifest.permissions.includes(permission))) {
    return 'permissions must be exactly activeTab, scripting, storage';
  }
  if (!Array.isArray(manifest.host_permissions) || manifest.host_permissions.length !== 0) {
    return 'host_permissions must be exactly []';
  }
  if (Object.hasOwn(manifest, 'optional_host_permissions') &&
    (!Array.isArray(manifest.optional_host_permissions) || manifest.optional_host_permissions.length !== 0)) {
    return 'optional_host_permissions must be absent or exactly []';
  }
  const remoteExecutableError = findRemoteExecutableUrl(manifest);
  if (remoteExecutableError) return remoteExecutableError;
  const contentScriptMatches = manifest.content_scripts?.[0]?.matches;
  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length !== 1 ||
    !Array.isArray(contentScriptMatches) || contentScriptMatches.length !== allowedContentScriptMatches.length ||
    !allowedContentScriptMatches.every((match, index) => contentScriptMatches[index] === match) ||
    manifest.content_scripts[0]?.js?.length !== 1 || manifest.content_scripts[0].js[0] !== 'content.js') {
    return 'content_scripts must contain exactly the approved mock-demo content.js matches';
  }
  if (Object.hasOwn(manifest, 'optional_permissions') &&
    (!Array.isArray(manifest.optional_permissions) || manifest.optional_permissions.length !== 0)) {
    return 'optional_permissions must be absent or exactly []';
  }
  if (Object.hasOwn(manifest, 'externally_connectable')) return 'externally_connectable is not allowed';
  if (manifest.background?.service_worker) return 'background.service_worker is not allowed';

  return findRemoteExecutableUrl(manifest) ?? findUnsafeString(manifest);
}

function readManifest(manifestPath) {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`unable to read manifest: ${error.message}`);
  }
}

function runtimeAssets(directory) {
  const assets = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && runtimeAssetExtension.test(entry.name)) assets.push(entryPath);
    }
  };

  try {
    if (!statSync(directory).isDirectory()) fail(`dist path is not a directory: ${directory}`);
    visit(directory);
  } catch (error) {
    fail(`unable to read dist: ${error.message}`);
  }

  return assets;
}

function findForbiddenArtifactPattern(directory) {
  for (const asset of runtimeAssets(directory)) {
    const source = readFileSync(asset, 'utf8');
    for (const [label, pattern] of forbiddenArtifactPatterns) {
      if (pattern.test(source)) return `${asset} contains forbidden runtime pattern: ${label}`;
    }
  }

  return null;
}

const argument = parseArguments(process.argv.slice(2));
const manifestPath = argument.mode === '--dist' ? join(argument.path, 'manifest.json') : argument.path;
const manifest = readManifest(manifestPath);
const manifestError = validateManifest(manifest);
if (manifestError) fail(manifestError);

if (argument.mode === '--dist') {
  const artifactError = findForbiddenArtifactPattern(argument.path);
  if (artifactError) fail(`artifact policy check failed: ${artifactError}`);
  process.stdout.write('artifact policy check passed (static package policy only; does not prove all runtime behavior)\n');
} else {
  process.stdout.write('manifest contract passed\n');
}
