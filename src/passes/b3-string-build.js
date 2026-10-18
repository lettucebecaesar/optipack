/**
 * B3 string-build — balanced level.
 *
 * `s += x` accumulated inside a loop in a hot function becomes
 * `parts.push("" + x)` with a single `s = parts.join("")` after the loop.
 *
 * Why: QuickJS strings are immutable flat buffers, so `+=` over long loops is
 * O(n^2) copying. Array parts + one join is O(n).
 *
 * Preconditions (else bail):
 *  - `s` is a `let` string initialized to "" and only ever written by the
 *    `+=`/`s = s + x` statements inside ONE loop (or the initializer)
 *  - `s` is never read inside the loop (including from nested closures)
 *  - writes live in the hot function itself (not a nested closure)
 *  - `s = x + s` (prepend) is not used
 *
 * `"" + x` preserves exact ToString semantics (including null -> "null",
 * undefined -> "undefined", symbol throws) at the same evaluation point.
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { walk } from '../pass-utils.js';

const _traverse = traverse.default || traverse;

export const ID = 'string-build';
export const CODE = 'B3';

export default function stringBuild(programPath, ctx) {
  programPath.traverse({
    VariableDeclaration(path) {
      const node = path.node;
      const line = node.loc ? node.loc.start.line : 0;
      const fnParent = path.getFunctionParent();
      if (!fnParent || !ctx.isHot(fnParent.node)) return;
      if (ctx.isDisabled(path, ID, CODE)) return;

      const fail = (reason) => ctx.bail(line, CODE, reason);

      if (node.kind !== 'let' || node.declarations.length !== 1) return;
      const declarator = node.declarations[0];
      if (!t.isIdentifier(declarator.id)) return;
      if (!declarator.init || !t.isStringLiteral(declarator.init) || declarator.init.value !== '') return;

      const name = declarator.id.name;
      const binding = path.scope.getBinding(name);
      if (!binding) return;

      // All constant violations must be += or `s = s + x` inside ONE loop.
      if (binding.constantViolations.length === 0) return;
      let loopNode = null;
      const writes = [];
      for (const viol of binding.constantViolations) {
        if (!viol.isAssignmentExpression()) return fail('non-assignment write to accumulator');
        const vn = viol.node;
        if (vn.operator === '+=') {
          if (!t.isIdentifier(vn.left) || vn.left.name !== name) return fail('unexpected assignment shape');
          writes.push({ node: vn, value: vn.right, violPath: viol });
        } else if (vn.operator === '=') {
          if (!t.isIdentifier(vn.left) || vn.left.name !== name) return fail('unexpected assignment shape');
          const r = vn.right;
          if (t.isBinaryExpression(r) && r.operator === '+' && t.isIdentifier(r.left) && r.left.name === name) {
            writes.push({ node: vn, value: r.right, violPath: viol });
          } else {
            return fail('accumulator reassigned (not an append)');
          }
        } else {
          return fail('unexpected assignment operator');
        }
        // Must live inside one loop, in the hot function itself.
        const violParent = viol.parentPath ? viol.parentPath : null;
        let l = viol;
        while (l && !l.isProgram()) {
          if (l.isForStatement() || l.isWhileStatement() || l.isDoWhileStatement() ||
              l.isForOfStatement() || l.isForInStatement()) {
            if (!loopNode) loopNode = l.node;
            else if (loopNode !== l.node) return fail('writes span multiple loops');
            break;
          }
          if (l.isFunctionExpression() || l.isArrowFunctionExpression()) {
            return fail('accumulator written inside a nested closure');
          }
          l = l.parentPath;
        }
        if (!loopNode) return fail('accumulator written outside a loop');
      }

      // No reads of `s` inside the loop other than write targets and the
      // `s` operand of a `s = s + x` append.
      const appendOperands = new Set();
      for (const w of writes) {
        if (t.isBinaryExpression(w.value) && w.value.operator === '+' && t.isIdentifier(w.value.left) && w.value.left.name === name) {
          appendOperands.add(w.value.left);
        }
      }
      const inLoop = (n) => loopNode.start <= n.start && n.end <= loopNode.end;
      for (const ref of binding.referencePaths) {
        const n = ref.node;
        if (!n || !inLoop(n)) continue;
        const parent = ref.parent;
        const isWriteTarget = t.isAssignmentExpression(parent) && parent.left === n;
        if (!isWriteTarget && !appendOperands.has(n)) return fail('accumulator read inside the loop');
      }
      // `s += s` shape: right side reading s inside the loop.
      for (const w of writes) {
        let readsSelf = false;
        walk(w.value, (n) => {
          if (t.isIdentifier(n) && n.name === name) readsSelf = true;
          return true;
        });
        if (readsSelf) return fail('accumulator reads itself in the append expression');
      }

      // The loop must be in the same function as the declaration; the
      // violation scan above already established containment.

      // ---- transform
      const partsName = path.scope.generateUid('opParts');
      const partsDecl = t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier(partsName), t.arrayExpression([])),
      ]);
      const joinStmt = t.expressionStatement(
        t.assignmentExpression('=', t.identifier(name),
          t.callExpression(t.memberExpression(t.identifier(partsName), t.identifier('join')), [t.stringLiteral('')]))
      );

      for (const w of writes) {
        if (!w.violPath.parentPath || !w.violPath.parentPath.isExpressionStatement()) {
          return fail('accumulator append is not a standalone statement');
        }
      }
      for (const w of writes) {
        const push = t.expressionStatement(
          t.callExpression(
            t.memberExpression(t.identifier(partsName), t.identifier('push')),
            [t.binaryExpression('+', t.stringLiteral(''), w.value)]
          )
        );
        w.violPath.replaceWith(push);
      }

      // Insert decl before the loop and join after it.
      const loopPath = findLoopPath(programPath, loopNode);
      if (!loopPath) return fail('internal: loop path not found');
      const parent = loopPath.parentPath;
      const inList = parent && (parent.isArrayExpression() || parent.isBlockStatement() ||
        parent.isSwitchCase() || parent.isProgram());
      if (inList) {
        loopPath.insertBefore(partsDecl);
        loopPath.insertAfter(joinStmt);
      } else {
        loopPath.replaceWith(t.blockStatement([partsDecl, loopPath.node, joinStmt]));
      }
      ctx.applied(ID);
    },
  });
}

function findLoopPath(programPath, loopNode) {
  let found = null;
  programPath.traverse({
    'ForStatement|WhileStatement|DoWhileStatement|ForOfStatement|ForInStatement'(p) {
      if (p.node === loopNode && !found) { found = p; p.stop(); }
    },
  });
  return found;
}
