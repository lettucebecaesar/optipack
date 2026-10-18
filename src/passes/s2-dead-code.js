/**
 * S2 dead-code — remove provably unreachable code.
 *
 * 1. Statements after an unconditional return/throw/break/continue in a block.
 * 2. Branches made constant by S1 (if / conditional / while-false / for-false).
 * 3. Unused local declarations whose initializers are side-effect-free
 *    (no calls, no member writes, no await/yield, no delete).
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { isPureExpression, isStaticLiteral, literalValue } from '../pass-utils.js';

const _traverse = traverse.default || traverse;

export const ID = 'dead-code';
export const CODE = 'S2';

function isTerminal(stmt) {
  return (
    t.isReturnStatement(stmt) ||
    t.isThrowStatement(stmt) ||
    t.isBreakStatement(stmt) ||
    t.isContinueStatement(stmt)
  );
}

function blockBodyOf(stmt) {
  if (t.isBlockStatement(stmt)) return stmt.body;
  return [stmt];
}

function allExit(stmts) {
  if (stmts.length === 0) return false;
  const last = stmts[stmts.length - 1];
  if (!isTerminal(last)) return false;
  for (const s of stmts) {
    if (t.isIfStatement(s) || t.isSwitchStatement(s)) return false; // may fall through around it
  }
  return true;
}

export default function deadCode(programPath, ctx) {
  // Step 1: code after a terminal statement.
  programPath.traverse({
    BlockStatement(path) {
      const body = path.node.body;
      let cut = -1;
      for (let i = 0; i < body.length; i++) {
        if (isTerminal(body[i])) { cut = i; break; }
      }
      if (cut >= 0 && cut < body.length - 1) {
        if (ctx.isDisabled(path, ID, CODE)) return;
        const removed = body.length - 1 - cut;
        path.node.body = body.slice(0, cut + 1);
        ctx.applied(ID);
        // record one bail-style note is unnecessary: this is an application.
        void removed;
      }
    },
  });

  // Step 2: constant branches.
  programPath.traverse({
    IfStatement(path) {
      if (ctx.isDisabled(path, ID, CODE)) return;
      const test = path.node.test;
      if (!isStaticLiteral(test)) return;
      const lv = literalValue(test);
      const truthy = lv ? (typeof lv.value === 'string' ? lv.value.length > 0 : !!lv.value) : null;
      if (truthy === null) return;
      const keep = truthy ? path.node.consequent : path.node.alternate;
      if (!keep) {
        path.remove();
      } else {
        path.replaceWithMultiple(blockBodyOf(keep));
      }
      ctx.applied(ID);
    },
    ConditionalExpression(path) {
      if (ctx.isDisabled(path, ID, CODE)) return;
      const lv = literalValue(path.node.test);
      if (!lv) return;
      const truthy = typeof lv.value === 'string' ? lv.value.length > 0 : !!lv.value;
      path.replaceWith(truthy ? path.node.consequent : path.node.alternate);
      ctx.applied(ID);
    },
    WhileStatement(path) {
      if (ctx.isDisabled(path, ID, CODE)) return;
      const lv = literalValue(path.node.test);
      if (!lv) return;
      const truthy = typeof lv.value === 'string' ? lv.value.length > 0 : !!lv.value;
      if (!truthy) {
        path.remove();
        ctx.applied(ID);
      }
    },
    ForStatement(path) {
      if (ctx.isDisabled(path, ID, CODE)) return;
      if (!path.node.test) return;
      const lv = literalValue(path.node.test);
      if (!lv) return;
      const truthy = typeof lv.value === 'string' ? lv.value.length > 0 : !!lv.value;
      if (!truthy) {
        path.remove();
        ctx.applied(ID);
      }
    },
  });

  // Step 3: unused local declarations with pure initializers.
  programPath.scope.crawl();
  const removals = [];
  const scopeSet = new Set();
  programPath.traverse({
    enter(p) {
      if (p.scope) scopeSet.add(p.scope);
    },
  });
  scopeSet.add(programPath.scope);
  const scopes = [...scopeSet];

  for (const scope of scopes) {
    for (const name of Object.keys(scope.bindings)) {
      const binding = scope.bindings[name];
      if (binding.references > 0) continue;
      const bp = binding.path;
      let declPath = null;
      if (bp.isVariableDeclarator()) declPath = bp;
      else if (bp.isFunctionDeclaration()) declPath = bp;
      if (!declPath) continue;
      // Never touch anything exported.
      let exported = false;
      let up = declPath.parentPath;
      while (up) {
        if (up.isExportNamedDeclaration() || up.isExportDefaultDeclaration()) { exported = true; break; }
        up = up.parentPath;
      }
      if (exported) continue;
      if (declPath.isVariableDeclarator()) {
        const init = declPath.node.init;
        if (!init) {
          // `var x;` unused — remove the declarator.
          removals.push({ kind: 'declarator', path: declPath });
          continue;
        }
        if (!isPureExpression(init)) continue;
        removals.push({ kind: 'declarator', path: declPath });
      } else {
        // Respect explicit user intent: a pragma-hot function is never dead.
        const fnLoc = declPath.node.loc;
        if (fnLoc && ctx.pragmas && ctx.pragmas.isHotLine(fnLoc.start.line)) continue;
        removals.push({ kind: 'function', path: declPath });
      }
    }
  }

  // Apply deterministically by source position.
  removals.sort((a, b) => {
    const al = a.path.node.loc ? a.path.node.loc.start.line : 0;
    const bl = b.path.node.loc ? b.path.node.loc.start.line : 0;
    return al - bl || a.path.node.start - b.path.node.start;
  });
  for (const r of removals) {
    if (ctx.isDisabled(r.path, ID, CODE)) continue;
    if (!r.path.node) continue; // parent may already be gone
    try {
      if (r.kind === 'declarator') {
        const decl = r.path.parentPath; // VariableDeclaration
        if (!decl || !decl.node) continue;
        if (decl.node.declarations.length === 1) decl.remove();
        else {
          const idx = decl.node.declarations.indexOf(r.path.node);
          if (idx >= 0) decl.node.declarations.splice(idx, 1);
        }
      } else {
        r.path.remove();
      }
      ctx.applied(ID);
    } catch {
      // Node already removed by an overlapping removal; ignore.
    }
  }
}
