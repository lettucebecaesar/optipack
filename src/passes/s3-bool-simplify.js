/**
 * S3 bool-simplify — boolean-tautology simplification.
 *
 *  - `x ? true : false`          -> `!!x`
 *  - `if (x) return true; else return false;` -> `return !!x;`
 *  - `x === true` / `x !== false` -> `x`        (x statically boolean-typed)
 *  - `x === false` / `x !== true` -> `!x`       (duals, same precondition)
 *
 * Bails whenever `x` is not statically boolean-typed (result of a comparison,
 * a `!` expression, a Boolean() call, or an and/or of such).
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { isBooleanTyped } from '../pass-utils.js';

const _traverse = traverse.default || traverse;

export const ID = 'bool-simplify';
export const CODE = 'S3';

function notNot(expr) {
  return t.unaryExpression('!', t.unaryExpression('!', expr));
}

function singleReturn(stmt, value) {
  if (t.isReturnStatement(stmt)) {
    return t.isBooleanLiteral(stmt.argument) && stmt.argument.value === value;
  }
  if (t.isBlockStatement(stmt) && stmt.body.length === 1) {
    const s = stmt.body[0];
    return t.isReturnStatement(s) && t.isBooleanLiteral(s.argument) && s.argument.value === value;
  }
  return false;
}

export default function boolSimplify(programPath, ctx) {
  programPath.traverse({
    ConditionalExpression(path) {
      if (ctx.isDisabled(path, ID, CODE)) return;
      const { test, consequent, alternate } = path.node;
      if (t.isBooleanLiteral(consequent) && consequent.value === true &&
          t.isBooleanLiteral(alternate) && alternate.value === false) {
        path.replaceWith(notNot(test));
        ctx.applied(ID);
      }
    },
    IfStatement(path) {
      if (ctx.isDisabled(path, ID, CODE)) return;
      const { test, consequent, alternate } = path.node;
      if (!alternate) return;
      if (singleReturn(consequent, true) && singleReturn(alternate, false)) {
        path.replaceWith(t.returnStatement(notNot(test)));
        ctx.applied(ID);
      }
    },
    BinaryExpression(path) {
      if (ctx.isDisabled(path, ID, CODE)) return;
      const { left, right, operator } = path.node;
      // Normalize operand order: find (expr, literal) pair.
      let expr = null;
      if (t.isBooleanLiteral(right)) expr = left;
      else if (t.isBooleanLiteral(left)) expr = right;
      if (!expr) return;
      const lit = t.isBooleanLiteral(right) ? right.value : left.value;
      if (!isBooleanTyped(expr)) {
        ctx.bail(path.node.loc ? path.node.loc.start.line : 0, CODE,
          'operand not statically boolean-typed');
        return;
      }
      // x === true -> x ; x !== false -> x ; x === false -> !x ; x !== true -> !x
      const replacement =
        (operator === '===' && lit === true) || (operator === '!==' && lit === false)
          ? expr
          : (operator === '===' && lit === false) || (operator === '!==' && lit === true)
            ? t.unaryExpression('!', expr)
            : null;
      if (!replacement) return;
      path.replaceWith(replacement);
      ctx.applied(ID);
    },
  });
}
