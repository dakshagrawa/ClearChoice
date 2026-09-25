// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const officialChromeReferences = [
  'https://developer.chrome.com/docs/extensions/develop/concepts/activeTab',
  'https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts',
  'https://developer.chrome.com/docs/extensions/reference/api/scripting',
  'https://developer.chrome.com/docs/webstore/program-policies',
];

test('beta documentation states the private opt-in scope and local data boundary', () => {
  const readme = read('README.md');
  const privacy = read('PRIVACY.md');
  const threatModel = read('docs/threat-model.md');
  const checklist = read('docs/beta-release-checklist.md');

  for (const document of [readme, privacy, threatModel, checklist]) {
    expect(document).toContain('private opt-in beta');
    expect(document).toContain('0.3.0-beta.1');
    expect(document).toMatch(/temporary.*activeTab.*access/i);
    expect(document).toMatch(/no persistent host access/i);
    expect(document).toMatch(/all page data (stays )?local/i);
    expect(document).toMatch(/no telemetry, accounts, or uploads/i);
    expect(document).toMatch(/advisory[- ]only/i);
    expect(document).not.toMatch(/is a production-ready.*private opt-in beta/i);
    expect(document).toMatch(/production-ready.*target|target.*production-ready/i);
    expect(document).toMatch(/readiness remains pending|required.*checklist.*gate.*completion/i);
  }

  expect(readme).toMatch(/check:beta.*real external human activeTab QA marker/i);
  expect(checklist).toMatch(/readiness is pending.*deliberate human activeTab QA marker.*passing `npm run check:beta`/i);
  for (const document of [privacy, threatModel]) {
    expect(document).toMatch(/final human activeTab QA marker remains required/i);
    expect(document).toMatch(/check:beta.*must pass before readiness can be claimed/i);
  }
  expect(readme).toMatch(/Chrome Web Store.*future separate work.*not complete/i);
  expect(privacy).toMatch(/sensitive-looking static.*discarded whole/i);
  expect(threatModel).toMatch(/sensitive-looking static.*discarded whole/i);
});

test('changelog qualifies beta readiness as pending the human marker and beta gate', () => {
  const changelog = read('CHANGELOG.md');

  expect(changelog).not.toMatch(/Documented the production-ready private opt-in beta boundary/i);
  expect(changelog).toMatch(/production-ready private opt-in beta target/i);
  expect(changelog).toMatch(/pending.*deliberate human activeTab QA marker.*passing `npm run check:beta`/i);
});

test('evidence separates the historical v0.2.0 artifact from the untagged beta candidate', () => {
  const historicalEvidence = read('docs/test-evidence.md');
  const candidateEvidence = read('docs/beta-candidate-test-evidence.md');
  const checklist = read('docs/beta-release-checklist.md');

  expect(historicalEvidence).toMatch(/v0\.2\.0.*historical/i);
  expect(candidateEvidence).toMatch(/0\.3\.0-beta\.1/);
  expect(candidateEvidence).toMatch(/untagged.*QA candidate/i);
  expect(candidateEvidence).toMatch(/awaiting.*real human.*toolbar-click.*popup/i);
  expect(candidateEvidence).toMatch(/Chrome.*numeric.*`0\.3\.0`/i);
  expect(candidateEvidence).toMatch(/version_name.*`0\.3\.0-beta\.1`/i);
  expect(checklist).toMatch(/Chrome.*numeric.*`0\.3\.0`/i);
  expect(checklist).toMatch(/version_name.*`0\.3\.0-beta\.1`/i);
  expect(candidateEvidence).not.toMatch(/check:beta.*passed/i);
  expect(checklist).toMatch(/untagged.*QA candidate.*awaiting.*real human/i);
});

test('rule catalog documents supported use and heuristic limitations', () => {
  const catalog = read('docs/rule-catalog.md');

  expect(catalog).toContain('English consumer checkout');
  expect(catalog).toMatch(/false positives/i);
  expect(catalog).toMatch(/false negatives/i);
  expect(catalog).toMatch(/advisory[- ]only/i);
  expect(catalog).toMatch(/not.*conclusion.*deceptive/i);
  expect(catalog).toMatch(/not.*conclusion.*legal/i);
});

test('tester protocol limits voluntary sanitized external feedback', () => {
  const protocol = read('docs/beta-test-protocol.md');
  const template = read('docs/beta-feedback-template.md');

  expect(protocol).toMatch(/own Chromium profile/i);
  expect(protocol).toMatch(/independently selected page/i);
  expect(protocol).toMatch(/do not make purchases/i);
  expect(protocol).toMatch(/do not submit or enter payment/i);
  expect(protocol).toMatch(/restricted\/unsupported pages/i);
  expect(protocol).toMatch(/visible text/i);
  expect(protocol).toMatch(/voluntary/i);
  expect(protocol).toMatch(/no feedback collection by the extension/i);

  for (const prohibitedItem of ['URLs', 'screenshots', 'personal', 'address', 'card', 'order', 'receipt', 'page content']) {
    expect(template).toContain(prohibitedItem);
  }
  expect(template).toMatch(/Rule.*Expected.*Actual.*Browser/is);
});

test('executes the documented fail-closed beta command without forging a marker', () => {
  const env = { ...process.env };
  delete env.CLEARCHOICE_ACTIVE_TAB_QA_MARKER;

  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'check:beta', '--', '--validate-marker-only'], {
    cwd: root,
    encoding: 'utf8',
    env,
  });

  expect(env.CLEARCHOICE_ACTIVE_TAB_QA_MARKER).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.signal).toBeNull();
  expect(result.stderr.trimEnd().split('\n').at(-1)).toBe('check:beta failed: CLEARCHOICE_ACTIVE_TAB_QA_MARKER must point to a deliberate local manual-QA marker');
});

function readPeeledTagContract(tag) {
  const historicalCommit = execFileSync('git', ['rev-parse', `${tag}^{}`], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const taggedManifest = JSON.parse(execFileSync('git', ['show', `${historicalCommit}:manifest.json`], {
    cwd: root,
    encoding: 'utf8',
  }));
  const taggedPackage = JSON.parse(execFileSync('git', ['show', `${historicalCommit}:package.json`], {
    cwd: root,
    encoding: 'utf8',
  }));

  return { taggedManifest, taggedPackage };
}

test('retrieves the preserved v0.2.0 mock-only localhost contract from the peeled local tag', () => {
  const { taggedManifest, taggedPackage } = readPeeledTagContract('v0.2.0');

  expect(taggedPackage.name).toBe('clearchoice');
  expect(taggedPackage.version).toBe('0.2.0');
  expect(taggedPackage.private).toBe(true);
  expect(taggedManifest.version).toBe('0.2.0');
  expect(taggedManifest.host_permissions).toEqual([]);
  expect(taggedManifest.permissions).toEqual(['storage']);
  expect(taggedManifest.content_scripts).toEqual([{
    matches: ['http://127.0.0.1/*'],
    js: ['content.js'],
  }]);
});

test('retrieves the preserved v0.1.0 mock-only localhost contract from the peeled local tag', () => {
  const { taggedManifest, taggedPackage } = readPeeledTagContract('v0.1.0');

  expect(taggedPackage.name).toBe('clearchoice');
  expect(taggedPackage.version).toBe('0.1.0');
  expect(taggedPackage.private).toBe(true);
  expect(taggedManifest.version).toBe('0.1.0');
  expect(taggedManifest.host_permissions).toEqual([]);
  expect(taggedManifest.permissions).toEqual(['activeTab', 'scripting', 'storage']);
  expect(taggedManifest.content_scripts).toEqual([{
    matches: ['http://127.0.0.1/*'],
    js: ['content.js'],
  }]);
});

test('final v1 scope matches the peeled v0.2.0 contract and distinguishes beta architecture', () => {
  const scope = read('docs/final-v1-scope.md');
  const { taggedManifest, taggedPackage } = readPeeledTagContract('v0.2.0');

  expect(taggedPackage.version).toBe('0.2.0');
  expect(scope).toContain(`v${taggedManifest.version}`);
  expect(scope).toMatch(/only `storage`/i);
  expect(scope).toMatch(/static content script/i);
  expect(scope).toContain('`http://127.0.0.1/*`');
  expect(scope).toMatch(/superseding.*beta.*`activeTab`, `scripting`, and `storage`/is);
  expect(scope).toMatch(/no static content scripts/i);
});

test('documentation preserves both archived mock-only prototypes and official references', () => {
  const readme = read('README.md');
  const checklist = read('docs/beta-release-checklist.md');
  const changelog = read('CHANGELOG.md');
  const scope = read('docs/final-v1-scope.md');
  const betaScope = read('docs/beta-scope.md');
  const releaseChecklist = read('docs/release-checklist.md');

  for (const document of [readme, checklist, changelog, scope, betaScope, releaseChecklist]) {
    expect(document).toMatch(/v0\.1\.0.*archiv(?:ed|al).*mock-only/i);
    expect(document).toMatch(/v0\.2\.0.*archiv(?:ed|al).*mock-only/i);
    expect(document).toContain('https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.1.0');
    expect(document).toContain('https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.2.0');
    expect(document).toMatch(/not beta/i);
  }

  expect(readme).toMatch(/Sign in to GitHub.*invited collaborator/i);
  expect(readme).toMatch(/ask the repository owner to grant repository access/i);
  expect(readme).toMatch(/chrome:\/\/extensions/i);
  expect(readme).toMatch(/Developer mode/i);
  expect(readme).toMatch(/Load unpacked/i);
  expect(readme).toMatch(/contains `manifest\.json`/i);
  expect(readme).toMatch(/check out that tag, run `npm ci`, then run `npm run serve:fixtures`/i);
  expect(readme).toMatch(/Do not load it on third-party checkout pages/i);
  expect(readme).toMatch(/Node\s+\**22\.12\+\**/);
  expect(readme).toMatch(/current verified (version is )?\**Node 22\.23\.2\**/i);
  expect(readme).toContain('2026-09-23');
  for (const url of officialChromeReferences) expect(readme).toContain(url);
});
