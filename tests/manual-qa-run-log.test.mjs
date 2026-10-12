// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async original => ({ ...await original(), homedir: () => state.home }));
import { createQaRunLog, createQaMismatchMonitor, checkpointId, acknowledgementToken } from '../scripts/manual-qa-run-log.mjs';
/* global document */
import { runManualActiveTabQa, reviewCandidate, observeQaSnapshot } from '../scripts/manual-active-tab-qa.mjs';
import { mockCheckoutHtml } from '../scripts/manual-qa-fixtures.mjs';
import { chromium } from 'playwright';
import { build } from 'esbuild';
const homes = [];
function setup() { state.home = mkdtempSync(join(tmpdir(), 'qa-log-test-')); homes.push(state.home); return createQaRunLog(); }
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
test('strict fields, tokens and bounded atomic events never retain remote strings', () => {
  const log = setup();
  log.record('checkpoint', { checkpoint: '15f' });
  for (const invalid of [{ checkpoint: 'secret@example.com' }, { checkpoint: '15f', body: 'secret' }, { snapshot: { panelCount: 1, url: 'secret' } }, { snapshot: { panelCount: -1 } }]) expect(log.record('stall', invalid)).toBe(false);
  for (let i = 0; i < 200; i++) log.record('stall', { snapshot: { panelCount: 1, route: 'information', supported: false } });
  log.finish(new Error('https://account.test/?token=SECRET secret@example.com'));
  const text = readFileSync(log.path, 'utf8'); const data = JSON.parse(text);
  expect(text).not.toMatch(/SECRET|account.test|example.com/);
  expect(data.events).toHaveLength(128); expect(data.status).toBe('failed'); expect(data.droppedEvents).toBe(0);
  expect(data.events.at(-1).errorCode).toBe('qa_failure');
  expect(readdirSync(join(state.home, 'ClearChoice_QA')).filter(name => name.endsWith('.tmp'))).toEqual([]);
});
test('symlink directory disables logging without touching destination', () => {
  state.home = mkdtempSync(join(tmpdir(), 'qa-log-link-')); homes.push(state.home);
  const destination = join(state.home, 'destination'); mkdirSync(destination);
  symlinkSync(destination, join(state.home, 'ClearChoice_QA'));
  const log = createQaRunLog(); expect(log.path).toBe(null); expect(log.record('start')).toBe(false); expect(() => log.finish(Error('root'))).not.toThrow();
  expect(readdirSync(destination)).toEqual([]);
});
test('starting runs never prunes existing directories or unrelated fixed-name files', () => {
  setup().finish();
  const root = join(state.home, 'ClearChoice_QA');
  const old = [];
  for (let i = 0; i < 16; i++) {
    const directory = join(root, `run-1000000000000-00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    mkdirSync(directory, { mode: 0o700 });
    for (const file of ['summary.json', 'events.jsonl', 'failure.json', 'issue.json', 'keep.txt']) writeFileSync(join(directory, file), `unrelated ${file} ${i}`);
    old.push(directory);
  }
  for (let i = 0; i < 24; i++) {
    const log = createQaRunLog(); expect(log.path).not.toBe(null); log.finish();
  }
  for (const directory of old) {
    expect(readdirSync(directory).sort()).toEqual(['events.jsonl', 'failure.json', 'issue.json', 'keep.txt', 'summary.json']);
    for (const file of readdirSync(directory)) expect(readFileSync(join(directory, file), 'utf8')).toBe(`unrelated ${file} ${old.indexOf(directory)}`);
  }
  expect(readdirSync(root).filter(name => name.startsWith('run-'))).toHaveLength(41);
});
test('only structured checkpoint IDs and known acknowledgement tokens are retained', () => {
  expect(checkpointId('15f. SPA EXIT: private instruction text')).toBe('15f');
  expect(checkpointId('999. PRIVATE')).toBe(null);
  expect(acknowledgementToken('Type DENIED after private text')).toBe('DENIED');
  expect(acknowledgementToken('Type REENABLE_CONFIRMED after real Enable')).toBe('REENABLE_CONFIRMED');
  expect(acknowledgementToken('Type NEW_CHROME_ALLOW_SEEN')).toBe(null);
  expect(acknowledgementToken('Type SECRET')).toBe(null);
});
test('entrypoint records setup failures and original failure survives rejecting cleanup', async () => {
  const log = setup(); const original = new Error('private bootstrap data'); let cleaned = 0;
  await expect(runManualActiveTabQa([], { log, prepare: () => ({ cleanup: () => { cleaned++; throw Error('cleanup'); } }),
    review: () => { throw original; } })).rejects.toBe(original);
  expect(cleaned).toBe(1);
  expect(JSON.parse(readFileSync(log.path, 'utf8')).status).toBe('failed');
  const second = createQaRunLog();
  await expect(runManualActiveTabQa([], { log: second, prepare: () => { throw original; } })).rejects.toBe(original);
  expect(JSON.parse(readFileSync(second.path, 'utf8')).checkpoint).toBe('setup');
});
test('actual review bootstrap emits bounded stall then cleans timers on interruption without masking error', async () => {
  const log = setup(); const original = Object.assign(Error('private interruption'), { name: 'AbortError' });
  let rejectSetup;
  let ready;
  const setupReady = new Promise(resolve => { ready = resolve; });
  const waiting = new Promise((_, reject) => { rejectSetup = reject; });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const run = runManualActiveTabQa([], { log, prepare: () => ({ extensionPath: '/unused', cleanup: () => {} }),
    review: candidate => reviewCandidate(candidate, { log, createTls: () => { ready(); return waiting; } }) });
  await setupReady;
  await vi.advanceTimersByTimeAsync(30_000);
  const pending = JSON.parse(readFileSync(log.path, 'utf8'));
  expect(pending.status).toBe('waiting');
  expect(pending.events.at(-1)).toMatchObject({ event: 'waiting', snapshot: { route: 'unknown' } });
  rejectSetup(original);
  await expect(run).rejects.toBe(original);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  const data = JSON.parse(readFileSync(log.path, 'utf8'));
  expect(data.events.some(event => event.event === 'observation' && event.snapshot.route === 'unknown')).toBe(true);
  expect(data.events.at(-1).errorCode).toBe('qa_interrupted');
});
test('real disposable Chromium snapshot records SPA support and visible shadow panels, never host inputs', async () => {
  const log = setup();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const origin = 'https://checkout-a.test:1234';
    await page.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body: mockCheckoutHtml('identical') }));
    await page.goto(`${origin}/checkout/identical`);
    const classifier = (await build({ entryPoints: ['src/core/context.ts'], bundle: true, write: false, format: 'iife', globalName: 'QaContext' })).outputFiles[0].text;
    // Synthetic panel tests the observer, NOT extension behavior or human evidence.
    await page.evaluate(() => {
      const host = document.createElement('aside'); host.dataset.clearchoicePanel = 'true';
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<section class="clearchoice-panel" style="position:fixed;top:0;right:0;width:200px;height:100px"><article></article><article></article><button data-clearchoice-dismiss>Dismiss</button></section>';
      document.body.append(host);
      const input = document.createElement('input'); input.value = 'SECRET_ACCOUNT_VALUE'; document.body.append(input);
    });
    const initial = await observeQaSnapshot(page, context, origin, classifier);
    expect(initial).toMatchObject({ route: 'identical', supported: true, panelCount: 1, findingCount: 2, visible: true });
    expect(log.record('observation', { snapshot: initial })).toBe(true);
    const monitor = createQaMismatchMonitor(log); monitor.stage('15f'); monitor.sample(initial, 0);
    await page.getByRole('button', { name: 'Exit checkout route' }).click();
    const exited = await observeQaSnapshot(page, context, origin, classifier);
    expect(exited).toMatchObject({ route: 'information', supported: false, panelCount: 1 });
    monitor.sample(exited, 1000); monitor.sample(exited, 4000);
    expect(JSON.parse(readFileSync(join(log.directory, 'issue.json'), 'utf8'))).toMatchObject({ event: 'issue', errorCode: 'spa_exit_panel_retained', needsAttention: true });
    // Logging describes the still-present synthetic panel: it does not remove it or pass 15f.
    expect(log.record('stall', { checkpoint: '15f', snapshot: exited })).toBe(true);
    expect(await observeQaSnapshot(page, {}, origin, classifier)).toEqual({ route: 'unknown' });
    expect(await observeQaSnapshot(page, context, 'https://checkout-a.test:9999', classifier)).toEqual({ route: 'unknown' });
    expect(readFileSync(log.path, 'utf8')).not.toContain('SECRET_ACCOUNT_VALUE');
  } finally { await browser.close(); log.finish(); }
});

