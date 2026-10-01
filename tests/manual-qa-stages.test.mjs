// @vitest-environment node
import { expect, test } from 'vitest';
import { WORKFLOW_PREDICATES } from '../scripts/active-tab-qa.mjs';
import { createManualActiveTabQaMarker } from '../scripts/manual-active-tab-qa.mjs';
import { runHumanStage, runWithCleanup, observeCleanState } from '../scripts/manual-qa-stages.mjs';

test('exact clean readback rejects nested arrays and malformed storage rather than ignoring it', async () => {
  for (const state of [{ localState: { version: 1, reviewHistory: [{}], subscriptions: [] } },
    { version: 1, reviewHistory: {}, subscriptions: [] }, { version: 2, reviewHistory: [], subscriptions: [] },
    { version: 1, reviewHistory: [], subscriptions: [], grantState: { version: 1, sites: { bad: {} } } },
    { subscriptions: [], reviewHistory: [] }, { dismissed: 'false' }, { receipts: [] },
    null, [], { version: 1, subscriptions: [], reviewHistory: [], receipts: [{}] },
    { version: 1, subscriptions: [], reviewHistory: [], retentionPolicy: {} }]) {
    await expect(observeCleanState(cleanApi(state), 'capture', 'https://checkout-a.test:123/checkout/clean', {})).rejects.toThrow('clean storage schema');
  }
});

function cleanApi(state) {
  return {
    storage: { local: { get: async () => state } },
    permissions: { getAll: async () => ({ origins: [] }) },
    scripting: { getRegisteredContentScripts: async () => [] },
    tabs: { query: async () => [{ id: 7, url: 'https://checkout-a.test:123/checkout/clean' }] },
    action: { getBadgeText: async ({ tabId }) => { expect(tabId).toBe(7); return ''; } },
  };
}

test('pristine and genuine initialized schemas yield only predicates and counts', async () => {
  for (const state of [{}, { dismissed: false }, { version: 1, reviewHistory: [], subscriptions: [], retentionPolicy: 30, receipts: [], grantState: { version: 1, sites: {} } }]) {
    const host = {};
    const api = cleanApi(state);
    const url = 'https://checkout-a.test:123/checkout/clean';
    const before = await observeCleanState(api, 'capture', url, host);
    const after = await observeCleanState(api, 'compare', url, host);
    expect(after).toEqual(before);
    expect(after).toEqual({ storageValid: true, historyCount: 0, subscriptionCount: 0, unchanged: true, permissionCount: 0, scriptCount: 0, grantCount: 0, badgeBlank: true });
    expect(Object.values(after).every((value) => typeof value === 'boolean' || typeof value === 'number')).toBe(true);
    state.reviewHistory = [{}];
    await expect(observeCleanState(api, 'compare', url, host)).rejects.toThrow();
  }
});

test('browser predicates use genuine API results and fail closed on missing baseline or tab drift', async () => {
  const api = cleanApi({});
  const host = {};
  const url = 'https://checkout-a.test:123/checkout/clean';
  await expect(observeCleanState(api, 'compare', url, host)).rejects.toThrow();
  await observeCleanState(api, 'capture', url, host);
  api.permissions.getAll = async () => ({ origins: ['https://checkout-a.test/*'] });
  api.scripting.getRegisteredContentScripts = async () => [{ id: 'unexpected' }];
  api.action.getBadgeText = async () => '1';
  expect(await observeCleanState(api, 'compare', url, host)).toMatchObject({ permissionCount: 1, scriptCount: 1, badgeBlank: false });
  api.tabs.query = async () => [{ id: 8, url }];
  await expect(observeCleanState(api, 'compare', url, host)).rejects.toThrow('browser readback unavailable');
  api.tabs.query = async () => [{ id: 7, url: 'https://checkout-a.test:123/other' }];
  await expect(observeCleanState(api, 'compare', url, host)).rejects.toThrow('browser readback unavailable');
});

test('cleanup preserves setup or workflow failure and attempts every closer exactly once', async () => {
  for (const phase of ['setup', 'workflow', 'archive']) {
    const primary = new Error(phase);
    const events = [];
    await expect(runWithCleanup(async () => { throw primary; }, [
      async () => { events.push('browser'); throw new Error('close failed'); },
      async () => { events.push('candidate'); throw new Error('candidate cleanup failed'); },
      async () => { events.push('tls'); },
    ])).rejects.toBe(primary);
    expect(events).toEqual(['browser', 'candidate', 'tls']);
  }
});

test('cleanup-only failure is surfaced rather than silently discarded', async () => {
  const failure = new Error('candidate cleanup failed');
  await expect(runWithCleanup(async () => true, [async () => { throw failure; }])).rejects.toBe(failure);
});

const candidate = { commit: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), archiveSha256: 'c'.repeat(64) };
const results = () => Object.fromEntries(WORKFLOW_PREDICATES.map((name) => [name, name === 'accessibility' ? true : 'passed']));

test('marker constructor cannot manufacture passed workflow results', () => {
  expect(() => createManualActiveTabQaMarker(candidate)).toThrow();
  for (const name of WORKFLOW_PREDICATES) {
    const incomplete = results();
    delete incomplete[name];
    expect(() => createManualActiveTabQaMarker(candidate, incomplete)).toThrow();
  }
  expect(() => createManualActiveTabQaMarker(candidate, { ...results(), url: 'https://fixture.test' })).toThrow();
  expect(createManualActiveTabQaMarker(candidate, results()).schemaVersion).toBe(4);
});

test('stage does not advance until the observation and explicit acknowledgement both pass', async () => {
  let observe;
  let acknowledge;
  const events = [];
  const run = runHumanStage({
    instruction: 'Perform one action.',
    instruct: (text) => events.push(text),
    observe: () => new Promise((resolve) => { observe = resolve; }),
    acknowledge: () => new Promise((resolve) => { events.push('ack'); acknowledge = resolve; }),
  });
  await Promise.resolve();
  expect(events).toEqual(['Perform one action.']);
  observe(true);
  await Promise.resolve();
  expect(events).toEqual(['Perform one action.', 'ack']);
  acknowledge('DONE');
  await expect(run).resolves.toBe(true);
});

test('a rejected observation or acknowledgement cannot pass a stage', async () => {
  for (const [observed, ack] of [[false, 'DONE'], [true, ''], [true, 'ATTEST']]) {
    await expect(runHumanStage({ instruction: 'Act.', instruct: () => {}, observe: async () => observed, acknowledge: async () => ack })).rejects.toThrow();
  }
});
