// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createQaRunLog, createQaMismatchMonitor } from '../scripts/manual-qa-run-log.mjs';
import { runManualActiveTabQa, reviewCandidate, observeQaWorkerCounts } from '../scripts/manual-active-tab-qa.mjs';
const dirs = [];
const setup = () => { const directory = mkdtempSync(join(tmpdir(), 'qa-auto-')); dirs.push(directory); return createQaRunLog({ directory }); };
afterEach(() => dirs.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
test('issue publishes atomic latest and bound per-run JSONL without completing a gate', () => {
  const log = setup();
  const binding = { commit: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), archiveSha256: 'c'.repeat(64) };
  log.record('binding', { binding });
  log.record('issue', { checkpoint: '15f', errorCode: 'spa_exit_panel_retained', snapshot: { route: 'information', panelCount: 1, actionObserved: true } });
  const latest = JSON.parse(readFileSync(join(dirs[0], 'latest.json'), 'utf8'));
  expect(latest).toMatchObject({ needsAttention: true, status: 'waiting', binding, event: 'issue', checkpoint: '15f' });
  expect(latest.eventId).toBe(`${log.runId}:3`);
  expect(JSON.parse(readFileSync(join(log.directory, 'issue.json'), 'utf8'))).toEqual(latest);
  expect(readFileSync(join(log.directory, 'events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
  log.record('observation', { snapshot: { route: 'information', panelCount: 1 } });
  expect(JSON.parse(readFileSync(join(dirs[0], 'latest.json'), 'utf8'))).toEqual(latest);
  expect(log.record('issue', { errorCode: 'private stack' })).toBe(false);
  log.finish(Object.assign(Error('secret token'), { name: 'AbortError' }));
  expect(JSON.parse(readFileSync(join(log.directory, 'summary.json'), 'utf8'))).toMatchObject({ status: 'cancelled', needsAttention: true });
  expect(readFileSync(join(log.directory, 'events.jsonl'), 'utf8')).not.toContain('secret');
});
test('SPA exit mismatch waits for observed action and settling, dedupes, resets at checkpoint', () => {
  const log = setup(); const monitor = createQaMismatchMonitor(log, { settleMs: 2000 });
  monitor.stage('15f');
  const prior = { route: 'identical', supported: true, panelCount: 1 };
  const bad = { route: 'information', supported: false, panelCount: 1 };
  monitor.sample(bad, 0); monitor.sample(bad, 3000); // no observed transition
  expect(readdirSync(log.directory)).not.toContain('issue.json');
  monitor.sample(prior, 4000); monitor.sample(bad, 5000); monitor.sample(bad, 6999);
  expect(readdirSync(log.directory)).not.toContain('issue.json');
  monitor.sample(bad, 7000); monitor.sample(bad, 8000);
  const issue = JSON.parse(readFileSync(join(log.directory, 'issue.json'), 'utf8'));
  expect(issue).toMatchObject({ errorCode: 'spa_exit_panel_retained', snapshot: { actionObserved: true } });
  expect(readFileSync(join(log.directory, 'events.jsonl'), 'utf8').match(/spa_exit_panel_retained/g)).toHaveLength(1);
  monitor.stage('15g'); monitor.sample(bad, 20000); log.finish();
});
test('actual runner error path flushes terminal failure before rejecting, retains raw error identity', async () => {
  const log = setup(); const fault = Error('secret@example.com raw error');
  await expect(runManualActiveTabQa([], { log, prepare: () => { throw fault; } })).rejects.toBe(fault);
  const failure = JSON.parse(readFileSync(join(log.directory, 'failure.json'), 'utf8'));
  expect(failure).toMatchObject({ event: 'run_failed', status: 'failed', errorCode: 'qa_failure', checkpoint: 'setup' });
  expect(JSON.parse(readFileSync(join(dirs[0], 'latest.json'), 'utf8'))).toEqual(failure);
});
test.each([undefined, false, null, 0])('runner classifies thrown %s as failed without emitting a marker', async fault => {
  const log = setup();
  let rejected = false;
  const output = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(text => { output.push(text); return true; });
  try {
    await runManualActiveTabQa([], { log, prepare: () => ({ cleanup: () => { throw Error('cleanup'); } }), review: () => { throw fault; } })
      .catch(error => { rejected = true; expect(error).toBe(fault); });
    expect(rejected).toBe(true);
  } finally { write.mockRestore(); }
  expect(output.join('')).not.toContain('"outcome": "passed"');
  expect(JSON.parse(readFileSync(log.path, 'utf8'))).toMatchObject({ status: 'failed' });
  expect(JSON.parse(readFileSync(join(log.directory, 'failure.json'), 'utf8'))).toMatchObject({ event: 'run_failed', errorCode: 'qa_failure' });
});
test('throwing name getter cannot mask original rejection or prevent failed logging', async () => {
  const log = setup();
  const getter = vi.fn(() => { throw Error('getter must not run'); });
  const fault = Object.defineProperty({}, 'name', { get: getter });
  let rejected = false;
  await runManualActiveTabQa([], { log, prepare: () => { throw fault; } }).catch(error => { rejected = true; expect(error).toBe(fault); });
  expect(rejected).toBe(true);
  expect(getter).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(log.path, 'utf8')).status).toBe('failed');
});
test.each(['AbortError', 'TimeoutError'])('native DOMException %s preserves bounded classification', name => {
  const log = setup();
  log.finish(new globalThis.DOMException('private text', name));
  expect(JSON.parse(readFileSync(join(log.directory, 'failure.json'), 'utf8'))).toMatchObject({
    event: name === 'AbortError' ? 'run_cancelled' : 'run_failed',
    errorCode: name === 'AbortError' ? 'qa_interrupted' : 'qa_timeout',
  });
});
test('runner finalizer failures cannot replace the original thrown value', async () => {
  const fault = Object.freeze({ opaque: true });
  const log = { record: () => false, finish: () => { throw Error('logger finalizer'); } };
  await expect(runManualActiveTabQa([], { log, prepare: () => { throw fault; } })).rejects.toBe(fault);
});
test('filesystem diagnostic failures cannot mask the original review failure', async () => {
  const log = setup();
  // Atomic summary replacement will fail against a directory, with no deletion.
  rmSync(log.path); mkdirSync(log.path);
  const fault = Error('primary');
  await expect(runManualActiveTabQa([], { log, prepare: () => ({ cleanup: () => {} }),
    review: candidate => reviewCandidate(candidate, { log, createTls: () => { throw fault; } }) })).rejects.toBe(fault);
  expect(log.record('start')).toBe(false);
  expect(readdirSync(log.path)).toEqual([]);
});
test('rejecting diagnostic record cannot mask the original bootstrap failure', async () => {
  const fault = Error('primary bootstrap');
  const log = { path: null, record: () => { throw Error('diagnostic record'); } };
  await expect(reviewCandidate({ extensionPath: '/unused' }, { log, createTls: () => { throw fault; } })).rejects.toBe(fault);
});
test('event budget reserves issue and terminal records and closed logs reject further writes', () => {
  const log = setup();
  for (let i = 0; i < 2100; i++) log.record('observation', { snapshot: { panelCount: 1 } });
  expect(log.record('issue', { checkpoint: '15f', errorCode: 'spa_exit_panel_retained', snapshot: { route: 'information', panelCount: 1, actionObserved: true } })).toBe(true);
  log.finish(Error('private'));
  const lines = readFileSync(join(log.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(lines).toHaveLength(2000);
  expect(lines.at(-2).event).toBe('issue'); expect(lines.at(-1).event).toBe('run_failed');
  expect(log.record('start')).toBe(false);
  expect(JSON.parse(readFileSync(log.path, 'utf8')).droppedEvents).toBeGreaterThan(0);
});
test('worker diagnostics reduce actual API readbacks and never return badge strings or records', async () => {
  const origin = 'https://checkout-a.test:1234';
  const api = { storage: { local: { get: async () => ({ reviewHistory: [{ secret: 'PRIVATE' }], subscriptions: [], grantState: { sites: { [origin]: { enabled: true } } } }) } },
    permissions: { contains: async () => true }, scripting: { getRegisteredContentScripts: async () => [{ matches: [origin + '/*'] }] },
    tabs: { query: async () => [{ id: 12, url: origin + '/information' }] }, action: { getBadgeText: async () => '2' } };
  const worker = { evaluate: (fn, arg) => { const previous = globalThis.chrome; globalThis.chrome = api; return Promise.resolve(fn(arg)).finally(() => { globalThis.chrome = previous; }); } };
  expect(await observeQaWorkerCounts(worker, origin, origin + '/information')).toEqual({ historyCount: 1, subscriptionCount: 0, hasGrant: true, sitePermission: true, registered: true, badgeCount: 2 });
  api.action.getBadgeText = async () => 'SECRET';
  const reduced = await observeQaWorkerCounts(worker, origin, origin + '/information');
  expect(reduced).not.toHaveProperty('badgeCount');
  expect(JSON.stringify(reduced)).not.toMatch(/PRIVATE|SECRET/);
  expect(await observeQaWorkerCounts(worker, 'https://real.example', 'https://real.example/')).toEqual({});
});
