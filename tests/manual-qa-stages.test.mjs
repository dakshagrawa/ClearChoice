// @vitest-environment node
import { expect, test } from 'vitest';
import { WORKFLOW_PREDICATES } from '../scripts/active-tab-qa.mjs';
import { createManualActiveTabQaMarker } from '../scripts/manual-active-tab-qa.mjs';
import { runHumanStage, runWithCleanup, observeCleanState, observeSiteState, waitForObservation } from '../scripts/manual-qa-stages.mjs';

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

test('site readback binds exact permission, grant and script; revoke preserves records without creating subscriptions', async () => {
  const origin = 'https://checkout-a.test:123';
  const state = { version: 1, reviewHistory: [], subscriptions: [{ id: 'fake-confirmed' }], grantState: { version: 1, sites: {} } };
  const api = cleanApi(state);
  const host = {};
  await observeSiteState(api, 'baseline', origin, host);
  api.tabs.query = async () => [{ id: 7 }];
  expect((await observeSiteState(api, 'enabled', origin, host)).passed).toBe(false);
  api.tabs.query = async () => [{ id: 7, url: origin + '/checkout/clean' }];
  api.permissions.getAll = async () => ({ origins: [origin + '/*'] });
  api.permissions.contains = async () => true;
  state.grantState.sites[origin] = { enabled: true, generation: 1 };
  const script = { id: 'clearchoice-site-b93005a526dc3134fdd360798aad3e73fbb20a3d50c16ebe605a4d4947098925', matches: [origin + '/*'], js: ['content.js'], allFrames: false, persistAcrossSessions: true, world: 'ISOLATED' };
  api.scripting.getRegisteredContentScripts = async () => [script];
  expect((await observeSiteState(api, 'enabled', origin, host)).passed).toBe(true);
  state.grantState.sites[origin].generation = 0;
  expect((await observeSiteState(api, 'enabled', origin, host)).passed).toBe(false);
  state.grantState.sites[origin].generation = 1;
  api.permissions.getAll = async () => ({ origins: ['https://checkout-b.test:123/*'] });
  expect((await observeSiteState(api, 'enabled', origin, host)).passed).toBe(false);
  api.permissions.getAll = async () => ({ origins: [origin + '/*'] });
  state.subscriptions.push({ id: 'unwanted-auto-created' });
  expect((await observeSiteState(api, 'enabled', origin, host)).passed).toBe(false);
  state.subscriptions.pop();
  script.world = 'MAIN';
  expect((await observeSiteState(api, 'enabled', origin, host)).passed).toBe(false);
  script.world = 'ISOLATED';
  state.reviewHistory.push({ origin, kind: 'recurring-charge', id: 'fake-observation' });
  api.action.getBadgeText = async () => '1';
  expect((await observeSiteState(api, 'positive', origin, host)).passed).toBe(true);
  await observeSiteState(api, 'before-revoke', origin, host);
  expect((await observeSiteState(api, 'revoked', origin, host)).passed).toBe(false);
  state.grantState.sites[origin] = { enabled: false, generation: 2 };
  api.permissions.getAll = async () => ({ origins: [] });
  api.permissions.contains = async () => false;
  api.scripting.getRegisteredContentScripts = async () => [];
  api.action.getBadgeText = async () => '';
  expect((await observeSiteState(api, 'revoked', origin, host)).passed).toBe(true);
  state.reviewHistory.push({ origin, kind: 'recurring-charge' });
  expect((await observeSiteState(api, 'revoked', origin, host)).passed).toBe(false);
  expect(state.subscriptions).toEqual([{ id: 'fake-confirmed' }]);
  api.tabs.query = async () => [{ id: 7, url: 'https://wrong.test/' }];
  await expect(observeSiteState(api, 'revoked', origin, host)).rejects.toThrow('tab');
  expect(Object.values(host).every((value) => typeof value === 'string' ? /^[a-f0-9]{64}$/.test(value) : typeof value === 'number')).toBe(true);
});

test('missing permission cannot by itself prove human denial', async () => {
  let ack = false;
  await expect(runHumanStage({ instruction: 'Deny.', instruct: () => {}, observe: async () => false,
    acknowledge: async () => { ack = true; return 'DONE'; } })).rejects.toThrow('observable');
  expect(ack).toBe(false);
});

test('bounded observation retries pending state and fails truthfully on timeout', async () => {
  let attempts = 0;
  await expect(waitForObservation(async () => ++attempts === 2, { timeoutMs: 100, intervalMs: 1 })).resolves.toBe(true);
  await expect(waitForObservation(async () => false, { timeoutMs: 5, intervalMs: 1 })).rejects.toThrow('timed out');
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
