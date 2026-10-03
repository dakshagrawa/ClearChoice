// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const currentBetaDocuments = ['README.md', 'PRIVACY.md', 'docs/architecture.md', 'docs/beta-scope.md', 'docs/threat-model.md', 'docs/beta-release-checklist.md'];

const officialChromeReferences = [
  'https://developer.chrome.com/docs/extensions/develop/concepts/activeTab',
  'https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts',
  'https://developer.chrome.com/docs/extensions/reference/api/scripting',
  'https://developer.chrome.com/docs/webstore/program-policies',
];

test('current beta documents exact opt-in permissions and screened local persistence', () => {
  for (const path of currentBetaDocuments) {
    const document = read(path);
    for (const term of ['0.4.0-beta.1', 'https://*/*', 'activeTab', 'Needs review', '30']) expect(document).toContain(term);
    expect(document).toMatch(/exact HTTPS origin/i);
    expect(document).toMatch(/no telemetry, accounts, or uploads/i);
    expect(document).toMatch(/never automatically confirms/i);
    expect(document).toMatch(/unreleased.*private opt-in beta.*not release-ready/i);
    expect(document).toMatch(/advisory-only/);
    expect(document).toMatch(/false positives and false negatives/);
    expect(document).not.toMatch(/does not automatically scan pages|popup receives only typed status|no automatic page scanning/i);
  }
});

test('transport, worker-owned records and popup DTOs have distinct responsibilities', () => {
  for (const path of currentBetaDocuments) {
    const document = read(path);
    expect(document).toMatch(/transport[^.]*screened excerpt[^.]*kind[^.]*reason[^.]*opaque fingerprint[^.]*occurrence ordinal/i);
    expect(document).toMatch(/version[^.]*request[^.]*authorization metadata/i);
    expect(document).toMatch(/worker derives[^.]*canonical origin[^.]*validated sender context/i);
    expect(document).toMatch(/worker owns[^.]*IDs[^.]*timestamps[^.]*review status/i);
    expect(document).toMatch(/popup[^.]*screened record fields[^.]*without[^.]*fingerprint[^.]*ordinal/i);
    expect(document).toMatch(/no raw URL paths, queries, selectors, HTML, or form values/i);
    expect(document).toMatch(/excludes typed input, textarea, select, and contenteditable values/i);
    expect(document).not.toMatch(/Only privacy-screened transport and screen DTOs.*leave the page/i);
  }
});

test('automatic and manual authorization differ and receipts replay without another write', () => {
  for (const path of ['docs/architecture.md', 'docs/threat-model.md']) {
    const document = read(path);
    expect(document).toMatch(/automatic submissions[^.]*grant generation[^.]*live optional permission[^.]*document challenge/i);
    expect(document).toMatch(/manual submissions[^.]*nonce[^.]*document[^.]*origin[^.]*active-tab authorization/i);
    expect(document).toMatch(/matching[^.]*same `requestId`[^.]*replays[^.]*prior outcome[^.]*without[^.]*write[^.]*timestamp update/i);
    expect(document).toMatch(/mismatched payload[^.]*collision[^.]*reject/i);
    expect(document).not.toMatch(/Receipt idempotency rejects duplicate submissions/i);
  }
});

test('current control labels and explicit subscription confirmation match the popup', () => {
  for (const path of currentBetaDocuments) {
    const document = read(path);
    for (const label of ['**Analyze**', '**Enable detection for this site**', '**Review as subscription**', '**Save subscription**', '**Mark reviewed**']) expect(document).toContain(label);
    expect(document).toMatch(/Review as subscription\*\* opens a draft/i);
    expect(document).toMatch(/Save subscription\*\* explicitly confirms[^.]*creates[^.]*local subscription/i);
    expect(document).toMatch(/automatic observation[^.]*Mark reviewed[^.]*do not confirm[^.]*subscription/i);
    expect(document).not.toMatch(/confirmation is separate from saving|\*\*Analyze this tab\*\*|\*\*Enable on this site\*\*|\*\*Save\*\*/i);
  }
});

test('privacy documents retention, subscriptions and user-initiated guide navigation', () => {
  const privacy = read('PRIVACY.md');
  for (const term of ['500', '7/30/90/Never', 'latestSeen', 'UTC', 'confirmed subscriptions', 'until you delete', 'screened excerpt', 'canonical origin', 'merchant', 'currency', 'cadence', 'notes', 'second HTTPS anchor click', 'Netflix', 'Spotify']) expect(privacy).toContain(term);
  expect(privacy).toMatch(/sensitive-looking static.*discarded whole/i);
  expect(privacy).toMatch(/no raw URL paths, queries, selectors, HTML, or form values/i);
  expect(privacy).toMatch(/deleting.*local.*does not cancel billing/i);
});

test('candidate evidence and checklist separate current blocked gate from historical release', () => {
  expect(read('docs/test-evidence.md')).toMatch(/v0\.2\.0.*historical/i);
  const evidence = read('docs/beta-candidate-test-evidence.md');
  const checklist = read('docs/beta-release-checklist.md');
  for (const document of [evidence, checklist]) {
    for (const term of ['0.4.0-beta.1', '`0.4.0`', 'actual marker schema', 'packaged manifest SHA-256', 'complete ZIP SHA-256']) expect(document).toContain(term);
    expect(document).toMatch(/existing archive.*no rebuild/i);
    expect(document).toMatch(/Task 16B.*pending/i);
    expect(document).toMatch(/not final-candidate proof/);
    expect(document).toContain('Schema 5');
    expect(document).toContain('do not establish human toolbar access or permission consent');
    expect(document).toMatch(/permission hang[^.]*resolved[^.]*exact mock-port seed/i);
    expect(document).toMatch(/persistence now pass genuine browser restart checks/i);
    expect(document).toMatch(/do not establish human toolbar access or permission consent/i);
    expect(document).not.toMatch(/permission-request diagnosis is not passing/i);
  }
  expect(evidence).toContain('9ff1b37a3ca8f1508d9cc4eb47e20669fcf65434');
  expect(evidence).toMatch(/0\.3\.0-beta\.1.*historical/i);
  expect(read('CHANGELOG.md')).toMatch(/0\.4\.0-beta\.1.*unreleased/i);
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

  expect(protocol).toMatch(/mock-only human QA protocol/i);
  expect(protocol).toMatch(/only the disposable Chromium profile and mock pages/i);
  expect(protocol).toMatch(/Never use your personal profile, real checkout, purchase, payment, cancellation or account page/i);
  expect(protocol).toMatch(/no human QA has been performed/i);
  expect(protocol).toMatch(/must not.*seed permissions to imitate consent/i);
  expect(template).toMatch(/voluntary and external/i);
  expect(template).toMatch(/no feedback collection by the extension/i);

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
  expect(readme).toMatch(/Contributors need Node \*\*24\*\*/);
  expect(readme).toMatch(/currently verified: \*\*Node 24\.21\.0\*\*/i);
  expect(read('.nvmrc').trim()).toBe('24');
  expect(JSON.parse(read('package.json')).engines.node).toBe('^24.0.0');
  expect(JSON.parse(read('package.json')).devDependencies['@types/node']).toMatch(/^24\./);
  expect(readme).toContain('2026-09-23');
  for (const url of officialChromeReferences) expect(readme).toContain(url);
});
