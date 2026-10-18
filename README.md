# optipack

A QuickJS-targeted **micro-optimizing pre-processor** for Minecraft Bedrock Edition behavior-pack scripts.

optipack takes an entire behavior pack as input, statically analyzes the JavaScript under `scripts/`, rewrites it with semantics-preserving micro-optimizations tuned for the QuickJS engine that executes MCBE's Script API, and emits an optimized copy of the pack plus a machine-readable report.

**Why:** MCBE scripts run on QuickJS — an interpreter with no JIT, minimal inline caching, a reference-counted GC with no escape analysis, and an expensive JS↔native boundary for every host-object property read (`player.location` allocates a fresh Vector3 *every read*). All script work shares the server's tick budget. Pack code written for readability re-reads the same host getters every tick, allocates closures and arrays per tick, and builds strings with `+=`. optipack mechanically removes a large class of that overhead at build time.

```
npm install -g .          # or: node bin/optipack.js
npx optipack <inputPack> <outputPack> [options]
```

- Requires Node ≥ 18.
- Runtime deps: `@babel/parser`, `@babel/traverse`, `@babel/generator`, `@babel/types`, `commander`.
- Only `scripts/**/*.js|/mjs` is transformed; everything else (manifest.json, JSON, functions, texts, textures) is copied byte-for-byte. `manifest.json` is never modified. `node_modules/` and `.git/` are skipped.

## CLI

```
optipack <inputPackDir> <outputPackDir> [options]

  --level <safe|balanced|risky>   optimization level (default: balanced)
  --config <path>                 config file (default: ./optipack.config.json when present)
  --only <id,id,...>              run only these transforms
  --except <id,id,...>            skip these transforms
  --dry-run                       analyze + report, write nothing
                                  (prints the report to stdout; with an explicit
                                   --report it writes only that file)
  --diff                          print unified diffs per changed file
  --report <path>                 report file (default: <outputPackDir>/optipack-report.json)
```

Exit codes: `0` success · `1` usage/config error · `2` parse failure (file + line printed to stderr) · `3` internal error.

Every output file is re-parsed with `@babel/parser` (ESM) before being written; a round-trip failure aborts the build with exit code 3.

## Config file

`optipack.config.json` (CLI flags override it):

```json
{
  "level": "balanced",
  "transforms": {
    "for-of-to-indexed": true,
    "json-fold": false
  },
  "hotPath": { "transitiveDepth": 1 },
  "lint": true
}
```

- `level` — one of `safe | balanced | risky`. Running level N enables all passes at level ≤ N.
- `transforms` — per-pass overrides. `false` always disables a pass; `true` enables a pass even below its level (this is the only way to run a RISKY pass without `--level risky`).
- `hotPath.transitiveDepth` — how many levels of same-file callees of hot functions are treated as hot (default 1).
- `lint` — run the lint/report pass (default true).

Unknown keys, unknown transform ids in `--only/--except`, and type errors are usage errors (exit 1).

## Pragmas

Exact syntax, implemented for real:

| Pragma | Placement | Effect |
| --- | --- | --- |
| `// optipack: off` | first comment in the file | disables all transforms for that file (the file is emitted unchanged) |
| `// optipack-disable <transformId\|all>` | on the line before a statement or function | disables that transform (or all) for the immediately following node and everything inside it; comma-separated lists work (`// optipack-disable const-fold,dead-code`) |
| `// optipack-hot` | on the line before a function | force-marks that function hot (as if registered on a tick) |

Disabled nodes keep their pragmas in the output, so re-running optipack on its own output is stable.

## Hot-path analysis (shared prerequisite)

A function-like node is **hot** when any of these hold:

- it is passed directly to `system.runInterval`, `system.runTimeout`, `system.run`, or `system.runJob`;
- it is passed to any `.subscribe(...)` call (world/system before+after events, entity and item events);
- it carries an `// optipack-hot` pragma;
- it is a same-file function called **only** from hot functions, up to `hotPath.transitiveDepth` (default 1). Same-file call graph only (see Limitations).

Barrier rules every downstream pass respects:

- every `yield` is a barrier (e.g. `system.runJob` iterators) — nothing cached before a `yield` is reused after it;
- every `await` is a barrier, same reason;
- every call expression or assignment is a mutation barrier for host-object caching — SAFE/BALANCED passes stop at barriers; RISKY passes may cross them and say so.

Implementation note: a statement containing calls is not a blanket barrier for reads *inside that statement*. Argument/object sub-expressions evaluate before the call itself, so `f(p.location.x, p.location.x)` may share one cache even though `f` is a call. The passes implement this precisely (an evaluation-order "corridor" check) and bail whenever a call can execute between two reads.

## Transform catalog

Passes run in registry order (S1 → R4). Every application increments a counter in the report; every skipped opportunity is recorded with line + reason.

### SAFE — provably behavior-identical

| ID | Name | What it does | Bails when |
| --- | --- | --- | --- |
| S1 | `const-fold` | Folds literal arithmetic/comparisons/bitwise ops, string concatenation, `typeof` on literals, `!`/`~` on literals, fully-literal template literals, and logical expressions with a literal left operand. Exit-phase traversal so nested folds cascade. | Either operand is not a static literal; result would be `-0`, `NaN`, or non-finite; `in`/`instanceof`; identifiers or calls anywhere (`i + 1`, `Math.floor(1.5)` are never folded). |
| S2 | `dead-code` | Removes statements after an unconditional `return`/`throw`/`break`/`continue`, branches made constant by S1 (`if`, `?:`, `while (false)`, `for (;false;)`), and unused local declarations with side-effect-free initializers (no calls, no member writes, no `await`). | Initializer has calls/assignments/await; binding is exported; function carries an `// optipack-hot` pragma (explicit user intent). |
| S3 | `bool-simplify` | `x ? true : false` → `!!x`; `if (x) return true; else return false;` → `return !!x;`; `x === true` / `x !== false` → `x` (plus duals `x === false` / `x !== true` → `!x`). | Operand not statically boolean-typed (comparison, `!`, `Boolean(...)` call, or and/or of those). |
| S4 | `for-of-to-indexed` | `for (const v of it)` → indexed loop with a per-iteration `const v = it[i]` binding and a live `.length` check (mid-loop pushes extend the loop exactly like the array iterator). Array-pattern bindings (incl. holes and defaults) are translated elementwise. | Iterable not provably an array: host returns (`getAllPlayers()`, `getEntities()`), Map/Set, strings, generators, parameters with unknown provenance. Also bails on `for await`, destructuring with rest, and a scope binding named `Symbol`. |
| S5 | `array-methods-to-loops` | **Hot functions only.** Inline-arrow `.forEach`, `.map`, `.filter`, `.some`, `.every`, `.find` → plain indexed loops with exact per-method return semantics (map pushes at fall-off-end, some/every/find early-exit with `break`). The receiver is always evaluated exactly once (hoisted to a `const`), so call-containing receivers never duplicate side effects — this supersedes the naive "receiver referenced twice" bail. | Callback not an inline arrow/function expression; uses `this`/`arguments`; async/generator or contains await/yield; non-identifier params; receiver optionally chained; call conditionally evaluated within its statement (`?:`, logical right, spread, concise arrow body, loop test/update); receiver provenance may be a sparse array (`new Array(n)`, holey literals). |
| S6 | `destructure-to-direct` | **Hot functions only.** `const { x, y } = obj` → direct `obj.x` reads at use sites, when `obj` is a simple never-reassigned identifier and total uses ≤ 3. Defaults are hoisted to an `if` at the declaration site (`let z = obj.z; if (z === undefined) z = 42;`) so they never re-evaluate per use. | Nested patterns, rest elements, computed keys, `obj` a member chain (that is B1's job), `obj` reassigned or property-written, > 3 total uses, or any call/assignment between declaration and uses that could mutate `obj` (evaluation-order corridor check inside the use's own statement). |
| S7 | `hoist-invariant-members` | **Hot functions only.** Hoists loop-invariant member chains out of for/while/do loops: body-top hoists for chains used ≥ 2× per iteration, and — when the whole loop subtree is barrier-free (no calls, await/yield, property writes, delete) and the root is never reassigned — a **before-loop** hoist even for single-use chains (`total += chest.location.y` reads `chest.location` once instead of N times). | Body contains calls/await/yield/property writes; chain has computed members; root reassigned or declared inside the loop; root is a local whose declaration follows the first use. Assumption documented below: the before-loop hoist evaluates the chain once even if the body never runs (safe for live host objects; a null root + zero-iteration loop would newly throw). |

### BALANCED — per-site-checked assumptions

| ID | Name | What it does | Bails when |
| --- | --- | --- | --- |
| B1 | `cache-getter-chains` | Within a hot function's barrier-free regions, repeated identical member chains rooted at a host object (root is a parameter, `this`, a previously hoisted const, or the chain contains `world.*`, `getComponent(`, `getEntities(`, `getAllPlayers()`, `dimension`, `location`, …) are replaced by one hoisted `const`. Removes both repeated boundary crossings and repeated allocations (`p.location.x` twice = 2 allocations + 2 crossings → 0). Chains used inside one call-containing statement share a cache when no call can execute between them (corridor rule). | Chain overlaps a property write; root reassigned in scope; no recognizable host root; uses split by call/assignment barriers (recorded as a bail, not silently skipped). |
| B2 | `closure-lift` | Arrow/function expressions created lexically inside hot functions (re-allocated every tick) are lifted to module scope when they capture nothing, only module-level identifiers/globals, or only `const`-bound primitives with literal initializable values (inlined as module consts). **Cell capture**: an arrow capturing a never-reassigned per-invocation local is also lifted through a module-level cell (`let __opCellN;`) assigned at the arrow's creation point — sound when every reference of the arrow is a direct synchronous call in the enclosing function, the arrow is not created inside a loop, the enclosing function is sync (no await/yield), and the captured local's declaration precedes the creation statement. Lifted functions keep their hotness. | References `this`, `arguments`, `super`, or `new.target`; captures a reassigned local; captures a live local but the arrow escapes (registered/stored/returned — each registration would need its own capture and a shared cell could be observed stale); captures a live local and is created inside a loop; captures a live local inside an async/generator function; captured local declared at or after the creation statement (TDZ hazard). |
| B3 | `string-build` | `s += x` accumulated in a loop inside a hot function → `parts.push("" + x)` + one `s = parts.join("")` after the loop. QuickJS strings are immutable flat buffers, so `+=` over long loops is O(n²); parts+join is O(n). `"" + x` preserves exact ToString semantics (null → `"null"`, symbol throws) at the same evaluation point. | `s` not a `let` initialized to `""`; any read of `s` inside the loop; writes split across loops or inside nested closures; prepend form (`s = x + s`); the append is not a standalone statement. |
| B4 | `dynprop-hoist` | `X.getDynamicProperty("k")` with a constant key, read in a loop in a hot function, hoisted above the loop. Never cached across tick invocations at this level — that is R1 territory. | Loop contains any other calls, await/yield, or property writes; receiver reassigned inside the loop; the read is inside a conditional within the body. |
| B5 | `null-chain-flatten` | After S1/S2 prove a guard (`if (!a) return;`, `if (a == null) throw …`), `a?.b` → `a.b` for the guarded identifier, within the barrier-aware window after the guard. Only the FIRST optional hop is flattened (`a?.b?.c` keeps its second `?.` — `a.b` itself may still be nullish). | Guarded identifier reassigned anywhere in the function; use inside a conditional; a call in the guard window that could execute before the use (corridor check). |

### RISKY — opt-in (`--level risky` or explicit config); every application emits a warning

| ID | Name | What it does | Failure mode |
| --- | --- | --- | --- |
| R1 | `cross-tick-cache` | Module-level `WeakMap` caches keyed by entity/player for `getComponent("…")` results and for `entity.id` / `entity.typeId`, reused across ticks with no invalidation. Injects two small helper functions and rewrites reads inside hot functions. | **Stale component views after death / dimension change.** The component view may also become invalid if the entity is removed. Even the "immutable" `id`/`typeId` subset is reported as risky. Equivalence holds exactly when the cached value is stable for the entity's lifetime (see the differential harness notes below). |
| R2 | `json-fold` | `const x = JSON.parse('{"a":1}')` on a constant string hoisted to a module-level `const` shared by every use. The literal must parse at build time; the proof obligation is that every use is a pure read — property reads of *primitive* JSON values may flow anywhere (a copy), but the parsed object itself never escapes to calls, returns, throws, spreads, iterations, or aliases. | **Shared mutable state** if any code mutates the parsed object (now shared across all uses). The tool proves non-mutation per site; it bails (e.g. property writes, method calls, aliasing) and records the reason. |
| R3 | `try-catch-strip` | Removes `try { … } catch {}` in hot functions when the try body contains no calls (and the catch body is empty). With no calls, the only throws left are pathological engine-level ones. | **A pathological engine-level throw now crashes the pack script** instead of being swallowed (e.g. a null-deref on a host proxy). Bails when the catch body is non-empty, a `finally` is present, or the try body contains calls/await/yield. |
| R4 | `getter-cache-cross-barrier` | B1, but allowed to cross call and assignment barriers within one synchronous callback invocation (`await`/`yield` remain barriers). | **Stale cached values if an intervening call moves or modifies the entity** — teleport-then-read-cached-`location` returns the pre-teleport object. Every hoisted chain warns. |

## Lint & report (no rewriting)

Reported anti-patterns, per file with line numbers:

- `per-tick-getAllPlayers` — `world.getAllPlayers()` / `dimension.getEntities()` / `dimension.players` unconditionally inside per-tick callbacks (suggests event-driven redesign).
- `dynprop-in-loop` — `getDynamicProperty` calls inside tick loops beyond what B4 hoisted.
- `residual-allocs` — counts of closures / arrays / object literals remaining inside hot callbacks after all transforms (the GC-pressure metric, in `residualAllocs`).
- `subscribe-in-interval` — `subscribe()` called inside `runInterval` handlers.
- `json-in-hot` — `JSON.parse` / `JSON.stringify` / `structuredClone` in hot functions.
- `try-catch-wraps-tick` — try/catch wrapping an entire tick-handler body.

Report schema:

```json
{
  "level": "balanced",
  "files": [
    {
      "path": "scripts/main.js",
      "hotFunctions": 4,
      "transforms": { "for-of-to-indexed": 1, "cache-getter-chains": 1 },
      "bails": [{ "line": 18, "transform": "S4", "reason": "iterable not provably an array" }],
      "lint": [{ "line": 16, "rule": "per-tick-getAllPlayers", "message": "…" }],
      "residualAllocs": { "closures": 0, "arrays": 2, "objects": 0 },
      "bytes": { "before": 1977, "after": 2263 }
    }
  ],
  "warnings": [
    { "path": "scripts/main.js", "line": 6, "transform": "R2", "message": "…" }
  ],
  "totals": { "transforms": 6, "bails": 6, "warnings": 0 }
}
```

Bail records use the pass code (`S1`…`R4`); transform counters use the pass id (`const-fold`…). Warnings carry file, line, transform, and message; `totals.warnings` counts them.

## Effects-equivalence (how correctness is tested)

Transforms may legitimately eliminate **reads** — that is the point — so the test harness compares **effects, not API-call traces**.

The differential harness (`test/harness/`) injects a mock `@minecraft/server` module via Node loader hooks. The mock implements `world`, `system`, entities, components, and events with deterministic behavior and an **effect recorder**:

- Every mutating call — `sendMessage`, `setDynamicProperty`, `runCommand`, `spawnEntity`, `applyDamage`, component writes, `teleport`, `kill`, and every `runInterval`/`runTimeout`/`run`/`runJob`/`subscribe` registration — is recorded as an ordered effect.
- Reads return scripted sequences and are **not** recorded. Scripted read values index by tick: repeated reads within one synchronous tick return the same value (the engine is synchronous), and values may change between ticks.
- Scenario steps (`tick N`, `fire event`) run identically against the original and the optimized entry, including the whole relative-import graph (each variant loads its own transformed files).
- Equivalence: the recorded effect sequences must match exactly, in order. A divergence fails the build.

This catches real bugs: during development the harness caught a missing filter accumulator declaration and a broken map fall-through translation before any fixture comparison did.

The example pack (`example/`) is run through the CLI by the suite: parse validity, manifest fidelity, effects-equivalence over a scripted worldLoad/tick/playerSpawn scenario, a stable report snapshot, and byte-identical determinism across runs.

For R1 specifically, the harness documents the precise guarantee: with a *stable* component value, effects match exactly. When a component's value changes across ticks, R1's stale-cache failure mode becomes observable — that is the documented risk you accept by opting in.

## Not implemented (explicitly)

- **B2 parameter threading for escaping arrows.** The spec allows threading per-invocation locals as parameters "when the sole call site is the registration call (`system.runInterval(() => fn(player))` shape)". As literally written this is not expressible: `runInterval`/`subscribe`/`runJob` invoke callbacks with no arguments, so a lifted `(player) => fn(player)` would receive `undefined` every tick. The sound equivalent — **cell capture** — is implemented for arrows whose every use is a synchronous call in the enclosing function (see the B2 row). Arrows that *escape* (are registered) while capturing live locals still bail: each registration needs its own capture, a single module-level cell cannot represent that, and the enclosing function's invocation count is statically unprovable. Note that escaping arrows are also a one-time cost (allocated at registration, not per tick), so there is no per-tick win being left on the table.
- **Cross-file hot-path analysis.** A helper in `util.js` called only from a hot handler in `main.js` is not hot *in its own file* (same-file call graph only, per v1 scope). Annotate such helpers with `// optipack-hot`.
- **Bundling, minification, down-leveling.** Out of scope. Output is valid ESM at the input's syntax level (ES2022-grade); `import` declarations are never rewritten, reordered, or removed, and exported names are never renamed.
- **`slice()` on unknown receivers** is treated as array-returning only when the receiver itself is provably an array (string receivers return strings — S4 refuses them).

## Platform notes & conflicts

Platform reference: <https://wiki.bedrock.dev/scripting/introduction-to-scripting/>.

- Scripts execute as ESM declared by the manifest's script module (`"entry": "scripts/main.js"`). optipack never touches the manifest.
- Most world APIs only work after `world.afterEvents.worldLoad` (Script API 2.0.0 semantics) — the example pack subscribes to it first.
- Where the spec and current platform documentation could conflict, optipack prefers the safe direction (bail) and records the reason. Two conservative deviations worth noting: S4 never treats host returns (`getAllPlayers()` etc.) as provable arrays even though the API types say `Entity[]` — an API change or polyfill would otherwise break the conversion silently; and B1 refuses to cache any chain that overlaps a property write, even in R4 mode.

## Limitations

- Same-file analysis only (no cross-file call graph, no type checking).
- The tool assumes dense arrays for S5's method inlining (true for all Script API arrays and typical JS; a pathological sparse array would change forEach/map/some/every/find/filter semantics — receivers with statically holey provenance bail instead).
- The S7 before-loop hoist evaluates the chain once per loop entry even if the body runs zero times; for live host objects these reads are side-effect-free, but a null root combined with a zero-iteration loop would newly throw.
- Comments are preserved (license headers survive), but formatting is normalized by the generator; byte-identical output is guaranteed only for identical input + config.
- TS/JSX are not parsed; `.ts` files under `scripts/` are copied verbatim.

## Development

```
npm install
npm test                    # 65 tests: fixtures, bails, differentials, CLI, example
npm run update-snapshot     # regenerate test/example-report-snapshot.json
node test/gen-expected.mjs  # regenerate expected.js for test fixtures (after an
                            # intentional pass-output change — review the diff!)
```

The test harness injects the `@minecraft/server` mock through Node's `module.register()` loader hooks, which need **Node ≥ 18.19** (the runtime tool itself is fine on any Node ≥ 18).

Fixture layout: `test/<transformId>/input.js` + `expected.js` (exact pipeline output) + `config.json` (optional level) + `expects.json` (report assertions: transform counts, recorded bails, warnings, hot-function count) + `scenario.json` (optional differential scenario run against the mock).

Layout:

```
bin/optipack.js            executable
src/cli.js                 argument parsing, exit codes, --diff
src/config.js              config loading, validation, CLI overrides
src/pack-walker.js         pack traversal, verbatim copy rules
src/pragma.js              optipack: off / disable / hot
src/hotpath.js             hot classification + transitive propagation
src/pass-utils.js          barriers, purity, provably-array, corridor check
src/passes/index.js        ordered registry
src/passes/s1…r4-*.js      one file per pass
src/report.js src/lint.js  report accumulation, lint rules
src/pipeline.js            parse → analyze → passes → verify → generate
src/diff.js                dependency-free unified diff
test/                      fixtures per transform + differential harness + mock
example/                   sample behavior pack
```
