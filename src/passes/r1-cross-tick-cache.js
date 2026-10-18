/**
 * R1 cross-tick-cache — RISKY.
 *
 * Module-level WeakMap caches keyed by entity/player for
 * `getComponent("...")` results and for immutable-per-entity fields
 * (`entity.id`, `entity.typeId`), reused across ticks with no invalidation.
 *
 * Failure mode: stale component views after death / dimension change. Even the
 * immutable subset is reported as risky (a hostile addon could mutate id).
 *
 * Applied to reads inside hot functions only. Every application emits a
 * warning in the report.
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';

const _traverse = traverse.default || traverse;

export const ID = 'cross-tick-cache';
export const CODE = 'R1';

function isWriteTargetPath(memberPath) {
  const parent = memberPath.parent;
  if (t.isAssignmentExpression(parent) && parent.left === memberPath.node) return true;
  if (t.isUpdateExpression(parent) && parent.argument === memberPath.node) return true;
  if (t.isUnaryExpression(parent) && parent.operator === 'delete' && parent.argument === memberPath.node) return true;
  return false;
}

export default function crossTickCache(programPath, ctx) {
  const edits = []; // { kind: 'component'|'field', line, node, stmt, recvNode, key }
  let sawAny = false;

  programPath.traverse({
    'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression'(path) {
      const fn = path.node;
      if (!ctx.isHot(fn)) return;
      if (ctx.isDisabled(path, ID, CODE)) return;

      // ---- component reads: X.getComponent("lit")
      path.traverse({
        CallExpression(cp) {
          const n = cp.node;
          if (cp.parentPath && isWriteTargetCall(cp)) return;
          if (!(t.isMemberExpression(n.callee) && !n.callee.computed &&
                t.isIdentifier(n.callee.property) && n.callee.property.name === 'getComponent' &&
                n.arguments.length === 1 && t.isStringLiteral(n.arguments[0]))) return;
          const obj = n.callee.object;
          if (!t.isIdentifier(obj) && !t.isThisExpression(obj)) return;
          edits.push({
            kind: 'component',
            line: n.loc ? n.loc.start.line : 0,
            node: n,
            fnPath: path,
            recvName: t.isIdentifier(obj) ? obj.name : null,
            isThis: t.isThisExpression(obj),
            key: n.arguments[0].value,
          });
        },
        MemberExpression(mp) {
          const n = mp.node;
          if (isWriteTargetPath(mp)) return;
          if (mp.parentPath && t.isCallExpression(mp.parentPath.node) && mp.parentPath.node.callee === n) return;
          if (!(!n.computed && t.isIdentifier(n.property) && (n.property.name === 'id' || n.property.name === 'typeId'))) return;
          const obj = n.object;
          if (!t.isIdentifier(obj)) return;
          edits.push({
            kind: 'field',
            line: n.loc ? n.loc.start.line : 0,
            node: n,
            fnPath: path,
            recvName: obj.name,
            isThis: false,
            key: n.property.name,
          });
        },
      });
    },
  });

  if (edits.length === 0) return;

  // Group by (receiver identity, key) to share cache slots; rewrite within the
  // owning statement.
  const seen = new Set();
  for (const e of edits) {
    if (seen.has(e.node)) continue;
    seen.add(e.node);
    const helper = e.kind === 'component' ? '__opR1Component' : '__opR1Field';
    const recv = e.isThis ? t.thisExpression() : t.identifier(e.recvName);
    const call = t.callExpression(t.identifier(helper), [recv, t.stringLiteral(e.key)]);
    // Replace within the enclosing hot function body subtree.
    const root = e.fnPath.node.body;
    if (replaceInTree(root, e.node, call)) {
      sawAny = true;
      ctx.applied(ID);
      ctx.warn(e.line, CODE,
        e.kind === 'component'
          ? `getComponent("${e.key}") cached across ticks in a WeakMap — stale after death/dimension change`
          : `.${e.key} cached across ticks in a WeakMap — stale if mutated`);
    }
  }

  if (sawAny) {
    injectHelpers(programPath);
  }
}

function isWriteTargetCall(cp) {
  const parent = cp.parentPath && cp.parentPath.node;
  return t.isAssignmentExpression(parent) && parent.left === cp.node;
}

function replaceInTree(rootNode, oldNode, newNode) {
  const stack = [rootNode];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    for (const key of Object.keys(cur)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra') continue;
      const v = cur[key];
      if (v === oldNode) { cur[key] = newNode; return true; }
      if (Array.isArray(v)) {
        const idx = v.indexOf(oldNode);
        if (idx >= 0) { v[idx] = newNode; return true; }
        for (const item of v) if (item && typeof item === 'object' && typeof item.type === 'string') stack.push(item);
      } else if (v && typeof v === 'object' && typeof v.type === 'string') {
        stack.push(v);
      }
    }
  }
  return false;
}

function injectHelpers(programPath) {
  const body = programPath.node.body;
  let lastImport = -1;
  for (let i = 0; i < body.length; i++) {
    if (t.isImportDeclaration(body[i])) lastImport = i;
  }
  body.splice(lastImport + 1, 0, ...buildHelperStatements());
}

function buildHelperStatements() {
  const cacheMap = t.identifier('__opR1Cache');

  const cacheGetFn = (name, readExpr) => {
    // function name(obj, key) { ... }
    const obj = t.identifier('obj');
    const key = t.identifier('key');
    const m = t.identifier('m');
    const v = t.identifier('v');
    return t.functionDeclaration(
      t.identifier(name),
      [obj, key],
      t.blockStatement([
        t.variableDeclaration('let', [t.variableDeclarator(m,
          t.callExpression(t.memberExpression(cacheMap, t.identifier('get')), [obj]))]),
        t.ifStatement(
          t.binaryExpression('===', m, t.identifier('undefined')),
          t.blockStatement([
            t.expressionStatement(t.assignmentExpression('=', m,
              t.newExpression(t.identifier('Map'), []))),
            t.expressionStatement(t.callExpression(
              t.memberExpression(cacheMap, t.identifier('set')), [obj, m])),
          ])
        ),
        t.variableDeclaration('let', [t.variableDeclarator(v,
          t.callExpression(t.memberExpression(m, t.identifier('get')), [key]))]),
        t.ifStatement(
          t.binaryExpression('===', v, t.identifier('undefined')),
          t.blockStatement([
            t.expressionStatement(t.assignmentExpression('=', v, readExpr(obj, key))),
            t.expressionStatement(t.callExpression(
              t.memberExpression(m, t.identifier('set')), [key, v])),
          ])
        ),
        t.returnStatement(v),
      ])
    );
  };

  return [
    t.variableDeclaration('const', [
      t.variableDeclarator(cacheMap, t.newExpression(t.identifier('WeakMap'), [])),
    ]),
    cacheGetFn('__opR1Component', (obj, key) =>
      t.callExpression(t.memberExpression(obj, t.identifier('getComponent')), [key])),
    cacheGetFn('__opR1Field', (obj, key) =>
      t.memberExpression(obj, key, true)),
  ];
}
