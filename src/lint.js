/**
 * Lint pass — reports anti-patterns with line numbers; never rewrites.
 *
 * Rules:
 *  - per-tick-getAllPlayers   getAllPlayers()/getEntities()/dimension.players
 *                             unconditionally inside per-tick callbacks
 *  - dynprop-in-loop          getDynamicProperty inside tick loops beyond what
 *                             B4 hoisted
 *  - residual-allocs          closures/arrays/object literals remaining inside
 *                             hot callbacks (GC pressure metric)
 *  - subscribe-in-interval    subscribe() called inside runInterval handlers
 *  - json-in-hot              JSON.parse/JSON.stringify/structuredClone in hot
 *                             functions
 *  - try-catch-wraps-tick     try/catch wrapping an entire tick-handler body
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { walkSameFunction } from './pass-utils.js';

const _traverse = traverse.default || traverse;

export function runLint(programPath, ctx, hot) {
  const fr = ctx.fileReport;

  // ---- residual allocations inside hot functions (innermost attribution)
  const counted = new WeakSet();
  programPath.traverse({
    'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression'(path) {
      const fn = path.node;
      if (!ctx.isHot(fn)) return;
      if (counted.has(fn)) return;
      walkSameFunction(fn.body, (n) => {
        if (n !== fn && (t.isFunctionExpression(n) || t.isArrowFunctionExpression(n))) {
          if (counted.has(n)) return false; // attributed to the inner hot fn
          if (ctx.isHot(n)) return true; // visited separately
          if (n.loc) fr.residualAllocs.closures++;
          counted.add(n);
          return false;
        }
        if (t.isFunctionDeclaration(n) && n !== fn) {
          counted.add(n);
          return false;
        }
        if (n.loc && t.isArrayExpression(n)) fr.residualAllocs.arrays++;
        else if (n.loc && t.isObjectExpression(n)) fr.residualAllocs.objects++;
        return true;
      });
      counted.add(fn);
    },
  });

  // ---- per-tick scan
  programPath.traverse({
    'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression'(path) {
      const fn = path.node;
      if (!hot || !hot.isTick(fn)) return;
      const line = fn.loc ? fn.loc.start.line : 0;

      walkSameFunction(fn.body, (n) => {
        // Rule 1: population sweeps in tick handlers.
        if (t.isCallExpression(n) && t.isMemberExpression(n.callee) && !n.callee.computed &&
            t.isIdentifier(n.callee.property)) {
          const m = n.callee.property.name;
          if (m === 'getAllPlayers' || m === 'getEntities') {
            fr.lint.push({
              line: n.loc ? n.loc.start.line : 0,
              rule: 'per-tick-getAllPlayers',
              message: `${m}() runs unconditionally inside a per-tick callback — prefer event-driven updates or caching between ticks`,
            });
          }
          if (m === 'subscribe') {
            fr.lint.push({
              line: n.loc ? n.loc.start.line : 0,
              rule: 'subscribe-in-interval',
              message: 'subscribe() inside a per-tick handler re-registers on every tick — move registration to setup',
            });
          }
          if (m === 'parse' && t.isMemberExpression(n.callee.object) &&
              t.isIdentifier(n.callee.object.object, { name: 'JSON' })) {
            fr.lint.push({
              line: n.loc ? n.loc.start.line : 0,
              rule: 'json-in-hot',
              message: 'JSON.parse in a hot function — parse once at startup instead',
            });
          }
        }
        if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property) &&
            n.property.name === 'players' && !isCallCallee(n)) {
          // dimension.players — only flag when the object looks like a dimension
          if (t.isIdentifier(n.object) && /dimension/i.test(n.object.name)) {
            fr.lint.push({
              line: n.loc ? n.loc.start.line : 0,
              rule: 'per-tick-getAllPlayers',
              message: 'dimension.players allocates a fresh array every read — cache or go event-driven',
            });
          }
        }
        if (t.isCallExpression(n) && t.isMemberExpression(n.callee) && !n.callee.computed &&
            t.isIdentifier(n.callee.property) && n.callee.property.name === 'stringify' &&
            t.isMemberExpression(n.callee.object) && t.isIdentifier(n.callee.object.object, { name: 'JSON' })) {
          fr.lint.push({
            line: n.loc ? n.loc.start.line : 0,
            rule: 'json-in-hot',
            message: 'JSON.stringify in a hot function — serialize only when data changes',
          });
        }
        if (t.isCallExpression(n) && t.isIdentifier(n.callee) && n.callee.name === 'structuredClone') {
          fr.lint.push({
            line: n.loc ? n.loc.start.line : 0,
            rule: 'json-in-hot',
            message: 'structuredClone in a hot function — clones allocate every tick',
          });
        }
        // Rule 2: remaining getDynamicProperty inside loops.
        if ((t.isForStatement(n) || t.isWhileStatement(n) || t.isDoWhileStatement(n) ||
             t.isForOfStatement(n) || t.isForInStatement(n))) {
          walkSameFunction(n.body, (m) => {
            if (t.isCallExpression(m) && t.isMemberExpression(m.callee) && !m.callee.computed &&
                t.isIdentifier(m.callee.property) && m.callee.property.name === 'getDynamicProperty') {
              fr.lint.push({
                line: m.loc ? m.loc.start.line : 0,
                rule: 'dynprop-in-loop',
                message: 'getDynamicProperty inside a tick loop — reads cross the host boundary every iteration',
              });
            }
            return true;
          });
        }
        return true;
      });

      // Rule 6: try/catch wrapping the whole handler body.
      if (t.isBlockStatement(fn.body) && fn.body.body.length === 1 &&
          t.isTryStatement(fn.body.body[0])) {
        fr.lint.push({
          line: fn.body.body[0].loc ? fn.body.body[0].loc.start.line : line,
          rule: 'try-catch-wraps-tick',
          message: 'try/catch wraps the entire tick handler body — errors are swallowed every tick',
        });
      }
    },
  });
}

function isCallCallee(memberPathNode) {
  // We walk nodes without paths here; a member expression that is a callee is
  // handled by the CallExpression branch above, so treat all as non-callee.
  void memberPathNode;
  return false;
}
