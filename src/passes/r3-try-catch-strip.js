/**
 * R3 try-catch-strip — RISKY, hot functions only.
 *
 * Removes `try { ... } catch {}` when the try body contains no calls (and the
 * catch body is empty). The catch becomes dead weight: with no calls in the
 * try body, the only throws left are engine-level pathological ones.
 *
 * Failure mode: a pathological engine-level throw now crashes the pack script
 * instead of being swallowed.
 *
 * Bail conditions: finally present, catch body non-empty, try body contains
 * CallExpression / NewExpression / AwaitExpression / YieldExpression /
 * tagged templates / optional calls. Every application warns.
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { walkSameFunction } from '../pass-utils.js';

const _traverse = traverse.default || traverse;

export const ID = 'try-catch-strip';
export const CODE = 'R3';

export default function tryCatchStrip(programPath, ctx) {
  programPath.traverse({
    TryStatement(path) {
      const node = path.node;
      const line = node.loc ? node.loc.start.line : 0;
      const fnParent = path.getFunctionParent();
      if (!fnParent || !ctx.isHot(fnParent.node)) return;
      if (ctx.isDisabled(path, ID, CODE)) return;

      if (node.finalizer) {
        ctx.bail(line, CODE, 'finally present');
        return;
      }
      if (!node.handler) return; // try/finally handled above
      if (node.handler.body.body.length > 0) {
        ctx.bail(line, CODE, 'catch body is not empty');
        return;
      }
      let hasCall = false;
      walkSameFunction(node.block, (n) => {
        if (t.isCallExpression(n) || t.isNewExpression(n) || t.isTaggedTemplateExpression(n) ||
            t.isOptionalCallExpression(n) || t.isAwaitExpression(n) || t.isYieldExpression(n)) {
          hasCall = true;
          return false;
        }
        return true;
      });
      if (hasCall) {
        ctx.bail(line, CODE, 'try body contains calls');
        return;
      }
      path.replaceWithMultiple(node.block.body);
      ctx.applied(ID);
      ctx.warn(line, CODE,
        'try/catch removed in hot function — engine-level throws now propagate');
    },
  });
}
