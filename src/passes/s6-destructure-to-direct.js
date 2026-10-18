/**
 * S6 destructure-to-direct — hot functions only.
 *
 * `const { x, y } = obj` (obj a simple never-reassigned identifier, <= 3 total
 * uses of the pattern variables) becomes direct `obj.x` reads at use sites.
 * Default values are hoisted to an `if` at the declaration site so they are
 * never re-evaluated per use.
 *
 * Bail conditions: nested patterns, rest elements, computed keys, non-identifier
 * object, reassigned object, > 3 uses, any call/assignment/await between the
 * declaration and the last use (the object's properties could change), or
 * for-of/for-in heads.
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { containsBarrier, corridorSafe } from '../pass-utils.js';

const _traverse = traverse.default || traverse;

export const ID = 'destructure-to-direct';
export const CODE = 'S6';

/** Root identifier name of a member chain, or the identifier itself. */
function memberRootIs(node, name) {
  let cur = node;
  while (t.isMemberExpression(cur)) cur = cur.object;
  return t.isIdentifier(cur) && cur.name === name;
}

export default function destructureToDirect(programPath, ctx) {
  programPath.traverse({
    VariableDeclaration(path) {
      const node = path.node;
      const line = node.loc ? node.loc.start.line : 0;
      const fnParent = path.getFunctionParent();
      if (!fnParent || !ctx.isHot(fnParent.node)) return;
      if (ctx.isDisabled(path, ID, CODE)) return;

      const fail = (reason) => ctx.bail(line, CODE, reason);

      if (node.kind !== 'const') {
        if (node.declarations.length === 1 && t.isObjectPattern(node.declarations[0].id) && line > 0) {
          return fail('declaration is not const');
        }
        return;
      }
      const parent = path.parentPath;
      if (parent.isForOfStatement() || parent.isForInStatement() || parent.isForStatement()) {
        return line > 0 ? fail('declaration is a loop head') : undefined;
      }
      if (node.declarations.length !== 1) return line > 0 ? fail('multiple declarators') : undefined;
      const declarator = node.declarations[0];
      const pattern = declarator.id;
      if (!t.isObjectPattern(pattern)) return; // not an opportunity
      const obj = declarator.init;
      if (!obj || !t.isIdentifier(obj)) {
        return line > 0 ? fail('object is not a simple identifier (member chains are B1 territory)') : undefined;
      }

      const objBinding = path.scope.getBinding(obj.name);
      if (!objBinding) return fail('object binding not found');
      if (objBinding.constantViolations.length > 0) return fail('object identifier is reassigned');

      // Validate pattern shape.
      const props = [];
      for (const p of pattern.properties) {
        if (t.isRestElement(p)) return fail('rest element');
        if (!t.isObjectProperty(p)) return fail('unsupported pattern element');
        if (p.computed) return fail('computed key');
        let keyName = null;
        if (t.isIdentifier(p.key)) keyName = p.key.name;
        else if (t.isStringLiteral(p.key) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p.key.value)) keyName = p.key.value;
        else return fail('non-identifier key');
        if (!t.isIdentifier(p.value) && !t.isAssignmentPattern(p.value)) return fail('nested pattern or non-identifier value');
        if (t.isAssignmentPattern(p.value)) {
          if (!t.isIdentifier(p.value.left)) return fail('nested pattern in default target');
          props.push({ key: keyName, local: p.value.left.name, hasDefault: true, deflt: p.value.right });
        } else {
          props.push({ key: keyName, local: p.value.name, hasDefault: false, deflt: null });
        }
      }
      if (props.length === 0) return fail('empty pattern');

      // Uses.
      let totalUses = 0;
      const refsByLocal = new Map();
      for (const p of props) {
        const binding = path.scope.getBinding(p.local);
        if (!binding) return fail(`binding ${p.local} not found`);
        if (binding.constantViolations.length > 0) return fail(`binding ${p.local} is reassigned`);
        refsByLocal.set(p.local, binding);
        totalUses += binding.references;
      }
      if (totalUses > 3) return fail(`total uses ${totalUses} > 3`);

      // Barrier check between declaration and each use: any statement strictly
      // between the declaration and the use's statement must be free of calls
      // and assignments; within the use's own statement, an evaluation-order
      // corridor check ensures no call executes before the read.
      const fnBodyPath = fnParent.get('body');
      const declStart = declarator.start ?? 0;
      const declEnd = declarator.end ?? 0;
      const useNodes = [];
      for (const [, binding] of refsByLocal) {
        for (const ref of binding.referencePaths) useNodes.push(ref.node);
      }
      const lastRefPos = useNodes.reduce((m, u) => Math.max(m, u.end ?? 0), declEnd);
      let barrierProblem = null;
      fnBodyPath.traverse({
        Statement(sPath) {
          if (barrierProblem) return false;
          const n = sPath.node;
          if (n === node) return;
          if (sPath.isFunctionDeclaration()) return;
          const s = n.start ?? 0;
          const e = n.end ?? 0;
          const own = useNodes.filter((u) => u.start >= s && u.end <= e);
          if (own.length > 0) {
            // Corridor check inside the use's own statement (sorted by position).
            own.sort((a, b) => a.start - b.start);
            if (!corridorSafe(n, own)) {
              barrierProblem = 'a call inside the use statement executes before the read';
            }
            return;
          }
          const between = e > declStart && s < lastRefPos;
          if (between && containsBarrier(n, { loops: true })) {
            barrierProblem = 'calls or assignments between declaration and use could mutate the object';
          }
        },
      });
      if (!barrierProblem) {
        // Property writes to the object anywhere in the function are mutation
        // risks (`cfg = ...` reassignment is covered by constantViolations).
        fnBodyPath.traverse({
          AssignmentExpression(aPath) {
            if (memberRootIs(aPath.node.left, obj.name)) {
              barrierProblem = `property of "${obj.name}" is written`;
            }
          },
          UpdateExpression(aPath) {
            if (memberRootIs(aPath.node.argument, obj.name)) barrierProblem = `property of "${obj.name}" is updated`;
          },
          UnaryExpression(aPath) {
            if (aPath.node.operator === 'delete' && memberRootIs(aPath.node.argument, obj.name)) {
              barrierProblem = `property of "${obj.name}" is deleted`;
            }
          },
        });
      }
      if (barrierProblem) return fail(barrierProblem);

      // Rewrite.
      const objExpr = t.identifier(obj.name);
      let hasDefaults = false;
      for (const p of props) {
        if (p.hasDefault) { hasDefaults = true; continue; }
        const binding = refsByLocal.get(p.local);
        for (const ref of binding.referencePaths) {
          if (ctx.isDisabled(ref, ID, CODE)) continue;
          ref.replaceWith(t.memberExpression(t.cloneNode(objExpr), t.identifier(p.key)));
        }
      }

      if (hasDefaults) {
        // Keep defaulted locals: hoist the default to an if.
        const stmts = [];
        for (const p of props) {
          if (!p.hasDefault) continue;
          stmts.push(t.variableDeclaration('let', [
            t.variableDeclarator(t.identifier(p.local),
              t.memberExpression(t.cloneNode(objExpr), t.identifier(p.key))),
          ]));
          stmts.push(t.ifStatement(
            t.binaryExpression('===', t.identifier(p.local), t.identifier('undefined')),
            t.expressionStatement(t.assignmentExpression('=', t.identifier(p.local), p.deflt))
          ));
        }
        path.replaceWithMultiple(stmts);
      } else {
        path.remove();
      }
      ctx.applied(ID);
    },
  });
}
