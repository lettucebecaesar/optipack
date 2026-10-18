/**
 * S7 hoist-invariant-members — hot functions only.
 *
 * Two hoist modes for for/while/do loops:
 *
 * 1. Body-top hoist (always safe): a member chain evaluated two or more times
 *    per iteration, in unconditional top-level body statements, is hoisted to
 *    a `const` at the top of the loop body. The root may be the loop variable.
 *
 * 2. Before-loop hoist: when the whole loop subtree is barrier-free (no calls,
 *    no await/yield, no property writes, no delete; assignments to plain local
 *    identifiers are allowed but their names must not appear in any hoisted
 *    chain), a host chain rooted at a value that is never reassigned anywhere
 *    in the enclosing function and not declared inside the loop is hoisted to
 *    a `const` BEFORE the loop — eliminating the per-iteration boundary
 *    crossing entirely (e.g. `total += chest.location.y`).
 *
 * Bail conditions (recorded): body contains calls / await / yield / property
 * writes; chain root reassigned; chain contains computed accesses; root is a
 * loop binding; qualifying chains exist but none could be hoisted.
 *
 * Known assumption (documented in README): the before-loop hoist evaluates the
 * chain once even when the loop body never runs; for live host objects these
 * reads are side-effect-free, but a null root combined with a zero-iteration
 * loop would newly throw.
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { walkSameFunction, walkWithParents, HOST_MARKERS, ChainAnalyzer } from '../pass-utils.js';

const _traverse = traverse.default || traverse;

export const ID = 'hoist-invariant-members';
export const CODE = 'S7';

const LOOP_TYPES = ['ForStatement', 'WhileStatement', 'DoWhileStatement'];

export default function hoistInvariantMembers(programPath, ctx) {
  const chains = new ChainAnalyzer();

  programPath.traverse({
    [LOOP_TYPES.join('|')](path) {
      const node = path.node;
      const line = node.loc ? node.loc.start.line : 0;
      const fnParent = path.getFunctionParent();
      if (!fnParent || !ctx.isHot(fnParent.node)) return;
      if (ctx.isDisabled(path, ID, CODE)) return;

      const fail = (reason) => {
        ctx.bail(line, CODE, reason);
        return null;
      };

      // ---- barrier scan over the loop subtree (excluding nested functions)
      let hasCall = false;
      let hasAwaitYield = false;
      let hasPropWrite = false;
      const assignTargets = new Set();
      const scan = (allowLocalAssign) => (n) => {
        if (t.isCallExpression(n) || t.isNewExpression(n) || t.isTaggedTemplateExpression(n) ||
            t.isOptionalCallExpression(n)) { hasCall = true; return false; }
        if (t.isAwaitExpression(n) || t.isYieldExpression(n)) { hasAwaitYield = true; return false; }
        if (t.isAssignmentExpression(n)) {
          if (t.isMemberExpression(n.left)) { hasPropWrite = true; return false; }
          if (t.isIdentifier(n.left)) assignTargets.add(n.left.name);
          return true;
        }
        if (t.isUpdateExpression(n)) {
          if (t.isMemberExpression(n.argument)) { hasPropWrite = true; return false; }
          if (t.isIdentifier(n.argument)) assignTargets.add(n.argument.name);
          return true;
        }
        if (t.isUnaryExpression(n) && n.operator === 'delete') { hasPropWrite = true; return false; }
        return true;
      };
      walkSameFunction(node.body, scan(true));
      let forPartsBarrierFree = true;
      if (node.type === 'ForStatement') {
        for (const part of [node.test, node.update]) {
          if (!part) continue;
          walkSameFunction(part, (n) => {
            if (t.isCallExpression(n) || t.isNewExpression(n) || t.isTaggedTemplateExpression(n)) { hasCall = true; forPartsBarrierFree = false; return false; }
            if (t.isAwaitExpression(n) || t.isYieldExpression(n)) { hasAwaitYield = true; forPartsBarrierFree = false; return false; }
            if ((t.isAssignmentExpression(n) || t.isUpdateExpression(n)) && t.isMemberExpression(n.left ?? n.argument)) {
              hasPropWrite = true; forPartsBarrierFree = false; return false;
            }
            return true;
          });
        }
      }
      const barrierFree = !hasCall && !hasAwaitYield && !hasPropWrite;
      if (!barrierFree) {
        return fail(
          hasCall ? 'loop body contains calls (mutation barrier)'
            : hasAwaitYield ? 'loop body contains await/yield'
              : 'loop body contains property writes'
        );
      }

      // ---- collect member uses from top-level body statements.
      // Only chains that are UNCONDITIONALLY evaluated when the body runs are
      // collected: nested if/loop/try bodies and switch cases are excluded
      // (their reads may never execute), while plain nested blocks and if/switch
      // test expressions are included.
      const uses = []; // { node, root, isThis, links }
      const collectFromNode = (n) => {
        walkWithParents(n, (m, parent) => {
          if (t.isFunctionExpression(m) || t.isArrowFunctionExpression(m)) return false;
          if (!t.isMemberExpression(m) || m.computed) return true;
          // Never hoist a chain used as a call callee — extracting the method
          // would detach `this`.
          if (parent && t.isCallExpression(parent) && parent.callee === m) return true;
          const links = [];
          let cur = m;
          let root = null;
          let isThis = false;
          let ok = true;
          while (true) {
            if (!t.isMemberExpression(cur)) break;
            if (cur.computed || !t.isIdentifier(cur.property)) { ok = false; break; }
            links.unshift(cur.property.name);
            const obj = cur.object;
            if (t.isMemberExpression(obj)) { cur = obj; continue; }
            if (t.isIdentifier(obj)) root = obj;
            else if (t.isThisExpression(obj)) { isThis = true; }
            else { ok = false; }
            break;
          }
          if (ok && (root || isThis) && links.length >= 1) {
            uses.push({ node: m, root, isThis, links });
          }
          return true;
        });
      };
      const collectFromStmt = (stmt) => {
        if (t.isBlockStatement(stmt)) {
          for (const s of stmt.body) collectFromStmt(s);
          return;
        }
        if (t.isLabeledStatement(stmt)) { collectFromStmt(stmt.body); return; }
        if (t.isIfStatement(stmt)) { collectFromNode(stmt.test); return; }
        if (t.isSwitchStatement(stmt)) { collectFromNode(stmt.discriminant); return; }
        if (t.isWhileStatement(stmt) || t.isDoWhileStatement(stmt) || t.isForStatement(stmt) ||
            t.isForOfStatement(stmt) || t.isForInStatement(stmt) || t.isTryStatement(stmt)) {
          return; // conditionally evaluated / barrier-heavy constructs
        }
        collectFromNode(stmt);
      };
      const bodyIsBlock = t.isBlockStatement(node.body);
      const topLevelStmts = bodyIsBlock ? node.body.body : [node.body];
      for (const stmt of topLevelStmts) collectFromStmt(stmt);
      if (uses.length === 0) return;

      // ---- group by chain identity
      const bindingId = (name) => {
        const binding = path.scope.getBinding(name);
        return binding ? chains.bindingId(binding) : 'global:' + name;
      };
      const groups = new Map(); // key -> { root, isThis, links, uses: [] }
      for (const u of uses) {
        const key = (u.isThis ? '@this' : bindingId(u.root.name)) + '#' + u.links.join('.');
        if (!groups.has(key)) groups.set(key, { root: u.root, isThis: u.isThis, links: u.links, uses: [] });
        groups.get(key).uses.push(u);
      }

      // ---- qualification helpers
      const rootInfo = (name) => {
        const binding = path.scope.getBinding(name);
        return binding;
      };
      const isParamOfEnclosingFn = (name) => {
        const binding = rootInfo(name);
        if (!binding) return false;
        return binding.path.parentPath && binding.path.parentPath.isFunction() &&
          binding.path.node === binding.path.parentPath.node.params.find((p) => t.isIdentifier(p) && p.name === name);
      };
      const declaredInsideLoop = (name) => {
        const binding = rootInfo(name);
        if (!binding) return false;
        let p = binding.path;
        while (p) {
          if (p.node === node) return true;
          p = p.parentPath;
        }
        return false;
      };
      const neverReassignedAnywhere = (name) => {
        const binding = rootInfo(name);
        if (!binding) return true;
        return binding.constantViolations.length === 0;
      };

      // Longer chains first for deterministic, maximal sharing.
      const entries = [...groups.entries()].sort((a, b) => {
        const d = b[1].links.length - a[1].links.length;
        return d || (a[0] < b[0] ? -1 : 1);
      });

      const hoists = []; // { where: 'before'|'body', links, root, isThis, uses, name }
      for (const [, g] of entries) {
        if (g.uses.length < 1) continue;
        if (!g.isThis) {
          if (assignTargets.has(g.root.name)) continue; // root mutated in loop
        }
        const hasMarker = g.links.some((l) => HOST_MARKERS.has(l));
        const isParam = !g.isThis && isParamOfEnclosingFn(g.root.name);
        const qualified = g.isThis || isParam || hasMarker;
        if (!qualified) continue;

        const beforeLoopEligible = barrierFree && forPartsBarrierFree && !g.isThis &&
          neverReassignedAnywhere(g.root.name) && !declaredInsideLoop(g.root.name);

        if (beforeLoopEligible && g.uses.length >= 1) {
          hoists.push({ where: 'before', ...g });
        } else if (g.uses.length >= 2 && g.root && !declaredInsideLoop(g.root.name)) {
          // Body-top: root may be the loop variable only if declared before
          // uses — loop bindings are declared in the head, which precedes the
          // body, so this is fine. Body-declared roots must be declared before
          // their first use.
          const binding = rootInfo(g.root.name);
          const firstUse = g.uses[0].node;
          if (!binding || (binding.path.node.loc && firstUse.loc &&
              binding.path.node.loc.start.line <= firstUse.loc.start.line)) {
            hoists.push({ where: 'body', ...g });
          }
        }
      }
      if (hoists.length === 0) {
        return fail('qualifying chains exist but none is repeated twice or is loop-invariant');
      }

      // ---- consume uses: longest chains first; a use consumed by a longer
      // hoist also consumes its prefix nodes (they live inside the replaced
      // subtree and would dangle).
      const consumed = new Set();
      const allUses = [];
      for (const [, g] of entries) allUses.push(...g.uses);
      const sameRoot = (a, b) =>
        a.isThis === b.isThis && (a.isThis || (a.root && b.root && a.root.name === b.root.name &&
          bindingId(a.root.name) === bindingId(b.root.name)));
      const finalHoists = [];
      for (const h of hoists) {
        const live = h.uses.filter((u) => !consumed.has(u.node));
        if (live.length === 0) continue;
        if (h.where === 'body' && live.length < 2) continue;
        for (const u of live) {
          consumed.add(u.node);
          // Consume prefix uses of the same root (they sit inside the subtree).
          for (const u2 of allUses) {
            if (consumed.has(u2.node)) continue;
            if (!sameRoot(u2, u)) continue;
            if (u2.links.length < u.links.length &&
                u.links.slice(0, u2.links.length).join('.') === u2.links.join('.')) {
              consumed.add(u2.node);
            }
          }
        }
        finalHoists.push({ ...h, uses: live });
      }
      if (finalHoists.length === 0) return fail('all chain uses were consumed by longer hoists');

      // ---- emit
      const beforeDecls = [];
      const bodyDecls = [];
      const scope = path.scope;
      for (const h of finalHoists) {
        const name = scope.generateUid('opH');
        let expr = h.isThis ? t.thisExpression() : t.identifier(h.root.name);
        for (const link of h.links) expr = t.memberExpression(expr, t.identifier(link));
        const decl = t.variableDeclaration('const', [t.variableDeclarator(t.identifier(name), expr)]);
        if (h.where === 'before') beforeDecls.push(decl);
        else bodyDecls.push(decl);
        for (const u of h.uses) {
          u.node.__opHoistName = name;
        }
      }

      // Rewrite uses: replace member nodes that carry __opHoistName.
      const rewrite = (rootNode) => {
        walkSameFunction(rootNode, (n) => {
          if (n && n.__opHoistName) {
            const name = n.__opHoistName;
            delete n.__opHoistName;
            // Replace this node within its parent object (AST surgery).
            replaceNodeInParent(rootNode, n, t.identifier(name));
            return false;
          }
          return true;
        });
      };
      for (const stmt of topLevelStmts) rewrite(stmt);

      if (beforeDecls.length > 0) {
        const insertTarget = path.parentPath && path.parentPath.isLabeledStatement() ? path.parentPath : path;
        insertTarget.insertBefore(beforeDecls);
      }
      if (bodyDecls.length > 0) {
        if (bodyIsBlock) node.body.body = [...bodyDecls, ...node.body.body];
        else node.body = t.blockStatement([...bodyDecls, node.body]);
      }
      ctx.applied(ID);
    },
  });
}

/** Replace oldNode with newNode anywhere in the tree rooted at rootNode. */
function replaceNodeInParent(rootNode, oldNode, newNode) {
  const stack = [rootNode];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const key of Object.keys(cur)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra') continue;
      const v = cur[key];
      if (v === oldNode) { cur[key] = newNode; return true; }
      if (Array.isArray(v)) {
        const idx = v.indexOf(oldNode);
        if (idx >= 0) { v[idx] = newNode; return true; }
        for (const item of v) {
          if (item && typeof item === 'object' && typeof item.type === 'string') stack.push(item);
        }
      } else if (v && typeof v === 'object' && typeof v.type === 'string') {
        stack.push(v);
      }
    }
  }
  return false;
}
