/**
 * Permissive stub factory for @minecraft/* runtime modules that optipack's
 * differential harness does not model in depth.
 *
 * Every exported name from a module's real index.d.ts is bound to a permissive
 * value: callable, constructable, and property-accessible indefinitely. Calls
 * and constructions are recorded as harness effects (identically on the
 * original and optimized sides), so differential equivalence still holds while
 * scripts exercise these modules. Property GETS are silent — only calls and
 * `new` produce effects — so chained accessors do not spam the trace.
 *
 * Not a behavioral model: it exists so fixtures importing these modules link
 * and run. Behavior differences between stub and engine are identical on both
 * sides of a differential comparison, which is the only claim it supports.
 */
const rec = () => globalThis.__opkRecorder;

function record(call, args) {
  const r = rec();
  if (r) r.effect(call, args);
}

function shallow(v, depth = 0) {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') return v;
  if (depth > 2) return String(t);
  if (Array.isArray(v)) return v.map((x) => shallow(x, depth + 1));
  if (t === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = shallow(v[k], depth + 1);
    return out;
  }
  return String(t);
}

const NON_VALUE_SYMBOLS = new Set([
  'then', 'catch', 'finally', 'toJSON', 'inspect', 'constructor',
  Symbol.toPrimitive, Symbol.toStringTag, Symbol.iterator,
  'nodejs.util.inspect.custom', 'asymmetricMatcher',
]);

export function permissive(label) {
  const fn = function (...args) {
    record('stub.call', { target: label, args: shallow(args) });
    return permissive(label + '()');
  };
  Object.defineProperty(fn, 'name', { value: label, configurable: true });
  return new Proxy(fn, {
    get(target, prop) {
      if (typeof prop === 'symbol' || NON_VALUE_SYMBOLS.has(prop)) return undefined;
      return permissive(label + '.' + String(prop));
    },
    construct(target, args) {
      record('stub.new', { target: label, args: shallow(args) });
      return permissive('new ' + label);
    },
    apply(target, thisArg, args) {
      record('stub.call', { target: label, args: shallow(args) });
      return permissive(label + '()');
    },
    has() {
      return true;
    },
  });
}
