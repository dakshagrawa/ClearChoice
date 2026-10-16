import { expect, test } from 'vitest';

const fixture = 'class Store { upsertFindings(batch_$, canonical_9, context){return run(async()=>{const candidates_$=[];if(candidates_$.length>cap_9)throw new CapacityFault_$ ("Review history capacity exceeded");});}}';
const resolve = async source => (await import('../e2e/capacity-debugger.ts')).resolveCapacityDebugger(source);

test('resolves renamed batch, canonical origin, candidates and exact throw position', async () => {
  const result = await resolve('\n' + fixture);
  expect(result).toEqual({ request: 'batch_$', origin: 'canonical_9', candidates: 'candidates_$', constructor: 'CapacityFault_$', offset: 133, lineNumber: 1, columnNumber: 132 });
});

for (const [name, source] of [
  ['missing marker', fixture.replace('Review history capacity exceeded', 'other')],
  ['duplicate marker', fixture + ';"Review history capacity exceeded"'],
  ['missing method', fixture.replace('upsertFindings', 'other')],
  ['duplicate method', fixture + 'class Other {upsertFindings(a,b){}}'],
  ['invalid request parameter', fixture.replace('batch_$,', '{batch_$},')],
  ['missing origin parameter', fixture.replace('batch_$, canonical_9, context', 'batch_$')],
  ['invalid candidate condition', fixture.replace('candidates_$.length', 'getCandidates().length')],
  ['missing candidate condition', fixture.replace('if(candidates_$.length>cap_9)', '')],
  ['wrong comparison', fixture.replace('.length>', '.length>=')],
  ['throw outside method', 'class Store {upsertFindings(a,b){}};if(rows.length>limit)throw new Fault("Review history capacity exceeded");'],
]) {
  test(`fails closed for ${name}`, async () => {
    const { resolveCapacityDebugger } = await import('../e2e/capacity-debugger.ts');
    expect(() => resolveCapacityDebugger(source)).toThrow(/Capacity diagnostic/);
  });
}
