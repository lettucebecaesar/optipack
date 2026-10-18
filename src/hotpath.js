/**
 * Hot-path classification and the shared pass context.
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';

const _traverse = traverse.default || traverse;

const HOT_CALLEE_NAMES = new Set(['runInterval', 'runTimeout', 'run', 'runJob', 'subscribe']);
const TICK_CALLEE_NAMES = new Set(['runInterval', 'run']);

function functionLike(node) {
  return t.isFunctionDeclaration(node) || t.isFunctionExpression(node) || t.isArrowFunctionExpression(node);
}

/**
 * Analyze the AST and classify functions as hot.
 * Returns a HotInfo with:
 *   isHot(node), isTick(node), hotCount, tickCount,
 *   markHot(node), copyHotness(fromNode, toNode)
 */
export function analyzeHotPaths(ast, pragmas, { transitiveDepth = 1 } = {}) {
  const hot = new WeakSet();
  const tick = new WeakSet();
  let hotCount = 0;
  let tickCount = 0;

  const addHot = (node, isTick) => {
    if (!functionLike(node)) return;
    if (!hot.has(node)) hotCount++;
    hot.add(node);
    if (isTick && !tick.has(node)) tickCount++;
    if (isTick) tick.add(node);
  };

  // Resolve an argument that refers to a same-file function (by binding).
  const resolveArg = (path, arg) => {
    if (functionLike(arg)) return { node: arg, viaBinding: null };
    if (t.isIdentifier(arg)) {
      const binding = path.scope.getBinding(arg.name);
      if (!binding) return null;
      if (binding.path.isFunctionDeclaration()) return { node: binding.path.node, viaBinding: binding };
      if (binding.path.isVariableDeclarator()) {
        const init = binding.path.node.init;
        if (functionLike(init)) return { node: init, viaBinding: binding };
      }
    }
    return null;
  };

  // Pass 1: direct registration sites.
  _traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee) || callee.computed) return;
      const prop = callee.property;
      if (!t.isIdentifier(prop)) return;
      if (prop.name === 'subscribe' || HOT_CALLEE_NAMES.has(prop.name)) {
        const firstFn = path.node.arguments.find((a) => functionLike(a));
        if (firstFn) {
          addHot(firstFn, TICK_CALLEE_NAMES.has(prop.name));
          return;
        }
        const arg = path.node.arguments[0];
        if (!arg) return;
        const r = resolveArg(path, arg);
        if (r) addHot(r.node, TICK_CALLEE_NAMES.has(prop.name));
      }
    },
  });

  // Pass 1b: pragma hot marks.
  _traverse(ast, {
    'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression'(path) {
      const node = path.node;
      if (node.loc && pragmas.isHotLine(node.loc.start.line)) addHot(node, false);
    },
  });

  // Pass 2: transitive propagation through the same-file call graph.
  // callGraph: targetNode -> Set of caller nodes (null = module top level)
  // Also tracks reference sites for functions passed around as values.
  const callersOf = new Map();
  const recordCaller = (targetNode, callerNode) => {
    if (!targetNode) return;
    if (!callersOf.has(targetNode)) callersOf.set(targetNode, new Set());
    callersOf.get(targetNode).add(callerNode);
  };

  const resolveCalleeNode = (path, callee) => {
    if (!t.isIdentifier(callee)) return null;
    if (callee.name === 'arguments' || callee.name === 'eval') return null;
    const binding = path.scope.getBinding(callee.name);
    if (!binding) return null;
    if (binding.path.isFunctionDeclaration()) return binding.path.node;
    if (binding.path.isVariableDeclarator()) {
      const init = binding.path.node.init;
      if (functionLike(init)) return init;
    }
    return null;
  };

  _traverse(ast, {
    CallExpression(path) {
      const target = resolveCalleeNode(path, path.node.callee);
      if (target) recordCaller(target, path.getFunctionParent() ? path.getFunctionParent().node : null);
    },
    ReferencedIdentifier(path) {
      // A function referenced as a value (e.g. passed to runInterval) counts as
      // a use site within the enclosing function.
      const binding = path.scope.getBinding(path.node.name);
      if (!binding) return;
      let target = null;
      if (binding.path.isFunctionDeclaration()) target = binding.path.node;
      else if (binding.path.isVariableDeclarator() && binding.path.node.init && functionLike(binding.path.node.init)) {
        target = binding.path.node.init;
      }
      if (!target) return;
      // Skip the declaration's own identifier.
      if (binding.path.node.id === path.node || (binding.path.node.init && binding.path.node.init === path.node)) return;
      recordCaller(target, path.getFunctionParent() ? path.getFunctionParent().node : null);
    },
  });

  // BFS from the directly-hot set. A candidate becomes hot when every
  // reference site is inside an already-hot function (i.e. it is only ever
  // reached from hot code) and it has at least one reference site.
  for (let depth = 0; depth < transitiveDepth; depth++) {
    let changed = false;
    for (const [target, callers] of callersOf) {
      if (hot.has(target) || callers.size === 0) continue;
      if (callers.has(null)) continue; // referenced at module top level
      let allHot = true;
      for (const c of callers) {
        if (!hot.has(c)) { allHot = false; break; }
      }
      if (allHot) {
        // Inherit tick-ness: if all callers are tick handlers, so is this.
        let allTick = callers.size > 0;
        for (const c of callers) if (!tick.has(c)) { allTick = false; break; }
        addHot(target, allTick);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return {
    isHot: (node) => hot.has(node),
    isTick: (node) => tick.has(node),
    markHot: (node) => addHot(node, false),
    copyHotness(fromNode, toNode) {
      if (hot.has(fromNode)) addHot(toNode, tick.has(fromNode));
    },
    get hotCount() { return hotCount; },
    get tickCount() { return tickCount; },
  };
}
