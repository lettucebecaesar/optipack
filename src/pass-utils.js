/**
 * Shared AST analysis helpers used by the passes.
 * All checks are conservative: when in doubt, the answer is "no".
 */
import * as t from '@babel/types';

const SKIP_KEYS = new Set([
  'loc', 'start', 'end', 'range', 'leadingComments', 'trailingComments',
  'innerComments', 'comments', 'extra', 'tokens', 'regex', 'value',
]);

/** Generic DFS over an AST node. enter() returning false skips the subtree. */
export function walk(node, enter) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, enter);
    return;
  }
  if (typeof node.type !== 'string') return;
  if (enter(node) === false) return;
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item && typeof item === 'object') walk(item, enter);
        }
      } else if (typeof v.type === 'string') {
        walk(v, enter);
      }
    }
  }
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ClassMethod', 'ObjectMethod', 'ClassPrivateMethod',
]);

/** Like walk() but stops at function boundaries (does not descend into them). */
export function walkSameFunction(node, enter) {
  return walk(node, (n) => {
    if (FUNCTION_TYPES.has(n.type) && n !== node) return false;
    return enter(n);
  });
}

/**
 * DFS with parent tracking; stops at function boundaries like walkSameFunction.
 * enter(node, parent) — parent is the directly containing node (or null).
 */
export function walkWithParents(node, enter) {
  const rec = (n, parent) => {
    if (!n || typeof n !== 'object' || typeof n.type !== 'string') return true;
    if (FUNCTION_TYPES.has(n.type) && n !== node) return true; // skip, don't enter
    if (enter(n, parent) === false) return false;
    for (const key of Object.keys(n)) {
      if (SKIP_KEYS.has(key)) continue;
      const v = n[key];
      if (v && typeof v === 'object') {
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item && typeof item === 'object' && typeof item.type === 'string') {
              if (!rec(item, n)) return false;
            }
          }
        } else if (typeof v.type === 'string') {
          if (!rec(v, n)) return false;
        }
      }
    }
    return true;
  };
  return rec(node, null);
}

export const BARRIER_KINDS = {
  call: new Set(['CallExpression', 'NewExpression', 'TaggedTemplateExpression']),
  assign: new Set(['AssignmentExpression', 'UpdateExpression', 'ForInStatement', 'ForOfStatement']),
  awaitYield: new Set(['AwaitExpression', 'YieldExpression']),
  loop: new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']),
};

function kindsHas(set, node) {
  return set.has(node.type);
}

/**
 * Does `node`'s subtree contain a barrier?
 * opts: { calls=true, assigns=true, awaitYield=true, loops=false, skipFunctions=false }
 */
export function containsBarrier(node, opts = {}) {
  const { calls = true, assigns = true, awaitYield = true, loops = false, skipFunctions = false } = opts;
  let found = false;
  walkSameFunctionAll(node, skipFunctions, (n) => {
    if (found) return false;
    if (calls && kindsHas(BARRIER_KINDS.call, n)) { found = true; return false; }
    if (assigns && kindsHas(BARRIER_KINDS.assign, n)) { found = true; return false; }
    if (awaitYield && kindsHas(BARRIER_KINDS.awaitYield, n)) { found = true; return false; }
    if (loops && kindsHas(BARRIER_KINDS.loop, n)) { found = true; return false; }
    if (n.type === 'UnaryExpression' && n.operator === 'delete') { found = true; return false; }
    if (n.type === 'OptionalCallExpression') { found = true; return false; }
    return !found;
  });
  return found;
}

function walkSameFunctionAll(node, skipFunctions, enter) {
  if (skipFunctions) {
    walkSameFunction(node, enter);
  } else {
    walk(node, enter);
  }
}

/** True when the expression subtree provably cannot execute arbitrary code. */
export function isPureExpression(node, opts = {}) {
  const { allowMemberReads = true } = opts;
  let pure = true;
  walk(node, (n) => {
    if (!pure) return false;
    switch (n.type) {
      case 'CallExpression':
      case 'NewExpression':
      case 'AwaitExpression':
      case 'YieldExpression':
      case 'AssignmentExpression':
      case 'UpdateExpression':
      case 'TaggedTemplateExpression':
      case 'OptionalCallExpression':
        pure = false;
        return false;
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        // Reading a property can hit a getter; spec sanctions member reads as
        // side-effect-free for dead-code purposes.
        if (!allowMemberReads) { pure = false; return false; }
        return true;
      case 'UnaryExpression':
        if (n.operator === 'delete') { pure = false; return false; }
        return true;
      default:
        return true;
    }
  });
  return pure;
}

/** Is this node a Literal we can reason about statically? */
export function isStaticLiteral(node) {
  return (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node)
  );
}

/** Extract a primitive value from a literal-ish node (unwraps unary minus). */
export function literalValue(node) {
  if (t.isStringLiteral(node)) return { kind: 'string', value: node.value };
  if (t.isNumericLiteral(node)) return { kind: 'number', value: node.value };
  if (t.isBooleanLiteral(node)) return { kind: 'boolean', value: node.value };
  if (t.isNullLiteral(node)) return { kind: 'null', value: null };
  if (t.isUnaryExpression(node) && (node.operator === '-' || node.operator === '+') && t.isNumericLiteral(node.argument)) {
    const v = node.operator === '-' ? -node.argument.value : node.argument.value;
    return { kind: 'number', value: v };
  }
  return null;
}

export function isNumericResultSafe(v) {
  return typeof v === 'number' && Number.isFinite(v) && !Number.isNaN(v) && !Object.is(v, -0);
}

/** Compute a binary operation over two static literal values. Returns value or undefined (unfoldable). */
export function evalBinary(op, lv, rv) {
  const a = lv.value;
  const b = rv.value;
  try {
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return a / b;
      case '%': return a % b;
      case '**': return a ** b;
      case '==': return a == b; // eslint-disable-line eqeqeq
      case '!=': return a != b; // eslint-disable-line eqeqeq
      case '===': return a === b;
      case '!==': return a !== b;
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      case '&': return a & b;
      case '|': return a | b;
      case '^': return a ^ b;
      case '<<': return a << b;
      case '>>': return a >> b;
      case '>>>': return a >>> b;
      default: return undefined;
    }
  } catch {
    return undefined;
  }
}

export function valueToLiteralNode(v) {
  if (typeof v === 'string') return t.stringLiteral(v);
  if (typeof v === 'number') return t.numericLiteral(v);
  if (typeof v === 'boolean') return t.booleanLiteral(v);
  if (v === null) return t.nullLiteral();
  return null;
}

/**
 * Provably-array analysis for `for...of` conversion.
 * Returns { array: boolean, holey: boolean } — holey=true means the array may
 * contain holes (sparse), which changes forEach/map semantics.
 */
export function provablyArray(node, path, seen = new Set()) {
  const no = { array: false, holey: true };
  if (!node) return no;
  if (t.isArrayExpression(node)) {
    const holey = node.elements.some((e) => e === null || t.isSpreadElement(e));
    return { array: !holey, holey };
  }
  if (t.isIdentifier(node)) {
    if (node.name === 'arguments' || node.name === 'eval') return no;
    const binding = path.scope.getBinding(node.name);
    if (!binding) return no;
    if (seen.has(node.name)) return no; // cycle
    seen.add(node.name);
    const sources = [];
    if (binding.path.isVariableDeclarator()) sources.push(binding.path.node.init);
    for (const viol of binding.constantViolations) {
      if (viol.isAssignmentExpression()) sources.push(viol.node.right);
      else if (viol.isUpdateExpression()) return no;
      else return no;
    }
    let any = sources.length > 0;
    let all = true;
    let holey = false;
    for (const src of sources) {
      const r = provablyArray(src, path, seen);
      if (!r.array) { all = false; break; }
      if (r.holey) holey = true;
    }
    seen.delete(node.name);
    if (any && all) return { array: true, holey };
    return no;
  }
  if (t.isCallExpression(node) && t.isMemberExpression(node.callee)) {
    const prop = node.callee.property;
    if (!t.isIdentifier(prop)) return no;
    const alwaysArray = new Set([
      'split', 'map', 'filter', 'concat', 'flat', 'flatMap', 'fill',
      'reverse', 'sort', 'from', 'of', 'keys', 'values', 'entries', 'splice',
    ]);
    const arrayReceiverOnly = new Set(['slice']);
    if (alwaysArray.has(prop.name)) {
      // These methods throw unless invoked on the right receiver, so on any
      // executing path they return a real Array.
      const holey = prop.name === 'from' && node.arguments.length > 0 && t.isArrayExpression(node.arguments[0])
        ? node.arguments[0].elements.some((e) => e === null)
        : false;
      const holey2 = prop.name === 'concat' && node.arguments.some((a) => t.isArrayExpression(a) && a.elements.some((e) => e === null));
      return { array: true, holey: holey || holey2 };
    }
    if (arrayReceiverOnly.has(prop.name)) {
      const recv = provablyArray(node.callee.object, path, seen);
      return recv.array ? { array: true, holey: recv.holey } : no;
    }
    return no;
  }
  if (t.isNewExpression(node) && t.isIdentifier(node.callee) && node.callee.name === 'Array') {
    // new Array(n) is holey; new Array(a, b) is dense.
    if (node.arguments.length === 1) return { array: true, holey: true };
    if (node.arguments.length === 0) return { array: true, holey: false };
    return { array: true, holey: false };
  }
  return no;
}

/** Is the value of this expression statically guaranteed to be a boolean? */
export function isBooleanTyped(node, depth = 0) {
  if (depth > 3) return false;
  if (t.isBooleanLiteral(node)) return true;
  if (t.isUnaryExpression(node) && node.operator === '!') return true;
  if (t.isBinaryExpression(node)) {
    return ['==', '===', '!=', '!==', '<', '>', '<=', '>=', 'in', 'instanceof'].includes(node.operator);
  }
  if (t.isLogicalExpression(node) && node.operator !== '??') {
    return isBooleanTyped(node.left, depth + 1) && isBooleanTyped(node.right, depth + 1);
  }
  if (t.isCallExpression(node) && t.isIdentifier(node.callee) && node.callee.name === 'Boolean' && node.arguments.length === 1) {
    return true;
  }
  return false;
}

/**
 * Computes member-access chains for grouping repeated host-object reads.
 * A chain is a sequence of static (non-computed) property accesses rooted at
 * an Identifier or `this`. Chains stop below any computed access or call.
 */
export class ChainAnalyzer {
  constructor() {
    // Map<binding object, numeric id> so shadowed roots never group together.
    this.bindingIds = new WeakMap();
    this.nextId = 1;
    this.syntheticRoots = new Set(); // names of hoisted consts created by passes
  }

  markSynthetic(name) {
    this.syntheticRoots.add(name);
  }

  bindingId(binding) {
    if (!binding) return 'noglob';
    let id = this.bindingIds.get(binding);
    if (id === undefined) {
      id = this.nextId++;
      this.bindingIds.set(binding, id);
    }
    return 'b' + id;
  }

  /**
   * @param memberPath a NodePath to a MemberExpression
   * @returns { root, rootId, isThis, synthetic, links, key } or null
   */
  chainOf(memberPath) {
    const links = [];
    let cur = memberPath.node;
    let root = null;
    let isThis = false;
    while (true) {
      if (!t.isMemberExpression(cur)) break;
      if (cur.computed || !t.isIdentifier(cur.property)) return null;
      links.unshift(cur.property.name);
      const obj = cur.object;
      if (t.isMemberExpression(obj)) {
        cur = obj;
        continue;
      }
      if (t.isIdentifier(obj)) root = obj;
      else if (t.isThisExpression(obj)) { isThis = true; root = null; }
      else return null;
      break;
    }
    if (!root && !isThis) return null;
    let rootId;
    if (isThis) {
      rootId = '@this';
    } else {
      const binding = memberPath.scope.getBinding(root.name);
      rootId = binding ? this.bindingId(binding) : 'global:' + root.name;
    }
    const synthetic = !isThis && this.syntheticRoots.has(root.name);
    return { root, rootId, isThis, synthetic, links, key: rootId + '#' + links.join('.') };
  }
}

/** Property names that mark a chain as host-boundary crossing. */
export const HOST_MARKERS = new Set([
  'world', 'dimension', 'location', 'getComponent', 'getEntities',
  'getAllPlayers', 'getDynamicProperty', 'setDynamicProperty', 'getEntity',
  'spawnEntity', 'runCommand', 'players', 'velocity', 'headLocation',
  'viewDirection', 'getEntitiesFromViewDirection', 'getBlockFromViewDirection',
  'target', 'dimension',
]);

/** All call-family nodes in a statement (excluding nested functions). */
export function callsIn(stmt) {
  const calls = [];
  walkSameFunction(stmt, (n) => {
    if (t.isFunctionExpression(n) || t.isArrowFunctionExpression(n)) return false;
    if (t.isCallExpression(n) || t.isNewExpression(n) || t.isTaggedTemplateExpression(n) ||
        t.isOptionalCallExpression(n)) {
      calls.push(n);
    }
    return true;
  });
  return calls;
}

const nodePos = (n) => (n.start !== undefined ? n.start : 0);
const nodeEnd = (n) => (n.end !== undefined ? n.end : 0);
const contains = (outer, inner) => nodePos(outer) <= nodePos(inner) && nodeEnd(inner) <= nodeEnd(outer);

/**
 * Corridor check: would a value captured BEFORE `stmt` executes still match
 * what each use in `sortedUses` (Node nodes, sorted by position) reads?
 * A call executes before a use when it does not contain the use and starts
 * earlier (argument/object sub-expressions evaluate before the call itself).
 * Returns false when any call runs between the capture point and a use, or
 * between two uses of the same captured value.
 */
export function corridorSafe(stmt, sortedUses) {
  const calls = callsIn(stmt);
  for (let i = 0; i < sortedUses.length; i++) {
    const cur = sortedUses[i];
    const prev = i > 0 ? sortedUses[i - 1] : null;
    for (const C of calls) {
      if (contains(C, cur)) continue; // cur evaluates before C runs
      const cStart = nodePos(C);
      if (cStart < nodePos(cur)) {
        if (prev === null) return false; // between capture point and first use
        const containsPrev = contains(C, prev);
        const afterPrev = containsPrev || cStart >= nodePos(prev);
        if (afterPrev) return false; // C runs between prev and cur
      }
    }
  }
  return true;
}
