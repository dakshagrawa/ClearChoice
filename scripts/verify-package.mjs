import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const allowedPermissions = ['activeTab', 'scripting', 'storage'];
const secretManifestKeys = new Set(['api_key', 'apiKey', 'token', 'secret', 'password']);
const executableManifestKeys = new Set(['service_worker', 'js']);
const runtimeAssetExtension = /\.(?:css|html|js|mjs|cjs|json)$/i;
const forbiddenArtifactPatterns = [
  ['network API', /\b(?:fetch|XMLHttpRequest|WebSocket)\b/],
  ['beacon API', /\bnavigator\s*\.\s*sendBeacon\s*\(/],
  ['EventSource construction', /\bnew\s+EventSource\s*\(/],
  ['Worker construction', /\bnew\s+(?:Shared)?Worker\s*\(/],
  ['dynamic import', /\bimport\s*\(/],
  ['external HTML or CSS URL', /(?:\b(?:src|href|action|formaction|poster)\s*=\s*["']?\s*|\burl\s*\(\s*["']?)(?:https?:)?\/\//i],
  ['external HTML srcset URL', /\bsrcset\s*=\s*(?:"[^"]*|'[^']*|[^\s>]*)(?:https?:)?\/\//i],
  ['external DOM URL sink', /(?:\b(?:window\s*\.\s*)?location(?:\s*\.\s*href)?\s*=\s*["'`]|\b(?:window\s*\.\s*)?location\s*\.\s*(?:assign|replace)\s*\(\s*["'`]|(?:\.\s*(?:href|src|action|formAction)|\[\s*["'](?:href|src|action|formAction)["']\s*\])\s*=\s*["'`]|\.\s*setAttribute\s*\(\s*["'](?:href|src|action|formaction)["']\s*,\s*["'`])(?:https?:)?\/\//i],
  ['remote executable URL', /(?:\b(?:import|importScripts)\s*\(?\s*["']https?:\/\/|<script\b[^>]*\bsrc\s*=\s*["']https?:\/\/|https?:\/\/[^\s"'`<>]+\.(?:m?js|cjs)(?:[?#][^\s"'`<>]*)?)/i],
  ['secret-bearing token, key, or password', /\b(?:api[_-]?key|access[_-]?token|auth(?:entication)?[_-]?token|client[_-]?secret|private[_-]?key|token|key|password|secret)\b\s*[:=]/i],
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArguments(argv) {
  if (argv.length !== 2 || !['--manifest', '--dist', '--zip'].includes(argv[0])) {
    fail('usage: node scripts/verify-package.mjs --manifest PATH | --dist DIRECTORY | --zip ARCHIVE');
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
        for (const executableUrl of (Array.isArray(item) ? item : [item])) {
          if (typeof executableUrl === 'string' && /^https?:\/\//i.test(executableUrl)) return `${itemPath} contains a remote executable URL`;
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
    !allowedPermissions.every((permission, index) => manifest.permissions[index] === permission) ||
    new Set(manifest.permissions).size !== manifest.permissions.length) {
    return 'permissions must be exactly activeTab, scripting, storage in that order without duplicates';
  }
  if (!Array.isArray(manifest.host_permissions) || manifest.host_permissions.length !== 0) return 'host_permissions must be exactly []';
  const remoteExecutableError = findRemoteExecutableUrl(manifest);
  if (remoteExecutableError) return remoteExecutableError;
  if (Object.hasOwn(manifest, 'optional_permissions')) return 'optional_permissions is not allowed';
  if (Object.hasOwn(manifest, 'optional_host_permissions')) return 'optional_host_permissions is not allowed';
  if (Object.hasOwn(manifest, 'content_scripts')) return 'content_scripts is not allowed';
  if (Object.hasOwn(manifest, 'background')) return 'background is not allowed';
  if (Object.hasOwn(manifest, 'externally_connectable')) return 'externally_connectable is not allowed';
  return findRemoteExecutableUrl(manifest) ?? findUnsafeString(manifest);
}

function directoryAssets(directory) {
  const assets = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && runtimeAssetExtension.test(entry.name)) assets.push([entryPath, readFileSync(entryPath, 'utf8')]);
    }
  };
  try {
    if (!statSync(directory).isDirectory()) fail(`dist path is not a directory: ${directory}`);
    visit(directory);
  } catch (error) { fail(`unable to read dist: ${error.message}`); }
  return assets;
}

function archiveAssets(archive) {
  try {
    const names = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    if (!names.includes('manifest.json')) fail('ZIP does not contain manifest.json at its root');
    if (names.some((name) => name.startsWith('dist/'))) fail('ZIP must not wrap files in dist/');
    return names.filter((name) => runtimeAssetExtension.test(name)).map((name) => [name, execFileSync('unzip', ['-p', archive, name], { encoding: 'utf8' })]);
  } catch (error) { fail(`unable to read ZIP: ${error.message}`); }
}

function findForbiddenArtifactPattern(assets) {
  for (const [path, source] of assets) {
    for (const [label, pattern] of forbiddenArtifactPatterns) {
      if (pattern.test(source)) return `${path} contains forbidden runtime pattern: ${label}`;
    }
  }
  return null;
}

const argument = parseArguments(process.argv.slice(2));
const isDist = argument.mode === '--dist';
const isZip = argument.mode === '--zip';
const assets = isDist ? directoryAssets(argument.path) : isZip ? archiveAssets(argument.path) : [];
const manifestSource = isDist ? assets.find(([path]) => path.endsWith('/manifest.json'))?.[1]
  : isZip ? assets.find(([path]) => path === 'manifest.json')?.[1]
    : readFileSync(argument.path, 'utf8');
if (!manifestSource) fail('manifest.json is missing');
let manifest;
try { manifest = JSON.parse(manifestSource); } catch (error) { fail(`unable to read manifest: ${error.message}`); }
const manifestError = validateManifest(manifest);
if (manifestError) fail(manifestError);
if (isDist || isZip) {
  const artifactError = findForbiddenArtifactPattern(assets);
  if (artifactError) fail(`artifact policy check failed: ${artifactError}`);
  process.stdout.write(`artifact policy check passed (${isZip ? 'ZIP' : 'dist'}; static package policy only; does not prove all runtime behavior)\n`);
} else process.stdout.write('manifest contract passed\n');
