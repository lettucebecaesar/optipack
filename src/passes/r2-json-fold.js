/**
 * R2 json-fold Ã¢â‚¬â€ RISKY.
 *
 * `const x = JSON.parse('{"a":1}')` on a constant string is hoisted to a
 * module-level `const` shared by every call site, when the tool can prove the
 * parsed object is never mutated and never escapes to unknown code.
 *
 * Failure mode: shared mutable state if any code mutates the parsed object.
 *
 * Proof obligations (else bail):
 *  - the string literal must parse as JSON at build time
 *  - binding is `const`, never reassigned
 *  - every use is a pure READ: member-access object position, arithmetic /
 *    comparison / logical / unary (non-delete) operand, template substitution,
 *    conditional test Ã¢â‚¬â€ nothing else
 *  - never passed to any function (even known ones), never returned, thrown,
 *    spread, aliased, iterated (for-of), or stored in another object/array
 *  - no method call on it (x.reset() could mutate)
 *
 * Every application emits a warning in the report.
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';

const _traverse = traverse.default || traverse;

export const ID = 'json-fold';
export const CODE = 'R2';

export default function jsonFold(programPath, ctx) {
  const folds = [];

  programPath.traverse({
    VariableDeclarator(path) {
      const node = path.node;
      const decl = path.parentPath.node;
      if (!t.isVariableDeclaration(path.parentPath.node) || path.parentPath.node.kind !== 'const') return;
      if (path.parentPath.node.declarations.length !== 1) return;
      if (!t.isIdentifier(node.id)) return;
      const init = node.init;
      if (!init || !t.isCallExpression(init)) return;
      const callee = init.callee;
      if (!(t.isMemberExpression(callee) && t.isIdentifier(callee.object) &&
            callee.object.name === 'JSON' && t.isIdentifier(callee.property) &&
            callee.property.name === 'parse' && init.arguments.length === 1)) return;
      const arg = init.arguments[0];
      if (!t.isStringLiteral(arg)) return;
      const line = node.loc ? node.loc.start.line : 0;
      if (ctx.isDisabled(path, ID, CODE)) return;

      // The literal must actually parse.
      let parsed;
      try {
        parsed = JSON.parse(arg.value);
      } catch (e) {
        ctx.bail(line, CODE, `literal is not valid JSON: ${e.message}`);
        return;
      }
      void parsed;

      const name = node.id.name;
      const binding = path.scope.getBinding(name);
      if (!binding) return;
      if (binding.constantViolations.length > 0) {
        ctx.bail(line, CODE, 'binding is reassigned');
        return;
      }

      // Exported bindings never fold.
      let up = path.parentPath;
      let exported = false;
      while (up) {
        if (up.isExportNamedDeclaration() || up.isExportDefaultDeclaration()) { exported = true; break; }
        up = up.parentPath;
      }
      if (exported) {
        ctx.bail(line, CODE, 'binding is exported');
        return;
      }

      // Verify every use is a pure read. The parsed value is known at build
      // time, so property reads of primitive JSON values are safe to pass
      // anywhere (a copy flows); the object itself never escapes.
      let ok = true;
      let failReason = null;
      for (const ref of binding.referencePaths) {
        const verdict = isPureReadUse(ref, name, parsed);
        if (!verdict.ok) { ok = false; failReason = verdict.reason; break; }
      }
      if (!ok) {
        ctx.bail(line, CODE, failReason || 'use is not a pure read');
        return;
      }

      folds.push({ path, name, literal: t.cloneNode(arg, true), line, refs: [...binding.referencePaths] });
    },
  });

  if (folds.length === 0) return;

  const body = programPath.node.body;
  let lastImport = -1;
  for (let i = 0; i < body.length; i++) {
    if (t.isImportDeclaration(body[i])) lastImport = i;
  }

  const newStmts = [];
  let idx = 1;
  for (const f of folds) {
    const hoistName = programPath.scope.generateUid('opJson');
    newStmts.push(t.variableDeclaration('const', [
      t.variableDeclarator(t.identifier(hoistName),
        t.callExpression(t.memberExpression(t.identifier('JSON'), t.identifier('parse')), [f.literal])),
    ]));
    for (const ref of f.refs) {
      if (ref.node) ref.replaceWith(t.identifier(hoistName));
    }
    f.path.remove();
    ctx.applied(ID);
    ctx.warn(f.line, CODE,
      `JSON.parse(${JSON.stringify(truncate(f.literal.value))}) hoisted to module scope Ã¢â‚¬â€ shared mutable object`);
    idx++;
  }
  void idx;

  body.splice(lastImport + 1, 0, ...newStmts);
}

function truncate(s) {
  return s.length > 40 ? s.slice(0, 37) + '...' : s;
}

/**
 * Walk from a reference up to the nearest statement; every intermediate node
 * must be a read-safe context. When the value escapes into a call argument,
 * return, throw, etc., the escape is safe only if a member dereference happened
 * on the way AND the JSON value at that path is a primitive.
 */
function isPureReadUse(ref, name, parsed) {
  let p = ref.parentPath;
  let prev = ref.node;
  const propPath = []; // property names dereferenced so far
  const escapeSafe = () => {
    if (propPath.length === 0) return false; // the raw object escapes
    let v = parsed;
    for (const k of propPath) {
      if (v === null || typeof v !== 'object') return true; // dereferenced past a primitive
      v = v[k];
    }
    return v === null || typeof v !== 'object'; // primitive value flows: a copy
  };
  while (p && !p.isStatement()) {
    const n = p.node;
    if (t.isMemberExpression(n) || t.isOptionalMemberExpression(n)) {
      if (n.object !== prev) return { ok: false, reason: 'used as a property key' };
      if (t.isIdentifier(n.property)) propPath.push(n.property.name);
      else if (t.isStringLiteral(n.property)) propPath.push(n.property.value);
      // A method call on the parsed object could mutate it.
      const pp = p.parentPath;
      if (pp && t.isCallExpression(pp.node) && pp.node.callee === n) {
        return { ok: false, reason: 'method called on the parsed object' };
      }
      if (pp && (t.isAssignmentExpression(pp.node) && pp.node.left === n)) {
        return { ok: false, reason: 'property of the parsed object is written' };
      }
      if (pp && (t.isUpdateExpression(pp.node) && pp.node.argument === n)) {
        return { ok: false, reason: 'property of the parsed object is updated' };
      }
      if (pp && t.isUnaryExpression(pp.node) && pp.node.operator === 'delete' && pp.node.argument === n) {
        return { ok: false, reason: 'property of the parsed object is deleted' };
      }
      prev = n;
      p = p.parentPath;
      continue;
    }
    if (t.isBinaryExpression(n) || t.isLogicalExpression(n) || t.isUnaryExpression(n) ||
        t.isConditionalExpression(n) || t.isTemplateLiteral(n)) {
      if (t.isUnaryExpression(n) && n.operator === 'delete') {
        return { ok: false, reason: 'delete of parsed object property' };
      }
      prev = n;
      p = p.parentPath;
      continue;
    }
    if (t.isExpressionStatement(n) && n.expression === prev) break;
    if (t.isVariableDeclarator(n) && n.init === prev) {
      return { ok: false, reason: 'aliased to another binding' };
    }
    if (t.isCallExpression(n) || t.isNewExpression(n)) {
      return escapeSafe() ? { ok: true } : { ok: false, reason: 'parsed object (or an object-valued property) passed to a call' };
    }
    if (t.isReturnStatement(n) || t.isThrowStatement(n) || t.isSpreadElement(n) ||
        t.isForOfStatement(n) || t.isForInStatement(n) || t.isArrayExpression(n) ||
        t.isObjectProperty(n)) {
      return escapeSafe() ? { ok: true } : { ok: false, reason: 'parsed object escapes by reference' };
    }
    return { ok: false, reason: `used in unsupported context (${n.type})` };
  }
  if (!p) return { ok: false, reason: 'no statement context' };
  return { ok: true };
}
