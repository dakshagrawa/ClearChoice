import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveContentReplyDebugger } from '../e2e/content-reply-debugger.ts';

const emitted = readFileSync('dist/content.js', 'utf8');
const fixture = 'const ae="CLEARCHOICE_AUTO_SUBMIT";async function At(e,t,n){const r={type:ae,version:1,generation:e,batch:t};if(n?.aborted||v.size>=he||v.has(t.requestId)||!lt(r))throw new Error("Automatic observation unavailable");const i=Symbol();v.set(t.requestId,i);const s=()=>{v.get(t.requestId)===i&&v.delete(t.requestId)};n?.addEventListener("abort",s,{once:!0});try{let o;try{o=await chrome.runtime.sendMessage(r)}catch{throw new A(!0)}if(typeof o=="object"&&o!==null&&Object.keys(o).length===2&&"ok"in o&&o.ok===!1&&"error"in o&&(o.error==="retryable-failure"||o.error==="request-failed"))throw new A(o.error==="retryable-failure");if(typeof o!="object"||o===null||Object.keys(o).length!==2||!("ok"in o)||o.ok!==!0||!("findingCount"in o)||o.findingCount!==t.findings.length)throw new Error("Automatic observation refused");return{ok:!0,findingCount:t.findings.length}}finally{s(),n?.removeEventListener("abort",s)}}';

test('resolves the actual emitted submission checkpoint', () => {
  const result = resolveContentReplyDebugger(emitted);
  expect(emitted.slice(result.offset)).toMatch(/^if\(typeof /);
  expect(result.condition).toContain('CLEARCHOICE_AUTO_SUBMIT');
  expect(result.identityExpression).toContain('opaqueFingerprint:f.opaqueFingerprint');
});
for (const suffix of ['_$', '_renamed9']) test(`resolves all renamed lexical bindings ${suffix}`, () => {
  const renamed = fixture.replace(/\b(At|e|t|n|r|ae|v|he|lt|i|s|o|A)\b/g, '$1' + suffix);
  const result = resolveContentReplyDebugger(renamed);
  expect(result.expression).toContain(`reply:o${suffix}`);
  expect(result.expression).toContain(`generation:r${suffix}.generation`);
  expect(result.condition).toContain(`r${suffix}.type`);
});
for (const [name, source] of [
  ['wrong protocol', fixture.replace('CLEARCHOICE_AUTO_SUBMIT', 'CLEARCHOICE_AUTO_DOCUMENT_STATUS')],
  ['missing', 'function unrelated(){}'],
  ['ambiguous', fixture + fixture],
  ['reordered validation', fixture.replace('o!==null&&Object.keys(o).length===2', 'Object.keys(o).length===2&&o!==null')],
  ['wrong receipt identity', fixture.replaceAll('t.requestId', 't.otherId')],
  ['missing positive validation', fixture.replace('o.findingCount!==t.findings.length', 'false')],
  ['retry semantics', fixture.replaceAll('retryable-failure', 'request-failed')],
]) test(`fails closed: ${name}`, () => expect(() => resolveContentReplyDebugger(source)).toThrow(/Content reply diagnostic/));
