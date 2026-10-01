// @vitest-environment node
import { expect, test } from 'vitest';
import { WORKFLOW_PREDICATES } from '../scripts/active-tab-qa.mjs';
import { createManualActiveTabQaMarker } from '../scripts/manual-active-tab-qa.mjs';
import { runHumanStage } from '../scripts/manual-qa-stages.mjs';

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
