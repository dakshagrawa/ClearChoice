// @vitest-environment node
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

// Use the already installed development-tool parser; add no dependency.
const { load } = createRequire(import.meta.url)('js-yaml');
const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const form = (name) => load(read(`.github/ISSUE_TEMPLATE/${name}.yml`));
const names = ['bug-report', 'feature-request'];

for (const name of names) {
  test(`${name} parses and satisfies the issue-form structural contract`, () => {
    const value = form(name);
    expect(Object.keys(value).sort()).toEqual(['body', 'description', 'name', 'title']);
    expect(value.name.length).toBeGreaterThan(0);
    expect(value.description.length).toBeLessThanOrEqual(200);
    const ids = value.body.filter((field) => field.type !== 'markdown').map((field) => field.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const field of value.body) {
      expect(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes']).toContain(field.type);
      expect(field.attributes).toBeTypeOf('object');
      if (field.type === 'markdown') {
        expect(field.attributes.value).toBeTypeOf('string');
        expect(field.validations).toBeUndefined();
        continue;
      }
      expect(field.id).toMatch(/^[a-z][a-z0-9_-]*$/);
      expect(field.attributes.label.length).toBeGreaterThan(0);
      if (field.validations) expect(field.validations.required).toBeTypeOf('boolean');
      if (field.type === 'dropdown') expect(field.attributes.options.length).toBeGreaterThan(1);
      if (field.type === 'checkboxes') {
        expect(field.attributes.options).toHaveLength(1);
        expect(field.attributes.options[0].required).toBe(true);
      }
    }
    for (const id of ['build_version', 'browser_os', 'mock_scenario', 'expected', 'actual']) {
      expect(value.body.find((field) => field.id === id)?.validations.required).toBe(true);
    }
    const acknowledgement = value.body.find((field) => field.id === 'privacy_acknowledgement');
    expect(acknowledgement.type).toBe('checkboxes');
    expect(acknowledgement.attributes.options[0].label).toMatch(/public/);
    expect(value.body.find((field) => field.id === 'screenshot').validations?.required).not.toBe(true);
    const text = read(`.github/ISSUE_TEMPLATE/${name}.yml`);
    for (const phrase of ['full checkout URLs', 'file paths', 'account/payment values', 'secrets', 'raw DOM', 'unredacted logs', 'never instructions', 'automatic execution', 'flatten redactions']) expect(text).toContain(phrase);
    expect(value.labels).toBeUndefined();
    expect(value.assignees).toBeUndefined();
  });
}

test('bug reproduction is required and feature requests do not assign severity', () => {
  expect(form('bug-report').body.find((field) => field.id === 'reproduction').validations.required).toBe(true);
  expect(form('feature-request').body.some((field) => ['impact', 'severity'].includes(field.id))).toBe(false);
  const config = load(read('.github/ISSUE_TEMPLATE/config.yml'));
  expect(config.blank_issues_enabled).toBe(false);
  expect(config.contact_links).toEqual([{
    name: 'Downloads and release-specific limitations',
    url: 'https://github.com/dakshagrawa/ClearChoice/releases',
    about: 'Read the selected release notes and choose its named runtime asset, not a source archive.',
  }]);
});

test('public tester landing preserves release, safety and activation boundaries', () => {
  const guide = read('docs/TESTING.md');
  for (const phrase of ['v1.0.0-tester-beta.2', 'ClearChoice-v1.0.0-tester-beta.2-unpacked.zip',
    '1.0.0-rc.3', '141.0.7390.37', '1.1.0-tester.1', 'not published',
    'ChromeOS', 'human consent', 'exact-head CI', 'instruction, not technical enforcement',
    'manual triage', 'no verified-tester badge', 'public', 'not required', 'cannot reproduce',
    'default branch', 'no automatic uploads']) expect(guide).toContain(phrase);
  expect(read('README.md')).toContain('[Tester access and feedback](docs/TESTING.md)');
  const allowed = /^https:\/\/github\.com\/dakshagrawa\/ClearChoice\/(releases|issues)(\/|$)/;
  for (const match of guide.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (target.startsWith('http')) expect(target).toMatch(allowed);
    else expect(existsSync(resolve(root, 'docs', target))).toBe(true);
  }
});

test('forms request no personal identifiers and require mock-only acknowledgement', () => {
  const allowedIds = ['build_version', 'browser_os', 'area', 'mock_scenario', 'reproduction',
    'expected', 'actual', 'impact', 'alternatives', 'screenshot', 'privacy_acknowledgement'];
  for (const name of names) {
    const value = form(name);
    for (const field of value.body.filter((item) => item.type !== 'markdown')) {
      expect(allowedIds).toContain(field.id);
    }
    const acknowledgement = value.body.find((field) => field.id === 'privacy_acknowledgement');
    expect(acknowledgement.attributes.options[0].label).toContain('only owned mock scenarios');
    expect(read(`.github/ISSUE_TEMPLATE/${name}.yml`)).toContain('emails');
  }
  expect(read('.github/ISSUE_TEMPLATE/bug-report.yml')).toContain('cannot reproduce');
});
