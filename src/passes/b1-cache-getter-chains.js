/**
 * B1 cache-getter-chains — balanced level.
 *
 * Within a hot function, repeated identical member chains rooted at a host
 * object are replaced by one hoisted `const`, removing repeated host-boundary
 * crossings and repeated allocations (`p.location.x` twice = 2 allocations +
 * 2 crossings).
 *
 * Barrier model (semantics-preserving):
 *  - Statement runs with NO calls/assignments/await/yield anywhere ("spans")
 *    group chains freely across their top-level statements.
 *  - A statement containing calls is processed with an evaluation-order
 *    "corridor" rule: uses of a chain may group only when no call executes
 *    between them (a call executes before a use when it does not contain the
 *    use and starts earlier; argument/object sub-expressions evaluate before
 *    the call itself). The hoisted const is inserted before the statement,
 *    which is safe exactly when no call executes before the first use.
 *  - await/yield always end a region. Loops and for-of/for-in are barriers.
 *
 * Host-object heuristic: root is a parameter of the hot function, `this`, a
 * previously hoisted synthetic const, or the chain contains a marker property
 * (`world`, `location`, `getComponent`, `getEntities`, `getAllPlayers`,
 * `dimension`, ...).
 *
 * Chains overlapping a property write are never hoisted; roots reassigned in
 * scope are never hoisted. Both are recorded as bails, as are repeated chains
 * that could not group because a call barrier sits between their uses.
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { walkSameFunction, walkWithParents, corridorSafe, ChainAnalyzer, HOST_MARKERS } from '../pass-utils.js';

const _traverse = traverse.default || traverse;

export const ID = 'cache-getter-chains';
export const CODE = 'B1';

function hasBarrierSubtree(node) {
  let found = false;
  walkSameFunction(node, (n) => {
    if (found) return false;
    if (t.isCallExpression(n) || t.isNewExpression(n) || t.isTaggedTemplateExpression(n) ||
        t.isOptionalCallExpression(n) || t.isAwaitExpression(n) || t.isYieldExpression(n) ||
        t.isAssignmentExpression(n) || t.isUpdateExpression(n) ||
        t.isForOfStatement(n) || t.isForInStatement(n) ||
        t.isForStatement(n) || t.isWhileStatement(n) || t.isDoWhileStatement(n)) {
      found = true;
      return false;
    }
    if (t.isUnaryExpression(n) && n.operator === 'delete') { found = true; return false; }
    return true;
  });
  return found;
}

/** R4 mode: only await/yield are uncrossable. */
function hasSuspensionSubtree(node) {
  let found = false;
  walkSameFunction(node, (n) => {
    if (found) return false;
    if (t.isAwaitExpression(n) || t.isYieldExpression(n)) { found = true; return false; }
    return true;
  });
  return found;
}

function describeChain(memberNode) {
  const links = [];
  let cur = memberNode;
  let root = null;
  let isThis = false;
  while (true) {
    if (!t.isMemberExpression(cur)) break;
    if (cur.computed || !t.isIdentifier(cur.property)) return null;
    links.unshift(cur.property.name);
    const obj = cur.object;
    if (t.isMemberExpression(obj)) { cur = obj; continue; }
    if (t.isIdentifier(obj)) root = obj;
    else if (t.isThisExpression(obj)) { isThis = true; }
    else return null;
    break;
  }
  if (!root && !isThis) return null;
  return { root, isThis, links };
}

/** Replace oldNode with newNode anywhere in the tree rooted at rootNode. */
function replaceIn(rootNode, oldNode, newNode) {
  const stack = [rootNode];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    for (const key of Object.keys(cur)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra') continue;
      const v = cur[key];
      if (v === oldNode) { cur[key] = newNode; return true; }
      if (Array.isArray(v)) {
        const idx = v.indexOf(oldNode);
        if (idx >= 0) { v[idx] = newNode; return true; }
        for (const item of v) if (item && typeof item === 'object' && typeof item.type === 'string') stack.push(item);
      } else if (v && typeof v === 'object' && typeof v.type === 'string') {
        stack.push(v);
      }
    }
  }
  return false;
}

const pos = (n) => (n.start !== undefined ? n.start : (n.loc ? n.loc.start.index ?? 0 : 0));
void pos;

export default function cacheGetterChains(programPath, ctx, opts = {}) {
  const crossBarriers = !!opts.crossBarriers;
  const passId = opts.id || ID;
  const passCode = opts.code || CODE;
  const onApply = opts.onApply || null;
  const analyzer = new ChainAnalyzer();

  // Collect unconditionally-evaluated chain uses from a statement subtree.
  const collectFromNode = (n, stmt, uses) => {
    walkWithParents(n, (m, parent) => {
      if (t.isFunctionExpression(m) || t.isArrowFunctionExpression(m)) return false;
      if (!t.isMemberExpression(m) || m.computed) return true;
      // Never hoist a chain used as a call callee — extracting the method
      // would detach `this`.
      if (parent && t.isCallExpression(parent) && parent.callee === m) return true;
      const chain = describeChain(m);
      if (chain && chain.links.length >= 1) {
        uses.push({ node: m, stmt, ...chain });
      }
      return true;
    });
  };
  const collectFromStmt = (stmt, uses) => {
    if (t.isBlockStatement(stmt)) { for (const s of stmt.body) collectFromStmt(s, uses); return; }
    if (t.isLabeledStatement(stmt)) { collectFromStmt(stmt.body, uses); return; }
    if (t.isIfStatement(stmt)) { collectFromNode(stmt.test, stmt, uses); return; }
    if (t.isSwitchStatement(stmt)) { collectFromNode(stmt.discriminant, stmt, uses); return; }
    if (t.isWhileStatement(stmt) || t.isDoWhileStatement(stmt) || t.isForStatement(stmt) ||
        t.isForOfStatement(stmt) || t.isForInStatement(stmt) || t.isTryStatement(stmt)) return;
    // Conditional sub-expressions are not unconditionally evaluated.
    const walkNoCond = (n, cb) => {
      walkWithParents(n, (m, parent) => {
        if (t.isConditionalExpression(m)) {
          walkNoCond(m.test, cb);
          return false;
        }
        if (t.isLogicalExpression(m)) {
          walkNoCond(m.left, cb);
          return false;
        }
        return cb(m, parent);
      });
    };
    walkNoCond(stmt, (m, parent) => {
      if (!t.isMemberExpression(m) || m.computed) return true;
      // Never cache a chain used as a call callee — extracting the method
      // would detach `this`.
      if (parent && t.isCallExpression(parent) && parent.callee === m) return true;
      const chain = describeChain(m);
      if (chain && chain.links.length >= 1) uses.push({ node: m, stmt, ...chain });
      return true;
    });
  };

  /** All call-family nodes in a statement (excluding nested functions). */
  const contains = (outer, inner) => outer.start <= inner.start && inner.end <= outer.end;

  const processStatementList = (stmts, ownerPath, fnNode, isCaseList, depth) => {
    if (depth > 6 || !stmts || stmts.length === 0) return;

    // Partition into units: maximal barrier-free spans and standalone barrier
    // statements.
    const units = [];
    let span = [];
    for (const stmt of stmts) {
      const barrier = crossBarriers ? hasSuspensionSubtree(stmt) : hasBarrierSubtree(stmt);
      if (barrier) {
        if (span.length > 0) { units.push({ kind: 'span', stmts: span }); span = []; }
        units.push({ kind: 'single', stmts: [stmt] });
      } else {
        span.push(stmt);
      }
    }
    if (span.length > 0) units.push({ kind: 'span', stmts: span });

    // Global chain census for bail reporting.
    const allUsesByStmt = new Map();
    for (const stmt of stmts) {
      const uses = [];
      collectFromStmt(stmt, uses);
      allUsesByStmt.set(stmt, uses);
    }

    const bindingId = (name) => {
      const binding = ownerPath.scope.getBinding(name);
      return binding ? analyzer.bindingId(binding) : 'global:' + name;
    };
    const isParamOfFn = (name) => {
      const params = fnNode.params || [];
      return params.some((p) => t.isIdentifier(p) && p.name === name);
    };
    const neverReassigned = (name) => {
      const binding = ownerPath.scope.getBinding(name);
      if (!binding) return true;
      return binding.constantViolations.length === 0;
    };
    const writeChainsFor = (stmts2) => {
      const out = [];
      for (const stmt of stmts2) {
        walkSameFunction(stmt, (n) => {
          let target = null;
          if (t.isAssignmentExpression(n) && t.isMemberExpression(n.left)) target = n.left;
          else if (t.isUpdateExpression(n) && t.isMemberExpression(n.argument)) target = n.argument;
          else if (t.isUnaryExpression(n) && n.operator === 'delete' && t.isMemberExpression(n.argument)) target = n.argument;
          if (target) {
            const c = describeChain(target);
            if (c) out.push(c);
          }
          return true;
        });
      }
      return out;
    };

    const groupKeyOf = (u) => (u.isThis ? '@this' : bindingId(u.root.name)) + '#' + u.links.join('.');
    const qualify = (g, writes) => {
      const linksStr = g.links.join('.');
      if (!g.isThis) {
        const overlap = writes.some((w) => {
          if (w.isThis !== g.isThis) return false;
          if (!w.isThis && bindingId(w.root.name) !== bindingId(g.root.name)) return false;
          const ws = w.links.join('.');
          return ws === linksStr || ws.startsWith(linksStr + '.') || linksStr.startsWith(ws + '.');
        });
        if (overlap) return `chain .${linksStr} overlaps a property write`;
        if (g.root && !neverReassigned(g.root.name)) return `root "${g.root.name}" is reassigned in scope`;
      }
      const synthetic = !g.isThis && g.root && analyzer.syntheticRoots.has(g.root.name);
      const hasMarker = g.links.some((l) => HOST_MARKERS.has(l));
      const isParam = !g.isThis && g.root && isParamOfFn(g.root.name);
      if (!g.isThis && !synthetic && !hasMarker && !isParam) {
        return `chain .${linksStr} has no recognizable host root`;
      }
      return null;
    };

    const hoistedKeys = new Set();
    const groupUseTotals = new Map(); // key -> total uses (for bail reporting)
    for (const [, uses] of allUsesByStmt) {
      for (const u of uses) {
        const k = groupKeyOf(u);
        groupUseTotals.set(k, (groupUseTotals.get(k) || 0) + 1);
      }
    }

    const tryHoist = (uses, writes, insertBeforeStmt, unitStmts) => {
      // Group by chain key.
      const groups = new Map();
      for (const u of uses) {
        const k = groupKeyOf(u);
        if (!groups.has(k)) groups.set(k, { root: u.root, isThis: u.isThis, links: u.links, uses: [] });
        groups.get(k).uses.push(u);
      }
      const entries = [...groups.entries()].sort((a, b) => {
        const d = b[1].links.length - a[1].links.length;
        return d || (a[0] < b[0] ? -1 : 1);
      });
      const consumed = globalConsumed;
      const decls = [];
      const allUses = [...uses];
      for (const [, g] of entries) {
        const live = g.uses.filter((u) => !consumed.has(u.node));
        if (live.length < 2) continue;
        const problem = qualify(g, writes);
        if (problem) {
          if (!hoistedKeys.has(groupKeyOf(g))) {
            const line = live[0].node.loc ? live[0].node.loc.start.line : 0;
            ctx.bail(line, passCode, problem);
          }
          continue;
        }
        const name = ownerPath.scope.generateUid('opC');
        let expr = g.isThis ? t.thisExpression() : t.identifier(g.root.name);
        for (const link of g.links) expr = t.memberExpression(expr, t.identifier(link));
        decls.push(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(name), expr)]));
        if (!g.isThis) analyzer.markSynthetic(name);
        hoistedKeys.add(groupKeyOf(g));
        ctx.applied(passId);
        if (onApply) {
          const line = live[0].node.loc ? live[0].node.loc.start.line : 0;
          onApply(line, g.links.join('.'));
        }
        for (const u of live) {
          consumed.add(u.node);
          replaceIn(u.stmt, u.node, t.identifier(name));
          for (const u2 of allUses) {
            if (consumed.has(u2.node)) continue;
            if (u2.isThis !== g.isThis) continue;
            if (!u2.isThis && bindingId(u2.root.name) !== bindingId(g.root.name)) continue;
            if (u2.links.length < g.links.length &&
                g.links.slice(0, u2.links.length).join('.') === u2.links.join('.')) {
              consumed.add(u2.node);
            }
          }
        }
      }
      if (decls.length > 0 && insertBeforeStmt) {
        if (isCaseList) {
          const idx = ownerPath.node.consequent.indexOf(insertBeforeStmt);
          ownerPath.node.consequent.splice(idx < 0 ? 0 : idx, 0, ...decls);
        } else {
          let stmtPath = null;
          ownerPath.traverse({
            Statement(p) { if (p.node === insertBeforeStmt && !stmtPath) { stmtPath = p; p.stop(); } },
          });
          if (stmtPath) stmtPath.insertBefore(decls);
          else {
            const arr = ownerPath.node.body;
            const idx = arr.indexOf(insertBeforeStmt);
            if (idx >= 0) arr.splice(idx, 0, ...decls);
          }
        }
      }
      return decls.length > 0;
    };

    const globalConsumed = new Set();
    let anyApplied = false;
    for (const unit of units) {
      if (unit.kind === 'span') {
        const uses = [];
        for (const stmt of unit.stmts) collectFromStmt(stmt, uses);
        if (uses.length === 0) continue;
        // First use's statement is the insertion point.
        uses.sort((a, b) => pos(a.node) - pos(b.node));
        const firstStmt = uses[0].stmt;
        anyApplied = tryHoist(uses, writeChainsFor(unit.stmts), firstStmt, unit.stmts) || anyApplied;
      } else {
        const stmt = unit.stmts[0];
        const uses = [];
        collectFromStmt(stmt, uses);
        if (uses.length === 0) continue;
        uses.sort((a, b) => pos(a.node) - pos(b.node));
        // Group uses by chain, then corridor-check each group independently.
        const byChain = new Map();
        for (const u of uses) {
          const k = groupKeyOf(u);
          if (!byChain.has(k)) byChain.set(k, []);
          byChain.get(k).push(u);
        }
        const eligible = [];
        for (const [, list] of byChain) {
          if (corridorSafe(stmt, list.map((u) => u.node))) eligible.push(...list);
        }
        if (eligible.length === 0) continue;
        anyApplied = tryHoist(eligible, writeChainsFor([stmt]), stmt, [stmt]) || anyApplied;
      }
    }

    // Bail reporting: repeated chains (>= 2 live uses anywhere in this list)
    // that never got hoisted. Prefix groups fully consumed by longer hoists
    // are not reported.
    for (const [key, total] of groupUseTotals) {
      if (total < 2 || hoistedKeys.has(key)) continue;
      let live = 0;
      for (const [, uses] of allUsesByStmt) {
        live += uses.filter((u) => groupKeyOf(u) === key && !globalConsumed.has(u.node)).length;
      }
      if (live < 2) continue;
      // Find one representative use line.
      for (const [, uses] of allUsesByStmt) {
        const rep = uses.find((u) => groupKeyOf(u) === key && !globalConsumed.has(u.node) && u.node.loc);
        if (rep) {
          const linksStr = key.split('#')[1];
          ctx.bail(rep.node.loc.start.line, passCode,
            `chain .${linksStr} repeats but uses are split by call/assignment barriers`);
          break;
        }
      }
    }

    // Recurse into nested blocks / switch cases.
    ownerPath.traverse({
      BlockStatement(bp) {
        if (bp.node === ownerPath.node) return;
        processStatementList(bp.node.body, bp, fnNode, false, depth + 1);
      },
      SwitchCase(cp) {
        processStatementList(cp.node.consequent, cp, fnNode, true, depth + 1);
      },
    });
  };

  programPath.traverse({
    'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression'(path) {
      const fn = path.node;
      if (!ctx.isHot(fn)) return;
      if (ctx.isDisabled(path, passId, passCode)) return;
      if (t.isBlockStatement(fn.body)) {
        const bodyPath = path.get('body');
        processStatementList(fn.body.body, bodyPath, fn, false, 0);
      }
    },
  });
}
