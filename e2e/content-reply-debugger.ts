import ts from 'typescript';

// A bounded AST grammar for the emitted automatic batch submission. Every binding
// is unified consistently; globals, properties, ordering and both reply guards
// stay exact. Unsupported bundle rewrites fail closed rather than guessing locals.
const grammar = 'async function $function($generation,$batch,$signal){const $request={type:$protocol,version:1,generation:$generation,batch:$batch};if($signal?.aborted||$pending.size>=$limit||$pending.has($batch.requestId)||!$validate($request))throw new Error("Automatic observation unavailable");const $token=Symbol();$pending.set($batch.requestId,$token);const $retire=()=>{$pending.get($batch.requestId)===$token&&$pending.delete($batch.requestId)};$signal?.addEventListener("abort",$retire,{once:!0});try{let $reply;try{$reply=await chrome.runtime.sendMessage($request)}catch{throw new $failure(!0)}if(typeof $reply=="object"&&$reply!==null&&Object.keys($reply).length===2&&"ok"in $reply&&$reply.ok===!1&&"error"in $reply&&($reply.error==="retryable-failure"||$reply.error==="request-failed"))throw new $failure($reply.error==="retryable-failure");if(typeof $reply!="object"||$reply===null||Object.keys($reply).length!==2||!("ok"in $reply)||$reply.ok!==!0||!("findingCount"in $reply)||$reply.findingCount!==$batch.findings.length)throw new Error("Automatic observation refused");return{ok:!0,findingCount:$batch.findings.length}}finally{$retire(),$signal?.removeEventListener("abort",$retire)}}';
export function resolveContentReplyDebugger(source: string) {
  const fail = (): never => { throw Error('Content reply diagnostic structure missing or ambiguous'); };
  const parse = (text: string) => ts.createSourceFile('content.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const patternFile = parse(grammar);
  const file = parse(source);
  const matches: { node: ts.FunctionDeclaration; names: Map<string, string> }[] = [];
  const match = (pattern: ts.Node, actual: ts.Node, names: Map<string, string>): boolean => {
    if (pattern.kind !== actual.kind) return false;
    if (ts.isIdentifier(pattern) && pattern.text.startsWith('$')) {
      if (!ts.isIdentifier(actual)) return false;
      const previous = names.get(pattern.text);
      if (previous) return previous === actual.text;
      if ([...names.values()].includes(actual.text)) return false;
      names.set(pattern.text, actual.text);
      return true;
    }
    const left = pattern.getChildren(patternFile), right = actual.getChildren(file);
    if (!left.length && !right.length) return pattern.getText(patternFile) === actual.getText(file);
    return left.length === right.length && left.every((child, index) => match(child, right[index], names));
  };
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node)) {
      const names = new Map<string, string>();
      if (match(patternFile.statements[0], node, names)) matches.push({ node, names });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (matches.length !== 1) return fail();
  const { node, names } = matches[0];
  const name = (key: string) => names.get('$' + key) ?? fail();
  const protocols: ts.VariableDeclaration[] = [];
  const protocolBindings = (child: ts.Node) => {
    if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.name.text === name('protocol')) protocols.push(child);
    ts.forEachChild(child, protocolBindings);
  };
  protocolBindings(file);
  if (protocols.length !== 1 || !protocols[0].initializer || !ts.isStringLiteral(protocols[0].initializer)
    || protocols[0].initializer.text !== 'CLEARCHOICE_AUTO_SUBMIT') return fail();
  const checkpoints: ts.IfStatement[] = [];
  const find = (child: ts.Node) => {
    if (ts.isIfStatement(child) && child.expression.getText(file).includes('"retryable-failure"')) checkpoints.push(child);
    ts.forEachChild(child, find);
  };
  find(node);
  if (checkpoints.length !== 1) return fail();
  const offset = checkpoints[0].getStart(file);
  const { line: lineNumber, character: columnNumber } = file.getLineAndCharacterOfPosition(offset);
  const batch = name('batch'), request = name('request'), reply = name('reply');
  const condition = `${request}.type === "CLEARCHOICE_AUTO_SUBMIT"`;
  const expression = (identities = false) => `({requestId:${batch}.requestId,origin:location.origin,generation:${request}.generation,findings:${batch}.findings.${identities ? 'map(f=>({opaqueFingerprint:f.opaqueFingerprint,ordinal:f.ordinal}))' : 'length'},reply:${reply},pending:${name('pending')}.has(${batch}.requestId),aborted:!!${name('signal')}?.aborted})`;
  return { pending: name('pending'), offset, lineNumber, columnNumber, condition, rejectionCondition: `${condition} && ${reply}?.ok === false`, expression: expression(), identityExpression: expression(true) };
}
