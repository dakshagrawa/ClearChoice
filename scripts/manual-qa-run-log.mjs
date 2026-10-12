// Local diagnostics ONLY: never human evidence, consent or an attestation.
import { constants, mkdirSync, lstatSync, openSync, fstatSync, closeSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const checkpoints = new Set(['setup', ...Array.from({ length: 37 }, (_, i) => String(i + 1)), '15a', '15b', '15c', '15d', '15e', '15f', '15g', '17a', '17b', '23a', '23b']);
const acknowledgements = new Set(['DONE', 'RESTORED', 'ANALYZED', 'DENIED', 'KEYBOARD_AND_POINTER_REVIEWED', 'REENABLE_CONFIRMED', 'CHROME_SETTINGS_A_REMOVED', 'SYNTHETIC_EXPIRY_REVIEWED', 'PUBLIC_GUIDES_AND_CATALOG_REVIEWED', 'ATTEST']);
const eventCodes = { start: 'run_started', binding: 'artifact_bound', checkpoint: 'stage_started', ack_wait: 'ack_wait', ack: 'ack_observed', observation: 'observation', stall: 'waiting', issue: 'issue', failure: 'run_failed', cancellation: 'run_cancelled', end: 'run_completed' };
const bools = new Set(['supported', 'uniquePanel', 'dismissPresent', 'visible', 'enabled', 'inViewport', 'pointerHit', 'reachable', 'integrity', 'href', 'forms', 'controlIdentity', 'controlValues', 'controlChecked', 'controlDisabled', 'hostNodes', 'observed', 'acknowledged', 'actionObserved', 'hasGrant', 'sitePermission', 'registered', 'expectedHasGrant']);
const counts = new Set(['panelCount', 'findingCount', 'badgeCount', 'historyCount', 'subscriptionCount', 'permissionCount', 'scriptCount', 'grantCount']);
const routes = new Set(['clean', 'dynamic', 'identical', 'information', 'unknown']);
const errors = new Set(['qa_failure', 'qa_timeout', 'qa_interrupted', 'spa_exit_panel_retained', 'spa_exit_badge_retained', 'spa_return_panel_missing', 'observed_state_changed']);
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).every(key => typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(value, key));
function validSnapshot(value) {
  if (!plain(value)) return false;
  return Object.entries(value).every(([key, item]) => {
    if (bools.has(key)) return typeof item === 'boolean';
    if (key === 'route') return routes.has(item);
    if (key === 'site') return ['a', 'b'].includes(item);
    if (counts.has(key)) return Number.isInteger(item) && item >= 0 && item <= 10000;
    if (['viewport', 'hostBounds', 'panelBounds', 'dismissBounds'].includes(key)) return item === null || plain(item)
      && Object.keys(item).length === (key === 'viewport' ? 2 : 4)
      && Object.entries(item).every(([axis, number]) => (key === 'viewport' ? ['width', 'height'] : ['x', 'y', 'width', 'height']).includes(axis) && Number.isFinite(number) && Math.abs(number) <= 100000);
    return false;
  });
}
const ownedDirectory = path => {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('unsafe diagnostic directory');
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(fd);
  if (opened.ino !== stat.ino || opened.dev !== stat.dev) { closeSync(fd); throw Error('diagnostic directory changed'); }
  return fd;
};
const descriptorPath = fd => `/proc/self/fd/${fd}`;
function atomic(fd, name, data) {
  const temporary = join(descriptorPath(fd), `${name}.${randomUUID()}.tmp`);
  try {
    const output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(output, JSON.stringify(data) + '\n'); } finally { closeSync(output); }
    renameSync(temporary, join(descriptorPath(fd), name));
  } finally { try { unlinkSync(temporary); } catch { /* already renamed */ } }
}
export function createQaRunLog({ directory = process.env.CLEARCHOICE_QA_LOG_DIR || join(homedir(), 'ClearChoice_QA') } = {}) {
  const runId = randomUUID();
  const started = Date.now();
  const name = `run-${started}-${runId}`;
  let rootFd; let runFd; let eventFd; let closed = false; let attention = false; let sequence = 0; let written = 0;
  const data = { schemaVersion: 1, runId, status: 'running', checkpoint: 'setup', droppedEvents: 0, events: [] };
  let path = null; let runDirectory = null;
  try {
    if (process.platform !== 'linux') throw Error('unsupported diagnostic platform');
    directory = resolve(directory);
    // Configuration selects a directory, never a caller-provided payload/file name.
    if (directory === resolve(import.meta.dirname, '..') || directory.startsWith(resolve(import.meta.dirname, '..') + '/')) throw Error('diagnostics must stay outside repository');
    try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    rootFd = ownedDirectory(directory);
    directory = realpathSync(directory);
    const repository = realpathSync(resolve(import.meta.dirname, '..'));
    if (directory === repository || directory.startsWith(repository + '/')) throw Error('diagnostics must stay physically outside repository');
    // Names, ownership and permissions do not prove a prior directory is ours.
    // Never prune existing runs or their contents; only this new run is written.
    mkdirSync(join(descriptorPath(rootFd), name), { mode: 0o700 });
    runFd = ownedDirectory(join(descriptorPath(rootFd), name));
    eventFd = openSync(join(descriptorPath(runFd), 'events.jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    runDirectory = join(directory, name); path = join(runDirectory, 'summary.json');
  } catch {
    for (const fd of [eventFd, runFd, rootFd]) if (fd !== undefined) closeSync(fd);
    eventFd = runFd = rootFd = undefined; closed = true;
    process.stderr.write('Local QA diagnostics unavailable (qa_log_unavailable); human gate is unchanged.\n');
  }
  const record = (event, fields = {}) => {
    if (closed || !Object.hasOwn(eventCodes, event) || !plain(fields)) return false;
    if (Reflect.ownKeys(fields).some(key => !['checkpoint', 'token', 'snapshot', 'binding', 'errorCode'].includes(key))) return false;
    if ('binding' in fields && (!plain(fields.binding) || Reflect.ownKeys(fields.binding).length !== 3
      || ['commit', 'manifestSha256', 'archiveSha256'].some(key => typeof fields.binding[key] !== 'string')
      || !/^[a-f0-9]{40}$/.test(fields.binding.commit) || !/^[a-f0-9]{64}$/.test(fields.binding.manifestSha256) || !/^[a-f0-9]{64}$/.test(fields.binding.archiveSha256))) return false;
    if ('checkpoint' in fields && !checkpoints.has(fields.checkpoint) || 'token' in fields && !acknowledgements.has(fields.token)
      || 'snapshot' in fields && !validSnapshot(fields.snapshot) || 'errorCode' in fields && !errors.has(fields.errorCode)) return false;
    if (event === 'issue' && !fields.errorCode) return false;
    const terminal = ['failure', 'cancellation', 'end'].includes(event);
    // Reserve room for the terminal outcome. JSONL is append-only and bounded.
    if (!terminal && written >= (event === 'issue' ? 1999 : 1998)) { data.droppedEvents++; return false; }
    if (fields.checkpoint) data.checkpoint = fields.checkpoint;
    if (fields.binding) data.binding = structuredClone(fields.binding);
    attention ||= ['issue', 'failure', 'cancellation'].includes(event);
    data.status = ['checkpoint', 'ack_wait', 'stall', 'issue'].includes(event) ? 'waiting' : event === 'failure' ? 'failed' : event === 'cancellation' ? 'cancelled' : event === 'end' ? 'completed' : event === 'observation' ? data.status : 'running';
    const entry = { schemaVersion: 1, runId, eventId: `${runId}:${++sequence}`, at: new Date().toISOString(), elapsedMs: Math.max(0, Date.now() - started),
      event: eventCodes[event], status: data.status, checkpoint: data.checkpoint, stageId: data.checkpoint, needsAttention: attention,
      ...(data.binding ? { binding: data.binding } : {}), ...structuredClone(fields) };
    try {
      writeFileSync(eventFd, JSON.stringify(entry) + '\n'); written++;
      data.events.push(entry); if (data.events.length > 128) data.events.shift();
      atomic(runFd, 'summary.json', { ...data, needsAttention: attention, endedAt: terminal ? entry.at : null });
      if (event === 'issue') atomic(runFd, 'issue.json', entry);
      if (['failure', 'cancellation'].includes(event)) atomic(runFd, 'failure.json', entry);
      // Samples must not hide an actionable issue from an event-driven watcher.
      if (!attention || ['issue', 'failure', 'cancellation', 'end'].includes(event)) atomic(rootFd, 'latest.json', entry);
      return true;
    } catch { process.stderr.write('Local QA diagnostic write failed (qa_log_write_failed); human gate is unchanged.\n'); return false; }
  };
  const finish = (error, { failed = error !== undefined, interrupted = false } = {}) => {
    if (closed) return;
    // Inspect only an own data property: arbitrary thrown values can have hostile
    // getters/proxies. Their identity and contents must never become diagnostics.
    let errorName;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error ?? {}, 'name');
      if (descriptor) errorName = descriptor.value;
      else {
        // Call only the native brand-checked getter, never error.name. AbortSignal
        // uses DOMException with an inherited name accessor for aborts/timeouts.
        errorName = Object.getOwnPropertyDescriptor(globalThis.DOMException.prototype, 'name').get.call(error);
      }
    } catch { /* opaque failure */ }
    const cancelled = interrupted || failed && errorName === 'AbortError';
    try {
      record(cancelled ? 'cancellation' : failed ? 'failure' : 'end', cancelled || failed
        ? { errorCode: cancelled ? 'qa_interrupted' : errorName === 'TimeoutError' ? 'qa_timeout' : 'qa_failure' } : {});
    } finally {
      closed = true;
      for (const fd of [eventFd, runFd, rootFd]) {
        try { closeSync(fd); } catch { /* diagnostics must not replace the QA outcome */ }
      }
    }
  };
  record('start');
  return { path, directory: runDirectory, runId, record, finish };
}

// Observed route transitions are explicit action evidence, not human consent.
// Never report a mismatch merely because the human has not acted yet.
export function createQaMismatchMonitor(log, { settleMs = 3000 } = {}) {
  let stage; let prior; let action = false; let since; let emitted = false;
  return {
    stage(id) { stage = checkpoints.has(id) ? id : null; action = false; since = undefined; emitted = false; },
    sample(snapshot, now = Date.now()) {
      if (!validSnapshot(snapshot)) return;
      if (stage === '15f' && prior?.route === 'identical' && snapshot.route === 'information') action = true;
      if (stage === '15g' && prior?.route === 'information' && snapshot.route === 'identical') action = true;
      prior = structuredClone(snapshot);
      let errorCode;
      if (action && stage === '15f' && snapshot.route === 'information') {
        if (snapshot.panelCount > 0) errorCode = 'spa_exit_panel_retained';
        else if (snapshot.badgeCount > 0) errorCode = 'spa_exit_badge_retained';
      }
      if (action && stage === '15g' && snapshot.route === 'identical' && snapshot.panelCount === 0) errorCode = 'spa_return_panel_missing';
      if (!errorCode) { since = undefined; return; }
      since ??= now;
      if (!emitted && now - since >= settleMs) {
        emitted = log.record('issue', { checkpoint: stage, errorCode, snapshot: { ...snapshot, actionObserved: true } });
      }
    },
  };
}
export function checkpointId(instruction) {
  const id = /^(\d+[a-z]?)\./.exec(instruction)?.[1]; return checkpoints.has(id) ? id : null;
}
export function acknowledgementToken(prompt) {
  const token = /Type ([A-Z_]+)/.exec(prompt)?.[1]; return acknowledgements.has(token) ? token : null;
}
