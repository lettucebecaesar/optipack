/**
 * S1 const-fold — fold constant expressions.
 *
 * Folds: literal arithmetic / comparisons / bitwise ops, string concatenation,
 * typeof on literals, `!` on literals, template literals whose interpolations
 * are all literals, and logical expressions whose left operand is a literal.
 *
 * Visitors run in the exit phase so children fold before their parents and
 * nested literal expressions cascade in a single traversal.
 *
 * Never folds across identifiers or function calls. Never produces -0, NaN or
 * non-finite numbers (kept in original form to avoid serialization surprises).
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { literalValue, evalBinary, valueToLiteralNode, isNumericResultSafe } from '../pass-utils.js';

const _traverse = traverse.default || traverse;

export const ID = 'const-fold';
export const CODE = 'S1';

export default function constFold(programPath, ctx) {
  programPath.traverse({
    BinaryExpression: {
      exit(path) {
        if (ctx.isDisabled(path, ID, CODE)) return;
        const { left, right, operator } = path.node;
        const lv = literalValue(left);
        const rv = literalValue(right);
        if (!lv || !rv) return;
        // No cross-type `in`/`instanceof` (need objects); shifts need integers.
        if (operator === 'in' || operator === 'instanceof') return;
        if (['<<', '>>', '>>>'].includes(operator) && (!Number.isInteger(lv.value) || !Number.isInteger(rv.value))) return;
        const v = evalBinary(operator, lv, rv);
        if (v === undefined) return;
        if (typeof v === 'number' && !isNumericResultSafe(v)) return;
        const node = valueToLiteralNode(v);
        if (!node) return;
        path.replaceWith(node);
        ctx.applied(ID);
      },
    },

    UnaryExpression: {
      exit(path) {
        if (ctx.isDisabled(path, ID, CODE)) return;
        const { operator, argument } = path.node;
        if (operator === 'typeof') {
          if (t.isStringLiteral(argument)) {
            path.replaceWith(t.stringLiteral('string'));
            ctx.applied(ID);
          } else if (t.isNumericLiteral(argument)) {
            path.replaceWith(t.stringLiteral('number'));
            ctx.applied(ID);
          } else if (t.isBooleanLiteral(argument)) {
            path.replaceWith(t.stringLiteral('boolean'));
            ctx.applied(ID);
          } else if (t.isNullLiteral(argument)) {
            path.replaceWith(t.stringLiteral('object'));
            ctx.applied(ID);
          }
          return;
        }
        if (operator === '!') {
          const lv = literalValue(argument);
          if (lv && typeof lv.value !== 'object') {
            path.replaceWith(t.booleanLiteral(!lv.value));
            ctx.applied(ID);
          }
          return;
        }
        if (operator === '~') {
          const lv = literalValue(argument);
          if (lv && typeof lv.value === 'number' && Number.isInteger(lv.value)) {
            const v = ~lv.value;
            if (isNumericResultSafe(v)) {
              path.replaceWith(t.numericLiteral(v));
              ctx.applied(ID);
            }
          }
          return;
        }
        // `-x` / `+x` left as-is: literals are canonical already.
      },
    },

    TemplateLiteral: {
      exit(path) {
        if (ctx.isDisabled(path, ID, CODE)) return;
        const parent = path.parent;
        if (t.isTaggedTemplateExpression(parent) && parent.tag === path.node) return;
        const { quasis, expressions } = path.node;
        if (expressions.length === 0) return; // nothing to fold
        for (const e of expressions) {
          const lv = literalValue(e);
          if (!lv) return;
        }
        let s = '';
        for (let i = 0; i < quasis.length; i++) {
          s += quasis[i].value.raw;
          if (i < expressions.length) {
            const lv = literalValue(expressions[i]);
            s += String(lv.value);
          }
        }
        path.replaceWith(t.stringLiteral(s));
        ctx.applied(ID);
      },
    },

    LogicalExpression: {
      exit(path) {
        if (ctx.isDisabled(path, ID, CODE)) return;
        const { left, operator } = path.node;
        const lv = literalValue(left);
        if (!lv) return;
        const truthy = typeof lv.value === 'string' ? lv.value.length > 0 : !!lv.value;
        const isNullish = lv.kind === 'null';
        let repl = null;
        if (operator === '&&') repl = truthy ? path.node.right : path.node.left;
        else if (operator === '||') repl = truthy ? path.node.left : path.node.right;
        else if (operator === '??') repl = isNullish ? path.node.right : path.node.left;
        if (!repl) return;
        path.replaceWith(repl);
        ctx.applied(ID);
      },
    },
  });
}
