// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const root = process.cwd();
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

  for (const document of [readme, privacy, threatModel]) {
    expect(document).toContain('private opt-in beta');
    expect(document).toContain('0.3.0-beta.1');
    expect(document).toMatch(/temporary.*activeTab.*access/i);
    expect(document).toMatch(/no persistent host access/i);
    expect(document).toMatch(/all page data (stays )?local/i);
    expect(document).toMatch(/no telemetry, accounts, or uploads/i);
    expect(document).toMatch(/advisory[- ]only/i);
  }

  expect(readme).toMatch(/Chrome Web Store.*future separate work.*not complete/i);
  expect(privacy).toMatch(/sensitive-looking static.*discarded whole/i);
  expect(threatModel).toMatch(/sensitive-looking static.*discarded whole/i);
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

test('documentation preserves the archived v0.2.0 mock prototype and official references', () => {
  const readme = read('README.md');
  const checklist = read('docs/beta-release-checklist.md');
  const changelog = read('CHANGELOG.md');

  for (const document of [readme, checklist, changelog]) {
    expect(document).toMatch(/v0\.2\.0.*archived mock-only localhost fixture prototype/i);
    expect(document).toContain('https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.2.0');
  }

  expect(readme).toMatch(/Node\s+\**22\.12\+\**/);
  expect(readme).toMatch(/current verified (version is )?\**Node 22\.23\.2\**/i);
  expect(readme).toContain('2026-09-23');
  for (const url of officialChromeReferences) expect(readme).toContain(url);
});
