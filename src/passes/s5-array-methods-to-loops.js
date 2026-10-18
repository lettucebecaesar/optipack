/**
 * S5 array-methods-to-loops — hot-path only.
 *
 * In hot functions, inline-arrow `.forEach`, `.map`, `.filter`, `.some`,
 * `.every`, `.find` calls become plain indexed loops. Every method-call
 * allocation (iterator + callback invocation machinery) disappears.
 *
 * Bail conditions:
 *  - callback is not an inline arrow/function expression
 *  - callback uses `this` or `arguments`, is async, is a generator, or
 *    contains await/yield
 *  - callback parameters are not plain identifiers
 *  - receiver is optionally chained (either via `?.` in the receiver or an
 *    optional call `arr?.map(...)`)
 *  - the call is not unconditionally evaluated within its statement
 *    (conditional expressions, logical right-hand sides, spread, concise
 *    arrow bodies, loop test/update positions)
 *  - receiver provenance may include holes (sparse arrays change
 *    forEach/map/some/every/find/filter semantics)
 *
 * Note: the receiver is always evaluated exactly once (hoisted to a `const`
 * before the loop), so a call-containing receiver never duplicates side
 * effects — this supersedes the "receiver referenced more than once" bail.
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { walk, provablyArray } from '../pass-utils.js';

const _traverse = traverse.default || traverse;

export const ID = 'array-methods-to-loops';
export const CODE = 'S5';

const METHODS = new Set(['forEach', 'map', 'filter', 'some', 'every', 'find']);

// Nodes that make the call conditionally evaluated relative to its statement.
function unconditionalWalk(callPath, stmtPath) {
  let p = callPath.parentPath;
  while (p && p !== stmtPath) {
    const n = p.node;
    if (t.isConditionalExpression(n)) return false;
    if (t.isLogicalExpression(n)) return false;
    if (t.isOptionalCallExpression(n) || t.isOptionalMemberExpression(n)) return false;
    if (t.isSpreadElement(n)) return false;
    if (t.isFunctionExpression(n) || t.isArrowFunctionExpression(n)) return false; // concise body crossing
    if (t.isSwitchStatement(n) || t.isSwitchCase(n)) return false;
    p = p.parentPath;
  }
  if (!p) return false;
  const sn = stmtPath.node;
  if (t.isForStatement(sn) || t.isWhileStatement(sn) || t.isDoWhileStatement(sn)) {
    // The call must live inside the loop body.
    let q = callPath;
    let inBody = false;
    while (q && q.node !== sn) {
      if (q.parentPath && q.parentPath.node === sn && q.parentPath.node.body === q.node) { inBody = true; break; }
      if (q.parentPath && q.parentPath.node === sn && q.key === 'body') { inBody = true; break; }
      q = q.parentPath;
    }
    if (!inBody) return false;
  }
  return true;
}

function callbackIssues(cb) {
  const problems = [];
  if (cb.async) problems.push('async callback');
  if (cb.generator) problems.push('generator callback');
  let sawThis = false;
  let sawArguments = false;
  let sawAwaitYield = false;
  walk(cb.body, (n) => {
    if (t.isThisExpression(n)) { sawThis = true; return false; }
    if (t.isIdentifier(n) && n.name === 'arguments' && !t.isMemberExpression(n)) {
      // crude: any bare `arguments` reference
      sawArguments = true;
      return false;
    }
    if (t.isAwaitExpression(n) || t.isYieldExpression(n)) { sawAwaitYield = true; return false; }
    return true;
  });
  // `arguments` references only count when they resolve outside the callback
  // params — a param named arguments is pathological; treat as a bail.
  if (sawThis) problems.push('callback uses this');
  if (sawArguments) problems.push('callback uses arguments');
  if (sawAwaitYield) problems.push('callback contains await/yield');
  for (const p of cb.params) {
    if (!t.isIdentifier(p)) problems.push('callback parameter is not a plain identifier');
  }
  if (cb.params.length > 3) problems.push('callback has more than 3 parameters');
  return problems;
}

export default function arrayMethodsToLoops(programPath, ctx) {
  const decided = new WeakSet();
  const bailed = new WeakSet();

  const recordBailOnce = (node, line, reason) => {
    if (bailed.has(node)) return;
    bailed.add(node);
    ctx.bail(line, CODE, reason);
  };

  programPath.traverse({
    CallExpression(path) {
      const node = path.node;
      if (decided.has(node)) return;
      decided.add(node);

      const callee = node.callee;
      if (!t.isMemberExpression(callee) || callee.computed) return;
      const prop = callee.property;
      if (!t.isIdentifier(prop) || !METHODS.has(prop.name)) return;
      const line = node.loc ? node.loc.start.line : 0;

      // Hot functions only — silently skip elsewhere.
      const fnParent = path.getFunctionParent();
      if (!fnParent || !ctx.isHot(fnParent.node)) return;
      if (ctx.isDisabled(path, ID, CODE)) return;

      const fail = (reason) => {
        recordBailOnce(node, line, reason);
      };

      if (node.arguments.length !== 1) return fail('expected exactly one callback argument');
      const cb = node.arguments[0];
      if (!t.isArrowFunctionExpression(cb) && !t.isFunctionExpression(cb)) {
        return fail('callback is not an inline function expression');
      }
      const issues = callbackIssues(cb);
      if (issues.length > 0) return fail(issues[0]);

      // Optional chaining anywhere in the receiver or callee → bail.
      let optional = false;
      walk(callee.object, (n) => {
        if (t.isOptionalMemberExpression(n) || t.isOptionalCallExpression(n)) { optional = true; return false; }
        return true;
      });
      if (optional) return fail('receiver is optionally chained');

      // Sparse-array provenance → bail.
      const prov = provablyArray(callee.object, path);
      if (prov.array && prov.holey) return fail('receiver may be a sparse array');

      // Nearest statement ancestor (never crossing a function boundary).
      let stmtPath = path;
      while (stmtPath && !stmtPath.isStatement()) stmtPath = stmtPath.parentPath;
      if (!stmtPath) return fail('no statement ancestor in the same function');
      if (!unconditionalWalk(path, stmtPath)) {
        return fail('call is conditionally evaluated within its statement');
      }

      const method = prop.name;
      const used = !(t.isExpressionStatement(stmtPath.node) && stmtPath.node.expression === node);
      const needsValue = used && method !== 'forEach';

      const scope = stmtPath.scope;
      const arrName = scope.generateUid('opArr');
      const idxName = scope.generateUid('opI');
      const accName = scope.generateUid('opAcc');
      const resName = scope.generateUid('opRes');

      // ---- translate callback body ----
      const p0 = cb.params[0] || null;
      const p1 = cb.params[1] || null;
      const p2 = cb.params[2] || null;
      const elemName = p0 ? p0.name : scope.generateUid('opV');
      const elemKind = p0 && p0.name && scopeHasViolations(scope, p0.name, cb) ? 'let' : 'const';

      const body = t.cloneNode(cb.body, true);
      const bodyStmts = t.isBlockStatement(body) ? body.body : [t.returnStatement(body)];

      const translate = (stmts) => {
        const out = [];
        for (const s of stmts) {
          if (t.isReturnStatement(s)) {
            const arg = s.argument;
            switch (method) {
              case 'forEach':
                if (arg) out.push(t.expressionStatement(arg));
                out.push(t.continueStatement());
                break;
              case 'map':
                if (!used) {
                  if (arg) out.push(t.expressionStatement(arg));
                } else {
                  out.push(t.expressionStatement(
                    t.callExpression(t.memberExpression(t.identifier(accName), t.identifier('push')), [arg || t.identifier('undefined')])
                  ));
                }
                out.push(t.continueStatement());
                break;
              case 'filter':
                if (arg && used) {
                  out.push(t.ifStatement(
                    arg,
                    t.expressionStatement(
                      t.callExpression(t.memberExpression(t.identifier(accName), t.identifier('push')), [t.identifier(elemName)])
                    )
                  ));
                }
                out.push(t.continueStatement());
                break;
              case 'some':
                if (arg) {
                  out.push(t.ifStatement(
                    arg,
                    t.blockStatement([
                      t.expressionStatement(t.assignmentExpression('=', t.identifier(resName), t.booleanLiteral(true))),
                      t.breakStatement(),
                    ])
                  ));
                }
                out.push(t.continueStatement());
                break;
              case 'every':
                if (arg) {
                  out.push(t.ifStatement(
                    t.unaryExpression('!', arg),
                    t.blockStatement([
                      t.expressionStatement(t.assignmentExpression('=', t.identifier(resName), t.booleanLiteral(false))),
                      t.breakStatement(),
                    ])
                  ));
                }
                out.push(t.continueStatement());
                break;
              case 'find':
                if (arg) {
                  out.push(t.ifStatement(
                    arg,
                    t.blockStatement([
                      t.expressionStatement(t.assignmentExpression('=', t.identifier(resName), t.identifier(elemName))),
                      t.breakStatement(),
                    ])
                  ));
                }
                out.push(t.continueStatement());
                break;
              default:
                out.push(s);
            }
            continue;
          }
          if (t.isBlockStatement(s)) {
            s.body = translate(s.body);
            out.push(s);
            continue;
          }
          if (t.isIfStatement(s)) {
            if (s.consequent && t.isBlockStatement(s.consequent)) s.consequent.body = translate(s.consequent.body);
            if (s.alternate && t.isBlockStatement(s.alternate)) s.alternate.body = translate(s.alternate.body);
            out.push(s);
            continue;
          }
          if (t.isForStatement(s) || t.isForOfStatement(s) || t.isForInStatement(s) ||
              t.isWhileStatement(s) || t.isDoWhileStatement(s)) {
            if (s.body && t.isBlockStatement(s.body)) s.body.body = translate(s.body.body);
            out.push(s);
            continue;
          }
          if (t.isTryStatement(s)) {
            if (s.block) s.block.body = translate(s.block.body);
            out.push(s);
            continue;
          }
          if (t.isLabeledStatement(s)) {
            if (s.body && t.isBlockStatement(s.body)) s.body.body = translate(s.body.body);
            out.push(s);
            continue;
          }
          out.push(s);
        }
        return out;
      };

      const translated = translate(bodyStmts);
      // A trailing `continue` translated from a final `return` is redundant
      // *when fall-through behaves identically* — true for every method except
      // map, whose fall-through pushes `undefined`. For map, a trailing
      // continue means the callback never falls through, so the implicit
      // push is dropped along with the continue.
      let endsWithReturn = false;
      if (translated.length > 0 && t.isContinueStatement(translated[translated.length - 1])) {
        translated.pop();
        endsWithReturn = true;
      }
      if (method === 'map' && used && !endsWithReturn) {
        translated.push(t.expressionStatement(
          t.callExpression(t.memberExpression(t.identifier(accName), t.identifier('push')), [t.identifier('undefined')])
        ));
      }

      // ---- assemble loop ----
      const bindDecls = [];
      bindDecls.push(t.variableDeclaration(elemKind, [
        t.variableDeclarator(t.identifier(elemName),
          t.memberExpression(t.identifier(arrName), t.identifier(idxName), true)),
      ]));
      if (p1) {
        bindDecls.push(t.variableDeclaration('const', [t.variableDeclarator(p1, t.identifier(idxName))]));
      }
      if (p2) {
        bindDecls.push(t.variableDeclaration('const', [t.variableDeclarator(p2, t.identifier(arrName))]));
      }

      const loop = t.forStatement(
        t.variableDeclaration('let', [t.variableDeclarator(t.identifier(idxName), t.numericLiteral(0))]),
        t.binaryExpression('<', t.identifier(idxName), t.memberExpression(t.identifier(arrName), t.identifier('length'))),
        t.updateExpression('++', t.identifier(idxName)),
        t.blockStatement([...bindDecls, ...translated])
      );

      const decls = [t.variableDeclaration('const', [t.variableDeclarator(t.identifier(arrName), callee.object)])];
      if ((method === 'map' || method === 'filter') && used) {
        decls.push(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(accName), t.arrayExpression([]))]));
      }
      if (method === 'some') {
        decls.push(t.variableDeclaration('let', [t.variableDeclarator(t.identifier(resName), t.booleanLiteral(false))]));
      } else if (method === 'every') {
        decls.push(t.variableDeclaration('let', [t.variableDeclarator(t.identifier(resName), t.booleanLiteral(true))]));
      } else if (method === 'find') {
        decls.push(t.variableDeclaration('let', [t.variableDeclarator(t.identifier(resName))]));
      }

      // ---- splice into the statement list ----
      if (!needsValue) {
        // Value-discarding form: drop the call from its statement.
        if (t.isExpressionStatement(stmtPath.node) && stmtPath.node.expression === node) {
          stmtPath.replaceWithMultiple([...decls, loop]);
        } else {
          path.replaceWith(t.identifier('undefined'));
          stmtPath.insertBefore([...decls, loop]);
        }
      } else {
        const resultName = (method === 'map' || method === 'filter') ? accName : resName;
        path.replaceWith(t.identifier(resultName));
        const stmtClone = t.cloneNode(stmtPath.node, true);
        stmtPath.replaceWithMultiple([...decls, loop, stmtClone]);
      }
      ctx.applied(ID);
    },
  });
}

function scopeHasViolations(scope, name, cb) {
  // Whether the callback parameter is reassigned inside the callback.
  let violations = 0;
  walk(cb.body, (n) => {
    if ((t.isAssignmentExpression(n) || t.isUpdateExpression(n))) {
      const target = t.isAssignmentExpression(n) ? n.left : n.argument;
      if (t.isIdentifier(target) && target.name === name) violations++;
    }
    return true;
  });
  return violations > 0;
}
