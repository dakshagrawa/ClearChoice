import ts from 'typescript';

// Parse the built worker, never assume minifier aliases. Unsupported shapes fail closed.
export function resolveCapacityDebugger(source: string) {
  const fail = (): never => { throw Error('Capacity diagnostic worker structure missing or ambiguous'); };
  const marker = 'Review history capacity exceeded';
  if (source.split(marker).length !== 2) fail();
  const file = ts.createSourceFile('worker.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const methods: ts.MethodDeclaration[] = [];
  const markers: ts.StringLiteral[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(file) === 'upsertFindings') methods.push(node);
    if (ts.isStringLiteral(node) && node.text === marker) markers.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (methods.length !== 1 || markers.length !== 1) fail();
  const method = methods[0];
  const identifier = (node: ts.Node | undefined): string => {
    if (!node || !ts.isIdentifier(node) || !/^[A-Za-z_$][\w$]*$/.test(node.getText(file))) return fail();
    return node.getText(file);
  };
  const parameter = (index: number) => {
    const param = method.parameters[index];
    if (!param || param.dotDotDotToken || param.initializer) return fail();
    return identifier(param.name);
  };
  const request = parameter(0);
  const origin = parameter(1);
  if (request === origin) fail();
  const literal = markers[0];
  const construction = literal.parent;
  if (!ts.isNewExpression(construction) || construction.arguments?.length !== 1 || construction.arguments[0] !== literal) return fail();
  const constructor = identifier(construction.expression);
  const statement = construction.parent;
  if (!ts.isThrowStatement(statement)) return fail();
  const branch = statement.parent;
  if (!ts.isIfStatement(branch) || branch.thenStatement !== statement || branch.elseStatement) return fail();
  const condition = branch.expression;
  if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.GreaterThanToken
    || !ts.isPropertyAccessExpression(condition.left) || condition.left.name.text !== 'length') return fail();
  const candidates = identifier(condition.left.expression);
  identifier(condition.right);
  let owner: ts.Node | undefined = branch.parent;
  while (owner && owner !== method) owner = owner.parent;
  if (!owner) fail();
  const offset = statement.getStart(file);
  const { line: lineNumber, character: columnNumber } = file.getLineAndCharacterOfPosition(offset);
  return { request, origin, candidates, constructor, offset, lineNumber, columnNumber };
}
