// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { generateManifest } from '../scripts/build-manifest.mjs';

const repositoryRoot = resolve(process.cwd());
const candidatePackageVersion = '1.0.0-rc.2';
const candidateChromeVersion = '1.0.0';
const chromeVersionPattern = /^\d+(?:\.\d+){0,3}$/;
const betaPermissions = ['activeTab', 'scripting', 'storage'];
const betaCommands = { _execute_action: { suggested_key: { default: 'Ctrl+Shift+Y' } } };

function betaManifest() {
  return {
    manifest_version: 3,
    name: 'ClearChoice',
    version: candidateChromeVersion,
    version_name: candidatePackageVersion,
    description: 'Private beta popup.',
    action: { default_popup: 'popup/index.html' },
    commands: structuredClone(betaCommands),
    permissions: [...betaPermissions],
    host_permissions: [],
    optional_host_permissions: ['https://*/*'],
    background: { service_worker: 'worker.js' },
  };
}

function assertBetaManifestPolicy(manifest) {
  expect(manifest.version).toMatch(chromeVersionPattern);
  expect(manifest.version).toBe(candidateChromeVersion);
  expect(manifest.version_name).toBe(candidatePackageVersion);
  expect(manifest.permissions).toEqual(betaPermissions);
  expect(manifest.commands).toEqual(betaCommands);
  expect(new Set(manifest.permissions)).toHaveLength(betaPermissions.length);
  expect(manifest.host_permissions).toEqual([]);
  expect(manifest).not.toHaveProperty('content_scripts');
  expect(manifest).not.toHaveProperty('optional_permissions');
  expect(manifest.optional_host_permissions).toEqual(['https://*/*']);
  expect(manifest.background).toEqual({ service_worker: 'worker.js' });
  expect(manifest).not.toHaveProperty('externally_connectable');
  expect(JSON.stringify(manifest)).not.toMatch(/<all_urls>|(?:import|importScripts)\s*\(?\s*["']https?:\/\//i);
}

test('accepts exactly the temporary active-tab private-beta permission shape', () => {
  assertBetaManifestPolicy(betaManifest());
});

test('Chrome manifest version rejects prerelease strings while version_name carries the beta display identity', () => {
  expect('0.4.0-beta.1').not.toMatch(chromeVersionPattern);
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
  ['unrelated optional origin', (manifest) => { manifest.optional_host_permissions = ['https://example.test/*']; }],
  ['all URLs optional origin', (manifest) => { manifest.optional_host_permissions = ['<all_urls>']; }],
  ['HTTP optional origin', (manifest) => { manifest.optional_host_permissions = ['http://*/*']; }],
  ['additional optional origin', (manifest) => { manifest.optional_host_permissions.push('https://example.test/*'); }],
  ['missing optional origin', (manifest) => { delete manifest.optional_host_permissions; }],
  ['nonempty host permissions', (manifest) => { manifest.host_permissions = ['https://example.test/*']; }],
  ['all URLs host permission', (manifest) => { manifest.host_permissions = ['<all_urls>']; }],
  ['static content script', (manifest) => { manifest.content_scripts = [{ matches: ['https://example.test/*'], js: ['content.js'] }]; }],
  ['wrong service worker', (manifest) => { manifest.background = { service_worker: 'other.js' }; }],
  ['additional background capability', (manifest) => { manifest.background.type = 'module'; }],
  ['externally connectable', (manifest) => { manifest.externally_connectable = { matches: ['https://example.test/*'] }; }],
  ['remote executable', (manifest) => { manifest.background = { service_worker: 'https://example.test/worker.js' }; }],
])('rejects %s', (_label, mutate) => {
  const manifest = betaManifest();
  mutate(manifest);
  expect(() => assertBetaManifestPolicy(manifest)).toThrow();
});

test('source and generated manifests conform to the private-beta policy', () => {
  const sourceManifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'manifest.json'), 'utf8'));
  const sourcePackage = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
  assertBetaManifestPolicy(sourceManifest);
  const generatedManifest = generateManifest({ mode: 'release' });
  assertBetaManifestPolicy(generatedManifest);
  expect(sourcePackage.version).toBe(candidatePackageVersion);
  expect(sourceManifest.version).toBe(candidateChromeVersion);
  expect(sourceManifest.version_name).toBe(candidatePackageVersion);
  expect(generatedManifest.version).toBe(candidateChromeVersion);
  expect(generatedManifest.version_name).toBe(candidatePackageVersion);
});
