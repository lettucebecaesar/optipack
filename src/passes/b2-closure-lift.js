/**
 * B2 closure-lift — balanced level.
 *
 * Arrow / function expressions created lexically inside hot functions are
 * re-allocated on every tick. When they capture nothing, only module-level
 * identifiers/globals, or only `const`-bound primitives (inlined as module
 * consts), they are lifted to module scope and their creation site becomes a
 * plain identifier reference.
 *
 * Cell capture: when an arrow captures a per-invocation local that is never
 * reassigned, it can still be lifted by routing the capture through a
 * module-level cell (`let __opCellN;`) assigned at the arrow's creation point.
 * This is sound only when the arrow can never outlive the cell assignment:
 *
 *   - every reference of the arrow binding is a DIRECT synchronous call in the
 *     enclosing function (callee position; never passed as a value, registered,
 *     stored, or returned) — so no closure survives into a later invocation
 *     where the cell holds a different value;
 *   - the arrow's creation point is not lexically inside a loop (a shared cell
 *     would be clobbered across iterations that each register/keep a closure);
 *   - the enclosing function is sync and contains no await/yield (no
 *     interleaving between the cell assignment and the call);
 *   - the captured local is declared (and its declaration ends) before the
 *     arrow's creation statement (no TDZ / `var` hoisting reads);
 *   - the captured binding is never reassigned (its value at the assignment
 *     point equals its value at every call point).
 *
 * Arrows that ESCAPE with live captures (e.g. `system.runInterval(() =>
 * fn(player))` inside a handler that may run more than once) still bail: each
 * registration needs its own capture, which a single cell cannot represent,
 * and the enclosing function's invocation count is statically unprovable.
 *
 * Also bails: references to `this`, `arguments`, `super`, `new.target`.
 * Hotness is preserved: a lifted function that was hot stays hot.
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { walk, walkSameFunction } from '../pass-utils.js';

const _traverse = traverse.default || traverse;

export const ID = 'closure-lift';
export const CODE = 'B2';

function primitiveInitNode(node) {
  if (!node) return null;
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node)) return node;
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) return node;
  if (t.isUnaryExpression(node) && (node.operator === '-' || node.operator === '+') && t.isNumericLiteral(node.argument)) return node;
  return null;
}

function isProgramScope(binding) {
  return !!(binding.scope && binding.scope.path && binding.scope.path.isProgram());
}

/** Is the node lexically inside the body (or per-iteration parts) of a loop? */
function insideLoop(nodePath) {
  for (let p = nodePath.parentPath; p; p = p.parentPath) {
    const n = p.node;
    if (t.isFunction(n) || t.isProgram(n)) return false;
    if (t.isForStatement(n) || t.isWhileStatement(n) || t.isDoWhileStatement(n) ||
        t.isForOfStatement(n) || t.isForInStatement(n)) {
      return true;
    }
  }
  return false;
}

/** Does the enclosing function itself contain await or yield (same function only)? */
function containsSuspension(fnPath) {
  let found = false;
  walkSameFunction(fnPath.node.body, (n) => {
    if (t.isAwaitExpression(n) || t.isYieldExpression(n)) {
      found = true;
      return false;
    }
    if (t.isForOfStatement(n) && n.await) { found = true; return false; }
    return true;
  });
  return found;
}

/**
 * No-escape check for cell capture: every reference of the arrow's binding is
 * the CALLEE of a call whose enclosing function is `ownerFnNode`. Returns
 * { ok, reason }.
 */
function allUsesAreSyncCalls(binding, ownerFnNode) {
  if (!binding) return { ok: false, reason: 'anonymous arrow' };
  if (binding.constantViolations.length > 0) {
    return { ok: false, reason: 'arrow binding is reassigned' };
  }
  const refs = binding.referencePaths;
  if (refs.length === 0) return { ok: false, reason: 'arrow is never used' };
  for (const ref of refs) {
    const parent = ref.parent;
    if (!(t.isCallExpression(parent) && parent.callee === ref.node)) {
      return { ok: false, reason: 'arrow escapes as a value (registered, stored, or returned)' };
    }
    const callParent = ref.getFunctionParent();
    if (!callParent || callParent.node !== ownerFnNode) {
      return { ok: false, reason: 'arrow is called from a nested function' };
    }
  }
  return { ok: true };
}

export default function closureLift(programPath, ctx) {
  // Compute the insertion index after imports (or 0 when uses may precede it).
  const body = programPath.node.body;
  let lastImport = -1;
  for (let i = 0; i < body.length; i++) {
    if (t.isImportDeclaration(body[i])) lastImport = i;
  }

  const lifts = []; // { path, fnNode, liftName, cloned, capDecls, cellDecls, cellAssignments }

  programPath.traverse({
    'ArrowFunctionExpression|FunctionExpression'(path) {
      const fn = path.node;
      const fnParent = path.getFunctionParent();
      if (!fnParent || !ctx.isHot(fnParent.node)) return;
      if (fnParent.node === fn) return;
      if (ctx.isDisabled(path, ID, CODE)) return;
      if (lifts.some((l) => l.fnNode === fn)) return;

      const fail = (reason) => {
        ctx.bail(fn.loc ? fn.loc.start.line : 0, CODE, reason);
      };

      let bad = null;
      walk(fn.body, (n) => {
        if (bad) return false;
        if (t.isThisExpression(n)) { bad = 'references this'; return false; }
        if (t.isIdentifier(n) && n.name === 'arguments') { bad = 'references arguments'; return false; }
        if (t.isSuper(n)) { bad = 'references super'; return false; }
        if (t.isMetaProperty(n)) { bad = 'references new.target'; return false; }
        return true;
      });
      if (bad) return fail(bad);

      // Classify captures.
      const captures = new Map(); // binding -> { mode: 'inline'|'cell', init?, refs: [] }
      let bailReason = null;
      path.traverse({
        ReferencedIdentifier(refPath) {
          if (bailReason) return;
          const name = refPath.node.name;
          const binding = refPath.scope.getBinding(name);
          if (!binding) return; // global
          if (binding.path === path || isDescendantPath(binding.path, path)) return;
          if (isProgramScope(binding)) return; // module-level
          if (binding.constantViolations.length > 0) {
            bailReason = `captured local "${name}" is reassigned`;
            return;
          }
          const decl = binding.path;
          if (decl.isVariableDeclarator()) {
            const prim = primitiveInitNode(decl.node.init);
            if (prim) {
              if (!captures.has(binding)) captures.set(binding, { mode: 'inline', init: prim, refs: [] });
              captures.get(binding).refs.push(refPath);
              return;
            }
          }
          // Not an inline-able const primitive: candidate for cell capture.
          if (!captures.has(binding)) captures.set(binding, { mode: 'cell', name, refs: [] });
          captures.get(binding).refs.push(refPath);
        },
      });
      if (bailReason) return fail(bailReason);

      const needsCell = [...captures.values()].some((c) => c.mode === 'cell');
      const stmtPath = nearestStatement(path);
      if (needsCell) {
        // Cell capture soundness preconditions.
        if (insideLoop(path)) {
          return fail('captures a live local and is created inside a loop (a shared cell would be clobbered)');
        }
        if (fnParent.node.async || fnParent.node.generator || containsSuspension(fnParent)) {
          return fail('captures a live local inside an async/generator function (interleaving could change the cell)');
        }
        // The arrow binding: VariableDeclarator id, or AssignmentExpression lhs.
        let binding = null;
        if (path.parentPath.isVariableDeclarator() && t.isIdentifier(path.parentPath.node.id)) {
          binding = path.parentPath.scope.getBinding(path.parentPath.node.id.name);
        } else if (path.parentPath.isAssignmentExpression() && t.isIdentifier(path.parentPath.node.left)) {
          binding = path.parentPath.scope.getBinding(path.parentPath.node.left.name);
        }
        const escape = allUsesAreSyncCalls(binding, fnParent.node);
        if (!escape.ok) {
          return fail(`captures a live local and ${escape.reason} — a lifted function could observe a newer cell value`);
        }
        // Captured locals must be declared, and their declarations finished,
        // before the STATEMENT containing the arrow's creation (the cell
        // assignment is inserted there — reading a not-yet-declared local
        // would be a new TDZ/hoisting hazard).
        if (!stmtPath) {
          return fail('captures a live local but has no statement context');
        }
        const creationStmtStart = stmtPath.node.start ?? 0;
        for (const [binding2, cap] of captures) {
          if (cap.mode !== 'cell') continue;
          const declEnd = binding2.path.node.end ?? 0;
          if (declEnd >= creationStmtStart) {
            return fail(`captured local "${cap.name}" is declared at or after the arrow's creation statement (TDZ/hoisting hazard)`);
          }
        }
      }

      // Plan the lift.
      const capDecls = [];
      const cellDecls = [];
      for (const [, cap] of captures) {
        if (cap.mode === 'inline') {
          const capName = programPath.scope.generateUid('opCap');
          capDecls.push({ name: capName, init: t.cloneNode(cap.init, true) });
          for (const ref of cap.refs) {
            if (ref.node && ref.node.type) ref.replaceWith(t.identifier(capName));
          }
        } else {
          const cellName = programPath.scope.generateUid('opCell');
          cap.cellName = cellName;
          cellDecls.push(cellName);
          for (const ref of cap.refs) {
            if (ref.node && ref.node.type) ref.replaceWith(t.identifier(cellName));
          }
        }
      }
      const liftName = programPath.scope.generateUid('opLift');
      const cloned = t.cloneNode(path.node, true);

      // Cell assignments go immediately before the statement containing the
      // arrow's creation, in the order the captures were classified. The
      // statement path was already computed during the bail checks.
      const cellAssignments = [];
      if (needsCell) {
        for (const [, cap] of captures) {
          if (cap.mode !== 'cell') continue;
          cellAssignments.push(t.expressionStatement(
            t.assignmentExpression('=', t.identifier(cap.cellName), t.identifier(cap.name))
          ));
        }
      }
      lifts.push({ path, fnNode: fn, liftName, cloned, capDecls, cellDecls, cellAssignments, stmtPath });
      if (ctx.hot) ctx.hot.copyHotness(fn, cloned);
    },
  });

  if (lifts.length === 0) return;

  // Sort by source position for deterministic insertion.
  lifts.sort((a, b) => (a.fnNode.start || 0) - (b.fnNode.start || 0));

  // Do any lift uses precede the end of the import block?
  const importBoundary = lastImport >= 0 ? (body[lastImport].end || 0) : -1;
  const anyBefore = lifts.some((l) => (l.fnNode.start || Infinity) < importBoundary);

  const newStmts = [];
  for (const l of lifts) {
    for (const cap of l.capDecls) {
      newStmts.push(t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier(cap.name), cap.init),
      ]));
    }
    for (const cellName of l.cellDecls) {
      newStmts.push(t.variableDeclaration('let', [t.variableDeclarator(t.identifier(cellName))]));
    }
    newStmts.push(t.variableDeclaration('const', [
      t.variableDeclarator(t.identifier(l.liftName), l.cloned),
    ]));
  }

  const insertIdx = anyBefore ? 0 : lastImport + 1;
  body.splice(insertIdx, 0, ...newStmts);

  // Insert cell assignments grouped per statement (preserving lift order).
  const byStatement = new Map();
  for (const l of lifts) {
    if (l.cellAssignments.length === 0 || !l.stmtPath) continue;
    const key = l.stmtPath.node;
    if (!byStatement.has(key)) byStatement.set(key, { stmtPath: l.stmtPath, stmts: [] });
    byStatement.get(key).stmts.push(...l.cellAssignments);
  }
  for (const [, group] of byStatement) {
    try {
      group.stmtPath.insertBefore(group.stmts);
    } catch {
      // Statement not in a list position (e.g. an if consequent): wrap.
      const node = group.stmtPath.node;
      group.stmtPath.replaceWith(t.blockStatement([...group.stmts, node]));
    }
  }

  for (const l of lifts) {
    if (ctx.isDisabled(l.path, ID, CODE)) continue;
    l.path.replaceWith(t.identifier(l.liftName));
    ctx.applied(ID);
  }
}

function nearestStatement(path) {
  let p = path;
  while (p && !p.isStatement()) p = p.parentPath;
  return p;
}

function isDescendantPath(bindingPath, fnPath) {
  let p = bindingPath;
  while (p) {
    if (p === fnPath) return true;
    p = p.parentPath;
  }
  return false;
}
