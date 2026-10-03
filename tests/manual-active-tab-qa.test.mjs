// @vitest-environment node
/* global chrome */
/* global window, setTimeout */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { TextEncoder } from 'node:util';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createFixtureTls } from '../scripts/manual-qa-fixtures.mjs';
import { lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { afterEach, expect, test, vi } from 'vitest';
import { observeHistorySubscriptionUi, observeCleanState, observeSiteState, storageValidatorSource } from '../scripts/manual-qa-stages.mjs';
import * as artifacts from '../scripts/release-artifact.mjs';
import {
  assertFixtureOrigin,
  captureIntegrityBaseline,
  createManualActiveTabQaMarker,
  fixtureOriginForServerAddress,
  fixtureForRequest,
  integrityPassed,
  restrictedBrowserArgs,
  reviewBrowserLaunchOptions,
  runManualActiveTabQa,
  runManualCheckpoints,
  runPermissionCycleCheckpoints,
  runSiteCheckpoints,
  runHistorySubscriptionCheckpoints,
  observeNativeHistoryDialog,
  attestCompletedWorkflow,
  runSyntheticEvidence,
  runCleanupSteps,
  recheckCandidateBinding,
  reviewedWorkerUrl,
  waitForReviewedExtensionWorker,
  reviewCandidate,
  serveFixture,
} from '../scripts/manual-active-tab-qa.mjs';

test('permission cycle requires separate prompt self-attestation and rechecks after acknowledgement', async () => {
  const events = [];
  const run = (overrides = {}) => runPermissionCycleCheckpoints({
    instruct: (text) => events.push(text), read: async (mode) => { events.push(mode); return true; },
    ui: async () => true, integrity: async () => events.push('integrity'),
    acknowledge: async (token) => { events.push(token); return token; }, waitForState: (observe) => observe(), ...overrides,
  });
  await run();
  expect(events.filter((event) => event === 'reenabled')).toHaveLength(2);
  expect(events.filter((event) => event === 'settings-removed')).toHaveLength(2);
  expect(events.indexOf('NEW_CHROME_ALLOW_SEEN')).toBeLessThan(events.indexOf('before-settings'));
  expect(events.some((event) => event.includes('OS permission-dialog automation is unavailable'))).toBe(true);
  expect(events.some((event) => event.includes('never use the production popup Disable'))).toBe(true);
  let ack = false;
  await expect(run({ ui: async () => false, acknowledge: async () => { ack = true; return 'NEW_CHROME_ALLOW_SEEN'; } })).rejects.toThrow('observable');
  expect(ack).toBe(false);
  await expect(run({ acknowledge: async () => 'DONE' })).rejects.toThrow('acknowledgement');
  let changed = false;
  await expect(run({ acknowledge: async (token) => { changed = true; return token; }, ui: async () => !changed })).rejects.toThrow('changed during acknowledgement');
});

const root = resolve(process.cwd());
test('final attestation refuses incomplete predicates and requires fresh binding on both sides of ATTEST', async () => {
  const { WORKFLOW_PREDICATES } = await import('../scripts/active-tab-qa.mjs');
  const candidate = { commit: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), archiveSha256: 'c'.repeat(64) };
  const results = Object.fromEntries(WORKFLOW_PREDICATES.map(key => [key, key === 'accessibility' ? true : 'passed']));
  for (const failure of ['missing', 'failed', 'ack', 'before', 'after', 'none']) {
    const events = []; let checks = 0;
    const supplied = { ...results };
    if (failure === 'missing') delete supplied.retention;
    if (failure === 'failed') supplied.cancellationHelp = 'pending';
    const options = { instruct: () => {}, acknowledge: async () => { events.push('ack'); return failure === 'ack' ? '' : 'ATTEST'; },
      recheck: async () => { checks++; events.push('check'); if (failure === 'before' || failure === 'after' && checks === 2) throw Error('candidate changed'); },
      emit: value => events.push(JSON.parse(value)) };
    const run = attestCompletedWorkflow(candidate, supplied, options);
    if (failure !== 'none') { await expect(run).rejects.toThrow(); expect(events.some(value => typeof value === 'object')).toBe(false); }
    else { await run; expect(events.slice(0, 3)).toEqual(['check', 'ack', 'check']); expect(events[3].schemaVersion).toBe(5); }
    if (['missing', 'failed', 'before'].includes(failure)) expect(events).not.toContain('ack');
  }
});

test.each([true, false])('fresh extracted runtime (headless=%s) executes isolated synthetic expiry and bundled catalog after native popup destruction without provider navigation', headless => archiveFixture(async ({ initial }) => {
  const { build } = await import('esbuild');
  const { runInNewContext } = await import('node:vm');
  const bundle = await build({ entryPoints: ['src/shared/semantic-fingerprint.ts'], bundle: true, write: false, format: 'iife', globalName: 'Fingerprint' });
  const fingerprint = await runInNewContext(`${bundle.outputFiles[0].text}; Fingerprint.semanticFingerprint`, { crypto: globalThis.crypto, TextEncoder })({ kind: 'recurring-charge', reason: 'price-cadence', screenedExcerpt: 'Local mock membership renews at $12.00 per month.' });
  const instructions = [];
  let originalPopup;
  const result = await runSyntheticEvidence(initial, { opaqueFingerprint: fingerprint, kind: 'recurring-charge', reason: 'price-cadence', screenedExcerpt: 'Local mock membership renews at $12.00 per month.' }, {
    headless, instruct: text => { instructions.push(text); },
    // Test callbacks are synthetic, NOT human evidence or a saved marker.
    selectPolicy: async popup => { originalPopup = popup; await popup.selectOption('[data-review-retention]', '7'); },
    acknowledge: async token => {
      if (token === 'SYNTHETIC_EXPIRY_REVIEWED') {
        await originalPopup.evaluate(() => { setTimeout(() => window.close(), 0); return true; });
        await expect.poll(async () => {
          try { await originalPopup.evaluate(() => true); return false; } catch { return true; }
        }, { timeout: 10_000 }).toBe(true);
      }
      return token;
    },
  });
  expect(result).toEqual({ expiry: true, catalog: true, publicReview: true });
  expect(instructions.join('\n')).toContain('NOT positive provider browser navigation');
}, { runtime: true }), 30_000);
const temporaryPaths = [];

// Same real build-manifest/ZIP builder as exact-archive-gate, with no human marker.
async function archiveFixture(run, { runtime = false } = {}) {
  const dir = mkdtempSync(resolve(process.env.TMPDIR ?? '/home/daksh/.hermes/cache/scratch', 'manual-recheck-'));
  const repo = resolve(dir, 'repo');
  mkdirSync(repo);
  cpSync(resolve('scripts'), resolve(repo, 'scripts'), { recursive: true });
  for (const name of ['manifest.json', 'package.json']) cpSync(resolve(name), resolve(repo, name));
  if (runtime) {
    cpSync(resolve('src'), resolve(repo, 'src'), { recursive: true });
    cpSync(resolve('vite.config.ts'), resolve(repo, 'vite.config.ts'));
  }
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'fixture']]) execFileSync('git', args, { cwd: repo });
  const assets = resolve(dir, 'assets');
  mkdirSync(resolve(assets, 'popup'), { recursive: true });
  execFileSync(process.execPath, ['scripts/build-manifest.mjs', '--release', '--output', resolve(assets, 'manifest.json')], { cwd: repo });
  writeFileSync(resolve(assets, 'content.js'), 'void 0;');
  writeFileSync(resolve(assets, 'worker.js'), 'void 0;');
  writeFileSync(resolve(assets, 'popup/index.html'), '<html>fixture</html>');
  if (runtime) {
    symlinkSync(resolve('node_modules'), resolve(repo, 'node_modules'), 'dir');
    execFileSync('npm', ['run', 'build:assets'], { cwd: repo, stdio: 'pipe' });
    cpSync(resolve(repo, 'dist'), assets, { recursive: true });
    // The browser ZIP keeps the approved release serializer, not a demo manifest.
    execFileSync(process.execPath, ['scripts/build-manifest.mjs', '--release', '--output', resolve(assets, 'manifest.json')], { cwd: repo });
  }
  const archive = artifacts.unpackedArchivePath(repo);
  execFileSync('zip', ['-qr', archive, '.'], { cwd: assets });
  const initial = artifacts.prepareCandidateArchive(repo);
  try { await run({ repo, archive, assets, initial }); }
  finally { initial.cleanup(); rmSync(dir, { recursive: true, force: true }); }
}

test('clean baseline observes a real extension worker using read-only browser APIs', () => archiveFixture(async ({ initial }) => {
  const profile = await mkdtemp(resolve(tmpdir(), 'manual-readback-profile-'));
  temporaryPaths.push(profile);
  const browser = await chromium.launchPersistentContext(profile, {
    ...reviewBrowserLaunchOptions(initial.extensionPath), headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.bringToFront();
    const { installReviewedExtension, wakeReviewedExtension } = await import('../scripts/manual-active-tab-qa.mjs');
    await installReviewedExtension(browser, initial.extensionPath);
    const worker = await waitForReviewedExtensionWorker(browser, initial.extensionPath);
    expect(worker.url()).toBe(await reviewedWorkerUrl(initial.extensionPath));
    expect(await worker.evaluate(() => globalThis.chrome.runtime.getManifest().permissions)).toEqual(['activeTab', 'scripting', 'storage']);
    const summary = await worker.evaluate(`(${observeCleanState.toString()})(chrome, 'capture', 'https://checkout-a.test:123/checkout/clean')`);
    expect(summary).toEqual({ storageValid: true, historyCount: 0, subscriptionCount: 0, unchanged: true, permissionCount: 0, scriptCount: 0, grantCount: 0, badgeBlank: true });
    const validator = await storageValidatorSource();
    // Production pure validators execute in the genuine worker; no storage seeds.
    expect(validator).not.toMatch(/storage\.local\.(?:set|remove|clear)|loadLocalState|readLocalState/);
    expect(await worker.evaluate(`(${observeSiteState.toString()})(chrome, 'baseline', 'https://checkout-a.test:123', globalThis, ${validator})`)).toEqual({ passed: true, historyCount: 0, subscriptionCount: 0 });
    const before = await worker.evaluate(async () => JSON.stringify({ stored: await chrome.storage.local.get(null), scripts: await chrome.scripting.getRegisteredContentScripts(), permissions: await chrome.permissions.getAll() }));
    await browser.close();
    const restarted = await chromium.launchPersistentContext(profile, { ...reviewBrowserLaunchOptions(initial.extensionPath), headless: true });
    try {
      await wakeReviewedExtension(restarted, initial.extensionPath);
      const fresh = await waitForReviewedExtensionWorker(restarted, initial.extensionPath);
      expect(await fresh.evaluate(() => chrome.runtime.id)).toBe(new URL(await reviewedWorkerUrl(initial.extensionPath)).hostname);
      expect(await fresh.evaluate(async () => JSON.stringify({ stored: await chrome.storage.local.get(null), scripts: await chrome.scripting.getRegisteredContentScripts(), permissions: await chrome.permissions.getAll() }))).toBe(before);
    } finally { await restarted.close(); }
  } finally { await browser.close(); }
}, { runtime: true }), 15_000);

test('reviewed worker selection ignores other targets and waits for exact activation', () => archiveFixture(async ({ initial }) => {
  const url = await reviewedWorkerUrl(initial.extensionPath);
  const session = new EventEmitter();
  session.detach = vi.fn(async () => {});
  session.send = vi.fn(async () => {});
  const other = { url: () => 'chrome-extension://' + 'a'.repeat(32) + '/worker.js', evaluate: vi.fn() };
  const reviewed = { url: () => url, evaluate: vi.fn(async () => true) };
  const context = { pages: () => [{}], newCDPSession: async () => session, serviceWorkers: () => [other, reviewed] };
  const pending = waitForReviewedExtensionWorker(context, initial.extensionPath);
  await vi.waitFor(() => expect(session.send).toHaveBeenCalledOnce());
  for (const [scriptURL, status] of [[other.url(), 'activated'], [url, 'installing']]) {
    session.emit('ServiceWorker.workerVersionUpdated', { versions: [{ scriptURL, status, runningStatus: 'running' }] });
    await Promise.resolve();
    expect(reviewed.evaluate).not.toHaveBeenCalled();
  }
  session.emit('ServiceWorker.workerVersionUpdated', { versions: [{ scriptURL: url, status: 'activated', runningStatus: 'running' }] });
  await expect(pending).resolves.toBe(reviewed);
  expect(other.evaluate).not.toHaveBeenCalled();
  expect(session.detach).toHaveBeenCalledOnce();
  expect(session.listenerCount('ServiceWorker.workerVersionUpdated')).toBe(0);
}));

test('reviewed worker activation timeout fails closed and detaches observation', () => archiveFixture(async ({ initial }) => {
  const session = new EventEmitter();
  session.send = async () => {};
  session.detach = vi.fn(async () => {});
  const context = { pages: () => [{}], newCDPSession: async () => session };
  await expect(waitForReviewedExtensionWorker(context, initial.extensionPath, { timeoutMs: 10 })).rejects.toThrow('activation timed out');
  expect(session.detach).toHaveBeenCalledOnce();
  expect(session.listenerCount('ServiceWorker.workerVersionUpdated')).toBe(0);
}));

test('activated worker with missing APIs fails once and preserves failure over detach error', () => archiveFixture(async ({ initial }) => {
  const url = await reviewedWorkerUrl(initial.extensionPath);
  const session = new EventEmitter();
  session.send = async () => { session.emit('ServiceWorker.workerVersionUpdated', { versions: [{ scriptURL: url, status: 'activated', runningStatus: 'running' }] }); };
  session.detach = vi.fn(async () => { throw new Error('detach failure'); });
  const worker = { url: () => url, evaluate: vi.fn(async () => false) };
  const context = { pages: () => [{}], newCDPSession: async () => session, serviceWorkers: () => [worker] };
  await expect(waitForReviewedExtensionWorker(context, initial.extensionPath)).rejects.toThrow('browser APIs unavailable');
  expect(worker.evaluate).toHaveBeenCalledOnce();
  expect(session.detach).toHaveBeenCalledOnce();
  expect(session.listenerCount('ServiceWorker.workerVersionUpdated')).toBe(0);
}));

test('final binding accepts unchanged exact ZIP without rebuilding or deleting review extraction', () => archiveFixture(async ({ repo, archive, initial }) => {
  const before = readFileSync(archive);
  await expect(recheckCandidateBinding(repo, initial)).resolves.toBe(true);
  expect(readFileSync(archive)).toEqual(before);
  expect(readFileSync(resolve(initial.extensionPath, 'content.js'), 'utf8')).toBe('void 0;');
}));

test('final binding vetoes mutated complete ZIP and dirty or changed source', async () => {
  for (const mutation of ['zip', 'dirty', 'commit']) await archiveFixture(async ({ repo, archive, assets, initial }) => {
    if (mutation === 'zip') {
      writeFileSync(resolve(assets, 'content.js'), 'void 1;');
      execFileSync('zip', ['-qr', archive, '.'], { cwd: assets });
    } else {
      writeFileSync(resolve(repo, 'manifest.json'), readFileSync(resolve(repo, 'manifest.json'), 'utf8') + '\n');
      if (mutation === 'commit') {
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'change'], { cwd: repo });
      }
    }
    await expect(recheckCandidateBinding(repo, initial)).rejects.toThrow(mutation === 'dirty' ? 'dirty tracked' : 'candidate changed');
    expect(readFileSync(resolve(initial.extensionPath, 'content.js'), 'utf8')).toBe('void 0;');
  });
});

function listen(host, port, body, tls) {
  let requests = 0;
  const handler = (_request, response) => {
    requests += 1;
    response.end(body);
  };
  const server = tls ? createHttpsServer({ key: tls.key, cert: tls.cert }, handler) : createServer(handler);
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveListen({
      server,
      get requests() { return requests; },
      origin: `http://${host}:${server.address().port}`,
    }));
  });
}

function close(server) {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('clean zero never waits for an empty panel and gates the next page on acknowledgement and readback', async () => {
  const events = [];
  let release;
  const quiet = new Promise((resolve) => { release = resolve; });
  const wait = vi.fn();
  const run = runManualCheckpoints({
    cleanPage: 'clean', getDynamicPage: () => 'dynamic',
    instruct: (text) => events.push(text),
    confirmCleanAnalyze: async () => { events.push('clean:ack'); },
    assertCleanQuiet: async () => { events.push('clean:readback'); await quiet; },
    waitForPanel: wait, assertIntegrity: async () => {}, confirmRestore: async () => {},
    openDynamic: async () => { events.push('open:dynamic'); },
    waitForReplacement: async () => {}, confirmRepeatedAnalyze: async () => {},
  });
  await vi.waitFor(() => expect(events).toContain('clean:readback'));
  expect(wait).not.toHaveBeenCalled();
  expect(events).not.toContain('open:dynamic');
  release();
  await run;
  expect(events.indexOf('clean:ack')).toBeLessThan(events.indexOf('open:dynamic'));
  expect(wait.mock.calls.every(([page]) => page === 'dynamic')).toBe(true);
});

test('site workflow cannot treat quiet state as denial or advance before acknowledgement', async () => {
  const events = [];
  let denialObserved = false;
  const options = {
    instruct: () => {}, acknowledge: async () => { events.push('ack'); return 'DONE'; },
    navigate: async (site, positive) => events.push(`visit:${site}:${positive}`),
    read: async (mode, site) => { events.push(`${mode}:${site}`); return true; },
    quiet: async () => true, positive: async () => true,
    denied: async () => denialObserved,
    integrity: async () => {}, mutate: async () => {}, lifecycle: async () => {},
  };
  await expect(runSiteCheckpoints(options)).rejects.toThrow('observable');
  expect(events).not.toContain('before-revoke:a');
  expect(events.filter((event) => event === 'ack')).toHaveLength(2);
  denialObserved = true;
  events.length = 0;
  await runSiteCheckpoints(options);
  expect(events.indexOf('quiet:b')).toBeLessThan(events.indexOf('before-revoke:a'));
  expect(events.filter((event) => event === 'revoked:a')).toHaveLength(4);
});

test('synthetic native dialog events require fresh exact popup, record, message and closed Cancel', async () => {
  const { createHash } = await import('node:crypto');
  const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  for (const failure of ['none', 'missing', 'unresolved', 'other-popup', 'wrong-record', 'wrong-message', 'accepted', 'stale']) {
    const session = new EventEmitter(); session.send = async () => {}; session.detach = vi.fn(async () => {});
    const other = new EventEmitter();
    let calls = 0;
    const popup = { isClosed: () => false, evaluate: async () => ++calls === 1 ? undefined : { counter: 1, digest: hash(failure === 'wrong-record' ? 'wrong' : 'target') } };
    if (failure === 'stale') { session.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'expected' }); session.emit('Page.javascriptDialogClosed', { result: false }); }
    const observer = await observeNativeHistoryDialog({ newCDPSession: async (page) => { expect(page).toBe(popup); return session; } }, popup, hash('target'), hash('expected'), false);
    expect(await observer.passed()).toBe(false);
    const emitter = failure === 'other-popup' ? other : session;
    if (!['missing', 'stale'].includes(failure)) emitter.emit('Page.javascriptDialogOpening', { type: 'confirm', message: failure === 'wrong-message' ? 'wrong' : 'expected' });
    if (!['missing', 'stale', 'unresolved'].includes(failure)) emitter.emit('Page.javascriptDialogClosed', { result: failure === 'accepted' });
    if (['wrong-record', 'wrong-message', 'accepted'].includes(failure)) await expect(observer.passed()).rejects.toThrow('mismatch');
    else expect(await observer.passed()).toBe(failure === 'none');
    await observer.close(); expect(session.detach).toHaveBeenCalledOnce();
  }
});

test('history native Cancel cannot pass with unchanged pre-click state and DONE alone', async () => {
  const prompts = [];
  await expect(runHistorySubscriptionCheckpoints({ instruct: (text) => prompts.push(text),
    read: async () => true, ui: async () => true, waitForState: (observe) => observe(),
    acknowledge: async () => 'DONE',
  })).rejects.toThrow('native history dialog observer unavailable');
  expect(prompts.some((text) => text.startsWith('23b.'))).toBe(false);
});

test('synthetic human CRUD orchestration never advances without observable UI, storage and separate DONE', async () => {
  for (const failure of ['ui', 'storage', 'ack']) {
    const events = [];
    await expect(runHistorySubscriptionCheckpoints({ nativeDialog: async () => ({ passed: async () => true, close: async () => {} }),
      instruct: () => {}, waitForState: (observe) => observe(),
      read: async (mode) => { events.push(mode); return mode === 'baseline' || failure !== 'storage'; },
      ui: async () => failure !== 'ui',
      acknowledge: async () => { events.push('ack'); return failure === 'ack' ? 'ATTEST' : 'DONE'; },
    })).rejects.toThrow();
    expect(events).not.toContain('reviewed');
    if (failure !== 'ack') expect(events).not.toContain('ack');
  }
  let release;
  const events = [];
  const pending = runHistorySubscriptionCheckpoints({ nativeDialog: async () => ({ passed: async () => true, close: async () => {} }), instruct: () => {}, read: async (mode) => { events.push(mode); return true; }, ui: async () => true,
    acknowledge: () => events.filter((value) => value === 'history').length === 1 && !release ? new Promise((resolveAck) => { release = resolveAck; }) : Promise.resolve('DONE') });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(events).toEqual(['baseline', 'history']);
  release('DONE');
  await expect(pending).resolves.toBeUndefined();
  expect(events).toEqual(['baseline', ...['history', 'reviewed', 'unchanged', 'unchanged', 'unchanged', 'confirmed', 'history-delete-cancelled', 'history-deleted', 'added', 'edited', 'unchanged', 'unchanged', 'unchanged', 'deleted'].flatMap((mode) => mode === 'history-delete-cancelled' ? ['history-delete-baseline', mode, mode] : [mode, mode])]);
  const source = readFileSync(resolve(root, 'scripts/manual-active-tab-qa.mjs'), 'utf8');
  expect(source.indexOf('await runHistorySubscriptionCheckpoints({', source.indexOf('export async function reviewCandidate'))).toBeGreaterThan(source.indexOf('await runSiteCheckpoints({'));
  expect(source).not.toContain('stopPendingHumanStages');
  expect(source).toContain('await attestCompletedWorkflow(');
});

test('synthetic acknowledgement-time drift aborts and each CRUD prompt fails closed on missing acknowledgement', async () => {
  let current = true;
  await expect(runHistorySubscriptionCheckpoints({ nativeDialog: async () => ({ passed: async () => true, close: async () => {} }),
    instruct: () => {}, ui: async () => current, read: async () => true,
    acknowledge: async () => { current = false; return 'DONE'; },
  })).rejects.toThrow('changed during acknowledgement');
  for (let rejectedStage = 1; rejectedStage <= 14; rejectedStage++) {
    let prompts = 0;
    let acknowledgements = 0;
    await expect(runHistorySubscriptionCheckpoints({ nativeDialog: async () => ({ passed: async () => true, close: async () => {} }),
      instruct: () => { prompts++; }, ui: async () => true, read: async () => true,
      acknowledge: async () => ++acknowledgements === rejectedStage ? '' : 'DONE',
    })).rejects.toThrow('acknowledgement');
    expect(prompts).toBe(rejectedStage);
    expect(acknowledgements).toBe(rejectedStage);
  }
});

test('synthetic popup DOM predicates reject prefilled ambiguity, open cancellation and wrong delete target', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    // Static fixture DOM only, no extension API replacement or human QA claim.
    const render = async (editor, status, count = 0) => page.setContent(`<section aria-label="Subscriptions"><p role="status">${status}</p><div data-subscription-list>${'<article></article>'.repeat(count)}</div><div data-subscription-editor>${editor}</div></section>`);
    const read = (mode) => page.evaluate(`(${observeHistorySubscriptionUi.toString()})(${JSON.stringify(mode)}, '')`);
    const fields = '<h3>Confirm observation as subscription</h3><input name="merchant"><input name="amount"><input name="currency"><select name="cadence"><option value=""></option></select>';
    await render(fields, 'Save explicitly to confirm changes.');
    expect(await read('draft')).toBe(true);
    await render(fields.replace('name="currency"', 'name="currency" value="USD"'), 'Save explicitly to confirm changes.');
    expect(await read('draft')).toBe(false);
    expect(await read('cancelled')).toBe(false);
    await render('', 'Editor closed; no additional save requested.');
    expect(await read('cancelled')).toBe(true);
    await render('<div aria-label="Delete confirmation"><h3>Delete subscription?</h3><p>QA Finding Mock</p></div>', '', 2);
    expect(await read('delete-prompt')).toBe(false);
    await render('<div aria-label="Delete confirmation"><h3>Delete subscription?</h3><p>QA Manual Mock Edited</p></div>', '', 2);
    expect(await read('delete-prompt')).toBe(true);
    expect(await read('closed-two')).toBe(false);
    await render('', 'Subscription saved locally.', 2);
    expect(await read('saved-two')).toBe(true);
    await render('', 'Subscription deleted locally.', 1);
    expect(await read('deleted-one')).toBe(true);
  } finally { await browser.close(); }
});

test('manual runner loads the prepared archive extraction and cleans it after browser launch failure', async () => {
  const extensionPath = resolve(tmpdir(), 'synthetic-unit-extracted-extension');
  const cleanup = vi.fn();
  const prepared = vi.spyOn(artifacts, 'prepareCandidateArchive').mockReturnValue({ extensionPath, cleanup });
  const failure = new Error('intentional unit browser-launch stop; no human QA');
  const launch = vi.spyOn(chromium, 'launchPersistentContext').mockRejectedValue(failure);
  try {
    await expect(runManualActiveTabQa([])).rejects.toBe(failure);
    expect(prepared).toHaveBeenCalledExactlyOnceWith(root);
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0][1].args).not.toContain(`--load-extension=${extensionPath}`);
    expect(cleanup).toHaveBeenCalledOnce();
  } finally {
    launch.mockRestore();
    prepared.mockRestore();
  }
});

test('runner preserves launch failure when candidate cleanup also fails', async () => {
  const failure = new Error('launch primary');
  const cleanup = vi.fn(() => { throw new Error('candidate cleanup'); });
  const prepared = vi.spyOn(artifacts, 'prepareCandidateArchive').mockReturnValue({ extensionPath: root, cleanup });
  const launch = vi.spyOn(chromium, 'launchPersistentContext').mockRejectedValue(failure);
  try {
    await expect(runManualActiveTabQa([])).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledOnce();
  } finally { prepared.mockRestore(); launch.mockRestore(); }
});

test('TLS acquisition failure is preserved without creating later resources', async () => {
  const primary = new Error('TLS setup');
  const makeServer = vi.fn();
  await expect(reviewCandidate({ extensionPath: root }, {
    createTls: async () => { throw primary; }, makeServer,
  })).rejects.toBe(primary);
  expect(makeServer).not.toHaveBeenCalled();
});

test('listen setup failure attempts server and TLS cleanup exactly once without masking primary', async () => {
  const primary = new Error('listen setup');
  const tls = { cleanup: vi.fn(() => { throw new Error('TLS cleanup'); }) };
  let fail;
  const server = {
    once: vi.fn((_event, callback) => { fail = callback; }),
    listen: vi.fn(() => fail(primary)),
    close: vi.fn((callback) => callback(new Error('server close'))),
  };
  await expect(reviewCandidate({ extensionPath: root }, {
    createTls: async () => tls, makeServer: () => server,
  })).rejects.toBe(primary);
  expect(server.close).toHaveBeenCalledOnce();
  expect(tls.cleanup).toHaveBeenCalledOnce();
});

test('midworkflow error survives browser close failure and every remaining resource closes once', async () => {
  const primary = new Error('navigation primary');
  const tls = { cleanup: vi.fn() };
  const server = {
    once: vi.fn(), listen: vi.fn((_port, _host, callback) => callback()),
    address: () => ({ address: '127.0.0.1', port: 12345 }),
    close: vi.fn((callback) => callback()),
  };
  const browser = { on: vi.fn(), newPage: async () => ({ goto: async () => { throw primary; } }), close: vi.fn(async () => { throw new Error('browser close'); }) };
  const removeProfile = vi.fn();
  await expect(reviewCandidate({ extensionPath: root }, {
    createTls: async () => tls, makeServer: () => server,
    createProfile: async () => 'unit-profile', launchContext: async () => browser, removeProfile, install: async () => {},
  })).rejects.toBe(primary);
  for (const closer of [browser.close, server.close, removeProfile, tls.cleanup]) expect(closer).toHaveBeenCalledOnce();
});

test('runner surfaces candidate cleanup-only failure without a human QA result', async () => {
  const failure = new Error('candidate cleanup only');
  const cleanup = vi.fn(() => { throw failure; });
  await expect(runManualActiveTabQa([], {
    prepare: () => ({ cleanup }), review: async () => undefined,
  })).rejects.toBe(failure);
  expect(cleanup).toHaveBeenCalledOnce();
});

test('manual QA cleanup attempts every resource even when Chromium close rejects', async () => {
  const firstFailure = new Error('Chromium close failed');
  const closeTerminal = vi.fn();
  const closeBrowser = vi.fn().mockRejectedValue(firstFailure);
  const closeFixtureServer = vi.fn();
  const removeProfile = vi.fn();
  await expect(runCleanupSteps([closeTerminal, closeBrowser, closeFixtureServer, removeProfile])).rejects.toBe(firstFailure);
  for (const cleanup of [closeTerminal, closeBrowser, closeFixtureServer, removeProfile]) {
    expect(cleanup).toHaveBeenCalledOnce();
  }
});

test('automatic lifecycle gates reload, SPA transitions and acknowledgement-time drift', async () => {
  const { runAutomaticLifecycleCheckpoints } = await import('../scripts/manual-active-tab-qa.mjs');
  for (const failure of ['none', 'ui', 'drift', 'reload-authorization']) {
    let current = true; let acknowledgements = 0; const events = [];
    const run = runAutomaticLifecycleCheckpoints({ instruct: () => {}, waitForState: (observe) => observe(),
      read: async (mode) => { events.push(mode); return true; }, ui: async () => failure !== 'ui' && current,
      navigate: async () => events.push('navigate'), reload: async () => events.push('reload'), integrity: async () => {},
      acknowledge: async () => { acknowledgements++; if (failure === 'drift') current = false; return failure === 'reload-authorization' && acknowledgements === 3 ? '' : 'DONE'; } });
    if (failure === 'none') { await run; expect(events).toContain('exit'); expect(events.filter((x) => x === 'reload')).toHaveLength(1); }
    else { await expect(run).rejects.toThrow(); expect(events).not.toContain('reload'); }
  }
});

test('identical fixture stays form-free and its human buttons mutate and exit/return supported routes', async () => {
  const { mockCheckoutHtml } = await import('../scripts/manual-qa-fixtures.mjs');
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(mockCheckoutHtml('identical'), { url: 'https://checkout-a.test:123/checkout/identical', runScripts: 'dangerously' });
  const doc = dom.window.document;
  expect(doc.querySelectorAll('form,input,select')).toHaveLength(0);
  const paragraphs = [...doc.querySelectorAll('#fake-order-summary p')];
  expect(paragraphs).toHaveLength(2); expect(paragraphs[0].textContent).toBe(paragraphs[1].textContent);
  doc.querySelector('#replace-order-summary').click(); doc.querySelector('#replace-order-summary').click();
  expect(doc.querySelector('h2').textContent).toBe('Order summary updated again');
  const { build } = await import('esbuild');
  const { runInNewContext } = await import('node:vm');
  const bundle = await build({ entryPoints: ['src/core/context.ts'], bundle: true, write: false, format: 'iife', globalName: 'QaContext' });
  const classify = runInNewContext(`${bundle.outputFiles[0].text}; QaContext.classifyCheckoutContext`, { window: dom.window, document: doc, NodeFilter: dom.window.NodeFilter });
  expect(classify(doc.body)).toBe('supported');
  doc.querySelector('#spa-exit').click(); expect(dom.window.location.pathname).toBe('/information');
  expect(classify(doc.body)).toBe('unsupported');
  doc.querySelector('#spa-return').click(); expect(dom.window.location.pathname).toBe('/checkout/identical');
  expect(classify(doc.body)).toBe('supported');
  expect(doc.querySelectorAll('form,input,select')).toHaveLength(0);
  dom.window.close();
});

test('serves separate clean and dynamic fake checkout fixtures for manual integrity QA', () => {
  expect(fixtureForRequest('/checkout/clean')).toBe('clean');
  expect(fixtureForRequest('/checkout/dynamic-beta')).toBe('dynamic');
  expect(() => fixtureForRequest('/')).toThrow('unknown manual QA fixture request');
});

test('responds once with a 404 for incidental manual-runner requests', () => {
  const response = { writeHead: vi.fn(), end: vi.fn() };
  serveFixture('/favicon.ico', response, { clean: 'clean', dynamic: 'dynamic' });
  expect(response.writeHead).toHaveBeenCalledExactlyOnceWith(404, { 'content-type': 'text/plain; charset=utf-8' });
  expect(response.end).toHaveBeenCalledExactlyOnceWith('not found');
});

test('responds once with the requested manual fixture', () => {
  const response = { writeHead: vi.fn(), end: vi.fn() };
  const cleanFixture = 'clean';
  serveFixture('/checkout/clean', response, { clean: cleanFixture, dynamic: 'dynamic' });
  expect(response.writeHead).toHaveBeenCalledExactlyOnceWith(200, { 'content-type': 'text/html; charset=utf-8' });
  expect(response.end).toHaveBeenCalledExactlyOnceWith(cleanFixture);
});

test('derives the navigated fixture origin only from the runner-owned 127.0.0.1 listener', () => {
  expect(fixtureOriginForServerAddress({ address: '127.0.0.1', port: 43123 })).toBe('https://checkout-a.test:43123');
  expect(() => fixtureOriginForServerAddress({ address: '127.0.0.2', port: 43123 })).toThrow('fixture server must bind exactly to 127.0.0.1');
  expect(() => fixtureOriginForServerAddress({ address: '127.0.0.1', port: 0 })).toThrow('fixture server did not expose a valid TCP port');
});

test('restricts review Chromium to only its 127.0.0.1 fixture and disables implicit loopback bypass', () => {
  const extensionPath = resolve(root, 'dist');
  expect(restrictedBrowserArgs(extensionPath)).toEqual([
    '--enable-unsafe-extension-debugging',
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=<-loopback>;checkout-a.test;checkout-b.test',
    '--host-resolver-rules=MAP checkout-a.test 127.0.0.1, MAP checkout-b.test 127.0.0.1, MAP * ~NOTFOUND',
    '--disable-quic',
  ]);
  expect(reviewBrowserLaunchOptions(extensionPath)).toEqual({
    channel: 'chromium',
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: restrictedBrowserArgs(extensionPath),
  });
  expect(() => assertFixtureOrigin('https://checkout-a.test:43123')).not.toThrow();
  for (const origin of ['http://localhost:43123', 'http://127.0.0.2:43123', 'https://127.0.0.1:43123', 'http://127.0.0.1:0']) {
    expect(() => assertFixtureOrigin(origin)).toThrow('fixture origin must be exactly https://checkout-a.test:<port>');
  }
});

test('retains digest and boolean predicates only, and detects a changed host field', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form action="https://fixture.invalid/checkout"><input name="email" value="fixture@example.invalid"></form>
      <button type="button">Continue</button><a href="/terms">Terms</a>
    `);

    await captureIntegrityBaseline(page);
    const retainedState = await page.evaluate(() => window.__clearchoiceManualIntegrityBaseline);
    expect(Object.keys(retainedState).sort()).toEqual(['digest', 'predicates']);
    expect(Object.keys(retainedState.predicates)).toEqual(['integrity']);
    expect(retainedState.predicates.integrity).toBe(true);
    expect(retainedState.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(retainedState)).not.toContain('fixture@example.invalid');
    expect(JSON.stringify(retainedState)).not.toContain('fixture.invalid');

    await page.locator('input').fill('changed@example.invalid');
    await expect(integrityPassed(page)).resolves.toBe(false);
    await expect(page.evaluate(() => window.__clearchoiceManualIntegrityBaseline.predicates.integrity)).resolves.toBe(false);

    expect(() => createManualActiveTabQaMarker({ commit: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), archiveSha256: 'c'.repeat(64) })).toThrow('workflow results');
  } finally {
    await browser.close();
  }
});

test('manual runner never writes a caller-provided marker below an external parent symlink to the repository', async () => {
  const markerDirectory = await mkdtemp(resolve(tmpdir(), 'clearchoice-marker-parent-symlink-'));
  temporaryPaths.push(markerDirectory);
  const markerParent = resolve(markerDirectory, 'marker-parent');
  const repositoryTarget = resolve(root, '.manual-active-tab-qa-parent-symlink.json');
  const markerPath = resolve(markerParent, 'manual-active-tab-qa.json');
  await symlink(root, markerParent);

  await expect(runManualActiveTabQa(['--marker', markerPath])).rejects.toThrow('usage: node scripts/manual-active-tab-qa.mjs');
  await expect(lstat(repositoryTarget)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('manual runner never writes a caller-provided marker after its external parent is swapped to the repository', async () => {
  const markerDirectory = await mkdtemp(resolve(tmpdir(), 'clearchoice-marker-parent-swap-'));
  temporaryPaths.push(markerDirectory);
  const markerParent = resolve(markerDirectory, 'marker-parent');
  const repositoryTarget = resolve(root, '.manual-active-tab-qa-parent-swap.json');
  const markerPath = resolve(markerParent, 'manual-active-tab-qa.json');
  await mkdir(markerParent);
  await rm(markerParent, { recursive: true });
  await symlink(root, markerParent);

  await expect(runManualActiveTabQa(['--marker', markerPath])).rejects.toThrow('usage: node scripts/manual-active-tab-qa.mjs');
  await expect(lstat(repositoryTarget)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('Chromium reaches the pinned HTTPS fixture but cannot reach 127.0.0.2 or a non-loopback address', async () => {
  const tls = await createFixtureTls();
  const fixture = await listen('127.0.0.1', 0, 'fixture', tls);
  const alternate = await listen('127.0.0.2', fixture.server.address().port, 'alternate');
  const profile = await mkdtemp(resolve(tmpdir(), 'clearchoice-proxy-boundary-'));
  temporaryPaths.push(profile);
  let browser;
  try {
    browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      args: reviewBrowserLaunchOptions(resolve(root, 'dist'), tls.pin).args,
    });
    const page = await browser.newPage();
    await expect(page.goto(`https://checkout-a.test:${fixture.server.address().port}`, { timeout: 5_000 })).resolves.toBeTruthy();
    await expect(page.goto(alternate.origin, { timeout: 5_000 })).rejects.toThrow();
    await expect(page.goto('http://198.51.100.1:8080/', { timeout: 5_000 })).rejects.toThrow();
    expect(fixture.requests).toBeGreaterThan(0);
    expect(alternate.requests).toBe(0);
  } finally {
    await browser?.close();
    await runCleanupSteps([() => close(fixture.server), () => close(alternate.server), () => tls.cleanup()]);
  }
});
