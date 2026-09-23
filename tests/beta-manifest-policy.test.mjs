// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { generateManifest } from '../scripts/build-manifest.mjs';

const repositoryRoot = resolve(process.cwd());
const betaPermissions = ['activeTab', 'scripting', 'storage'];
const betaCommands = { _execute_action: { suggested_key: { default: 'Ctrl+Shift+Y' } } };

function betaManifest() {
  return {
    manifest_version: 3,
    name: 'ClearChoice',
    version: '0.2.0',
    description: 'Private beta popup.',
    action: { default_popup: 'popup/index.html' },
    commands: structuredClone(betaCommands),
    permissions: [...betaPermissions],
    host_permissions: [],
  };
}

function assertBetaManifestPolicy(manifest) {
  expect(manifest.permissions).toEqual(betaPermissions);
  expect(manifest.commands).toEqual(betaCommands);
  expect(new Set(manifest.permissions)).toHaveLength(betaPermissions.length);
  expect(manifest.host_permissions).toEqual([]);
  expect(manifest).not.toHaveProperty('content_scripts');
  expect(manifest).not.toHaveProperty('optional_permissions');
  expect(manifest).not.toHaveProperty('optional_host_permissions');
  expect(manifest).not.toHaveProperty('background');
  expect(manifest).not.toHaveProperty('externally_connectable');
  expect(JSON.stringify(manifest)).not.toMatch(/<all_urls>|https?:\/\/|(?:import|importScripts)\s*\(?\s*["']https?:\/\//i);
}

test('accepts exactly the temporary active-tab private-beta permission shape', () => {
  assertBetaManifestPolicy(betaManifest());
});

test.each([
  ['missing activeTab', (manifest) => { manifest.permissions = ['scripting', 'storage']; }],
  ['missing scripting', (manifest) => { manifest.permissions = ['activeTab', 'storage']; }],
  ['forbidden tabs permission', (manifest) => { manifest.permissions.push('tabs'); }],
  ['forbidden webRequest permission', (manifest) => { manifest.permissions.push('webRequest'); }],
  ['forbidden cookies permission', (manifest) => { manifest.permissions.push('cookies'); }],
  ['forbidden declarativeNetRequest permission', (manifest) => { manifest.permissions.push('declarativeNetRequest'); }],
  ['duplicate permission', (manifest) => { manifest.permissions.push('storage'); }],
  ['optional permissions', (manifest) => { manifest.optional_permissions = ['tabs']; }],
  ['optional host permissions', (manifest) => { manifest.optional_host_permissions = ['https://example.test/*']; }],
  ['nonempty host permissions', (manifest) => { manifest.host_permissions = ['https://example.test/*']; }],
  ['all URLs host permission', (manifest) => { manifest.host_permissions = ['<all_urls>']; }],
  ['static content script', (manifest) => { manifest.content_scripts = [{ matches: ['https://example.test/*'], js: ['content.js'] }]; }],
  ['service worker', (manifest) => { manifest.background = { service_worker: 'worker.js' }; }],
  ['externally connectable', (manifest) => { manifest.externally_connectable = { matches: ['https://example.test/*'] }; }],
  ['remote executable', (manifest) => { manifest.background = { service_worker: 'https://example.test/worker.js' }; }],
])('rejects %s', (_label, mutate) => {
  const manifest = betaManifest();
  mutate(manifest);
  expect(() => assertBetaManifestPolicy(manifest)).toThrow();
});

test('source and generated manifests conform to the private-beta policy', () => {
  const sourceManifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'manifest.json'), 'utf8'));
  assertBetaManifestPolicy(sourceManifest);
  assertBetaManifestPolicy(generateManifest({ mode: 'release' }));
});
