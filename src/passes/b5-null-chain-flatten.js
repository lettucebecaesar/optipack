/**
 * B5 null-chain-flatten — balanced level.
 *
 * After S1/S2 prove a guard, `a?.b` becomes `a.b` when `a` is statically
 * non-nullish in that region: a guard like `if (!a) return;` (or
 * `if (a == null) throw ...`) dominates the following statements, and nothing
 * can reassign `a` before the use. The guard window is barrier-aware: a
 * statement containing calls flattens its own uses only when no call executes
 * before them (evaluation-order corridor), and then ends the window.
 *
 * Only the FIRST optional hop rooted at the guarded identifier is flattened;
 * deeper optional hops (`a?.b?.c`) remain — `a.b` itself may still be nullish.
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { walkSameFunction, corridorSafe } from '../pass-utils.js';

const _traverse = traverse.default || traverse;

export const ID = 'null-chain-flatten';
export const CODE = 'B5';

function statementHasBarrier(stmt) {
  let barrier = false;
  walkSameFunction(stmt, (n) => {
    if (t.isCallExpression(n) || t.isNewExpression(n) || t.isAssignmentExpression(n) ||
        t.isUpdateExpression(n) || t.isAwaitExpression(n) || t.isYieldExpression(n) ||
        t.isForOfStatement(n) || t.isForInStatement(n) ||
        t.isForStatement(n) || t.isWhileStatement(n) || t.isDoWhileStatement(n) ||
        t.isTaggedTemplateExpression(n)) {
      barrier = true;
      return false;
    }
    return true;
  });
  return barrier;
}

/** Does this statement (or block) always exit? */
function alwaysExits(stmt) {
  if (!stmt) return false;
  if (t.isReturnStatement(stmt) || t.isThrowStatement(stmt) ||
      t.isBreakStatement(stmt) || t.isContinueStatement(stmt)) return true;
  if (t.isBlockStatement(stmt)) {
    if (stmt.body.length === 0) return false;
    for (const s of stmt.body) {
      if (t.isIfStatement(s) || t.isSwitchStatement(s)) return false;
    }
    return alwaysExits(stmt.body[stmt.body.length - 1]);
  }
  return false;
}

/** Matches `!a`, `a == null`, `a === null`, `a == undefined`, `a === undefined`,
 *  and `a === null || a === undefined` combinations. Returns the identifier or null. */
function guardIdent(test) {
  const idOf = (n) => (t.isIdentifier(n) ? n : null);

  if (t.isUnaryExpression(test) && test.operator === '!') return idOf(test.argument);

  const eqNullish = (n) => {
    if (!t.isBinaryExpression(n)) return false;
    if (n.operator !== '==' && n.operator !== '===') return false;
    const { left, right } = n;
    const litNull = t.isNullLiteral(right) || (t.isIdentifier(right) && right.name === 'undefined');
    const litNullL = t.isNullLiteral(left) || (t.isIdentifier(left) && left.name === 'undefined');
    return (idOf(left) && litNull) || (idOf(right) && litNullL);
  };
  if (eqNullish(test)) {
    if (t.isBinaryExpression(test)) {
      return idOf(t.isIdentifier(test.left) ? test.left : test.right);
    }
  }
  if (t.isLogicalExpression(test) && test.operator === '||') {
    const l = guardIdent(test.left);
    const r = guardIdent(test.right);
    if (l && r && l.name === r.name) return l;
  }
  return null;
}

export default function nullChainFlatten(programPath, ctx) {
  programPath.traverse({
    BlockStatement(path) {
      const body = path.node.body;
      for (let i = 0; i < body.length; i++) {
        const stmt = body[i];
        if (!t.isIfStatement(stmt)) continue;
        if (!alwaysExits(stmt.consequent)) continue;
        if (stmt.alternate && !alwaysExits(stmt.alternate)) continue;
        const ident = guardIdent(stmt.test);
        if (!ident) continue;
        if (ctx.isDisabled(path, ID, CODE)) continue;

        const binding = path.scope.getBinding(ident.name);
        if (!binding) continue; // need a trackable local/param
        if (binding.constantViolations.length > 0) {
          ctx.bail(stmt.loc ? stmt.loc.start.line : 0, CODE,
            `guarded identifier "${ident.name}" is reassigned in scope`);
          continue;
        }

        // Barrier-aware window after the guard.
        let applied = 0;
        for (let j = i + 1; j < body.length; j++) {
          const s = body[j];
          // Collect optional chains rooted at ident in this statement.
          const uses = [];
          walkSameFunction(s, (n) => {
            if (t.isOptionalMemberExpression(n) && n.optional &&
                t.isIdentifier(n.object) && n.object.name === ident.name) {
              uses.push(n);
            } else if (t.isOptionalCallExpression(n) && n.optional &&
                t.isIdentifier(n.callee) && n.callee.name === ident.name) {
              uses.push(n);
            }
            return true;
          });
          if (uses.length === 0) {
            if (statementHasBarrier(s)) break; // window ends at barriers
            continue;
          }
          if (corridorSafe(s, uses)) {
            for (const n of uses) {
              n.optional = false;
              applied++;
            }
          } else {
            break;
          }
          if (statementHasBarrier(s)) break; // window ends at barriers
        }
        if (applied > 0) ctx.applied(ID);
      }
    },
  });
}
