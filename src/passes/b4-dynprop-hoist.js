/**
 * B4 dynprop-hoist — balanced level.
 *
 * `X.getDynamicProperty("k")` with a constant key, read inside a loop in a hot
 * function, is hoisted above the loop when the loop is barrier-free apart from
 * the reads themselves (no other calls, no property writes, no await/yield,
 * no delete) and the receiver is never reassigned inside the loop.
 *
 * Reads are collected from unconditional top-level body statements only.
 * Never cached across tick invocations at this level — that is R1 territory.
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { walkSameFunction } from '../pass-utils.js';

const _traverse = traverse.default || traverse;

export const ID = 'dynprop-hoist';
export const CODE = 'B4';

const LOOP_TYPES = ['ForStatement', 'WhileStatement', 'DoWhileStatement'];

/** Replace oldNode with newNode anywhere in the tree rooted at rootNode. */
function replaceIn(rootNode, oldNode, newNode) {
  const stack = [rootNode];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    for (const key of Object.keys(cur)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra' || key === '__opParent') continue;
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

export default function dynpropHoist(programPath, ctx) {
  programPath.traverse({
    [LOOP_TYPES.join('|')](path) {
      const node = path.node;
      const line = node.loc ? node.loc.start.line : 0;
      const fnParent = path.getFunctionParent();
      if (!fnParent || !ctx.isHot(fnParent.node)) return;
      if (ctx.isDisabled(path, ID, CODE)) return;

      const fail = (reason) => ctx.bail(line, CODE, reason);

      // ---- barrier scan: no calls other than getDynamicProperty reads,
      // no await/yield, no property writes, no delete.
      let hasOtherCall = false;
      let hasAwaitYield = false;
      let hasPropWrite = false;
      const scan = (n) => {
        walkSameFunction(n, (m) => {
          if (t.isFunctionExpression(m) || t.isArrowFunctionExpression(m)) return false;
          if (t.isCallExpression(m)) {
            const isDynPropRead = t.isMemberExpression(m.callee) && !m.callee.computed &&
              t.isIdentifier(m.callee.property) && m.callee.property.name === 'getDynamicProperty' &&
              m.arguments.length === 1 && t.isStringLiteral(m.arguments[0]) &&
              (t.isIdentifier(m.callee.object) || t.isThisExpression(m.callee.object));
            if (!isDynPropRead) { hasOtherCall = true; return false; }
            return true;
          }
          if (t.isNewExpression(m) || t.isTaggedTemplateExpression(m) || t.isOptionalCallExpression(m)) {
            hasOtherCall = true;
            return false;
          }
          if (t.isAwaitExpression(m) || t.isYieldExpression(m)) { hasAwaitYield = true; return false; }
          if (t.isAssignmentExpression(m)) {
            if (t.isMemberExpression(m.left)) { hasPropWrite = true; return false; }
            return true;
          }
          if (t.isUpdateExpression(m)) {
            if (t.isMemberExpression(m.argument)) { hasPropWrite = true; return false; }
            return true;
          }
          if (t.isUnaryExpression(m) && m.operator === 'delete') { hasPropWrite = true; return false; }
          return true;
        });
      };
      walkSameFunction(node.body, scan);
      if (node.type === 'ForStatement') {
        if (node.test) scan(node.test);
        if (node.update) scan(node.update);
      }
      if (hasPropWrite) return fail('loop contains property writes');
      if (hasAwaitYield) return fail('loop contains await/yield');
      if (hasOtherCall) return fail('loop contains calls other than getDynamicProperty reads');

      // ---- collect reads from unconditional top-level body statements
      const reads = []; // { node, stmt, receiverName, isThis, key }
      const collect = (stmt) => {
        walkSameFunction(stmt, (m) => {
          if (t.isFunctionExpression(m) || t.isArrowFunctionExpression(m)) return false;
          if (t.isCallExpression(m) && t.isMemberExpression(m.callee) && !m.callee.computed &&
              t.isIdentifier(m.callee.property) && m.callee.property.name === 'getDynamicProperty' &&
              m.arguments.length === 1 && t.isStringLiteral(m.arguments[0])) {
            const obj = m.callee.object;
            if (t.isIdentifier(obj)) {
              reads.push({ node: m, stmt, receiverName: obj.name, isThis: false, key: m.arguments[0].value });
            } else if (t.isThisExpression(obj)) {
              reads.push({ node: m, stmt, receiverName: null, isThis: true, key: m.arguments[0].value });
            }
          }
          return true;
        });
      };
      const bodyIsBlock = t.isBlockStatement(node.body);
      const topLevel = bodyIsBlock ? node.body.body : [node.body];
      for (const stmt of topLevel) collect(stmt);
      if (reads.length === 0) return;

      // ---- receiver invariance inside the loop
      const loopRange = { start: node.start, end: node.end };
      for (const r of reads) {
        if (r.isThis) continue;
        const binding = path.scope.getBinding(r.receiverName);
        if (!binding) continue;
        for (const viol of binding.constantViolations) {
          const vn = viol.node;
          if (vn && vn.start !== undefined && vn.start >= loopRange.start && vn.end <= loopRange.end) {
            return fail(`receiver "${r.receiverName}" reassigned inside the loop`);
          }
        }
      }

      // ---- group by receiver identity + key
      const bindingId = (name) => {
        const binding = path.scope.getBinding(name);
        return binding ? `b:${bindingScopeId(binding)}` : 'global:' + name;
      };
      const groups = new Map();
      for (const r of reads) {
        const key = (r.isThis ? '@this' : bindingId(r.receiverName)) + '#' + r.key;
        if (!groups.has(key)) groups.set(key, { receiverName: r.receiverName, isThis: r.isThis, key: r.key, uses: [] });
        groups.get(key).uses.push(r);
      }

      // ---- hoist + rewrite
      const decls = [];
      for (const [, g] of groups) {
        const name = path.scope.generateUid('opDP');
        const recv = g.isThis ? t.thisExpression() : t.identifier(g.receiverName);
        const call = t.callExpression(
          t.memberExpression(recv, t.identifier('getDynamicProperty')),
          [t.stringLiteral(g.key)]
        );
        decls.push(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(name), call)]));
        for (const u of g.uses) {
          replaceIn(u.stmt, u.node, t.identifier(name));
        }
      }
      const insertTarget = path.parentPath && path.parentPath.isLabeledStatement() ? path.parentPath : path;
      insertTarget.insertBefore(decls);
      ctx.applied(ID);
    },
  });
}

let scopeCounter = 0;
const scopeIds = new WeakMap();
function bindingScopeId(binding) {
  let id = scopeIds.get(binding);
  if (id === undefined) {
    id = ++scopeCounter;
    scopeIds.set(binding, id);
  }
  return id;
}
