# optipack

**A build-time optimizer for Minecraft Bedrock behavior-pack scripts.**

Bedrock runs your scripts on QuickJS: an interpreter with no JIT, no escape analysis, and an expensive crossing every time script code touches the host (`player.location` allocates a fresh Vector3 *every read*). All of it shares one tick budget. optipack rewrites your `scripts/` folder with 16 semantics-preserving transforms that cut those crossings and per-tick allocations — and proves behavior is unchanged while doing it.

```
npm install -g optipack
optipack MyPack MyPack-optimized
```

## Measured impact

Host-boundary crossings before → after (engine-independent: identical in Node and in-game), with behavior verified identical by the test harness:

| Benchmark | Level | Crossings | Top reduction |
|---|---|---|---|
| [example pack](example/) (300 ticks) | balanced | 237 → **177** (−25%) | `location` reads −50% |
| [JaylyDev/ScriptAPI](https://github.com/JaylyDev/ScriptAPI) corpus, 147 real scripts | balanced | 655 → 655 (0%)¹ | — |
| same corpus | risky | 655 → **447** (−32%) | `getComponent` −49%, `location` −50% |

¹ *Honest number: this corpus's hot paths are call-dominated (`getComponent` every tick) — caching those is exactly the opt-in risky tier. Safe transforms only ever remove reads.*

Reproduce with `optipack bench` (see [BENCHMARKING.md](BENCHMARKING.md)), which also covers the in-game `/script profiler` A/B workflow for authoritative QuickJS numbers.

## How it works

```
optipack <inputPack> <outputPack> [--level safe|balanced|risky] [--diff] [--dry-run] [--only ids] [--except ids] [--report path]
```

- Only `scripts/**/*.js` is transformed; the manifest, JSON, functions, and textures are copied byte-for-byte. `import` declarations are never touched.
- Every output file is re-parsed (valid ESM, ES2022-grade syntax — nothing is down-leveled, no bundling, no minification).
- Same input + config → byte-identical output. Exit codes: `0` ok · `1` usage · `2` parse failure (file+line) · `3` internal error.

```bash
optipack bench <packDir> --level risky   # A/B benchmark: original vs optimized (see BENCHMARKING.md)
```

## The 16 transforms

Passes run in order; each is an independent pass with an ID, a level, and strict bail conditions — when a site can't be proven safe, the pass **bails and records the reason** (line + reason in the report) instead of guessing.

<details>
<summary><strong>SAFE — provably behavior-identical (enabled at every level)</strong></summary>

| ID | Name | What it does |
|---|---|---|
| S1 | `const-fold` | Folds literal arithmetic, string concat, `typeof`/`!` on literals, fully-literal templates, logical expressions with literal left side. Never across identifiers or calls. |
| S2 | `dead-code` | Removes statements after `return`/`throw`/`break`/`continue`, constant branches, unused locals with pure initializers. |
| S3 | `bool-simplify` | `x ? true : false` → `!!x`; `if (x) return true; else return false;` → `return !!x;`; `x === true` → `x` when statically boolean. |
| S4 | `for-of-to-indexed` | `for (const v of it)` → indexed loop when `it` is *provably* an array (literal, `.map/.filter/.split`, `Object.entries`, …). Never on host returns, Map/Set, strings, generators. |
| S5 | `array-methods-to-loops` | **Hot paths only.** Inline-arrow `.forEach/.map/.filter/.some/.every/.find` → indexed loops with exact per-method return semantics. |
| S6 | `destructure-to-direct` | **Hot paths only.** `const { x, y } = obj` → `obj.x` reads at use sites (≤ 3 uses); defaults hoisted to an `if`. |
| S7 | `hoist-invariant-members` | **Hot paths only.** Hoists loop-invariant host chains out of barrier-free loops — `total += chest.location.y` reads `chest.location` once instead of N times. |

</details>

<details>
<summary><strong>BALANCED — per-site-checked assumptions (default level)</strong></summary>

| ID | Name | What it does |
|---|---|---|
| B1 | `cache-getter-chains` | Repeated identical host chains in barrier-free regions → one hoisted `const` (`p.location.x` twice = 2 crossings + 2 allocations → 0). |
| B2 | `closure-lift` | Arrows created inside hot functions (re-allocated every tick) lifted to module scope when they capture nothing / module bindings / const primitives (inlined) / never-reassigned locals via a module-level cell. |
| B3 | `string-build` | `s += x` in a hot loop → `parts.push()` + one `join("")` (QuickJS strings are immutable flat buffers: `+=` is O(n²), parts+join is O(n)). |
| B4 | `dynprop-hoist` | `entity.getDynamicProperty("k")` with a constant key, read in a hot loop, hoisted above the loop. |
| B5 | `null-chain-flatten` | After a proven guard (`if (!a) return;`), `a?.b` → `a.b` within the barrier-free region. |

</details>

<details>
<summary><strong>RISKY — opt-in (<code>--level risky</code> or config); every application warns, each has a documented failure mode</strong></summary>

| ID | Name | What it does | Failure mode |
|---|---|---|---|
| R1 | `cross-tick-cache` | Module-level WeakMap caches `getComponent("…")` and `entity.id`/`typeId` across ticks. | **Stale component views after death/dimension change.** |
| R2 | `json-fold` | `const x = JSON.parse('…')` hoisted to a module const when provably never mutated or passed to unknown code. | Shared mutable state if mutated anyway. |
| R3 | `try-catch-strip` | Removes `try { } catch { }` with no calls in the try body, in hot functions. | A pathological engine-level throw now crashes the script instead of being swallowed. |
| R4 | `getter-cache-cross-barrier` | B1, allowed to cross call barriers within one synchronous callback. | Cached values stale if an intervening call teleports/damages the entity. |

</details>

## Pragmas

```js
// optipack: off                      ← first comment in the file: skip the whole file
// optipack-disable const-fold        ← line before a statement/function: skip that node (or `all`, or comma lists)
// optipack-hot                       ← line before a function: force-mark it hot
```

## Config

`optipack.config.json` (CLI flags win):

```json
{
  "level": "balanced",
  "transforms": { "json-fold": true },
  "hotPath": { "transitiveDepth": 1 },
  "lint": true
}
```

`transforms` can force any pass on/off regardless of level — that's how you run RISKY passes without `--level risky`.

## What the report tells you

Each build writes `optipack-report.json`: transforms applied per file, every bail (line + reason — the tool never silently skips), lint findings (e.g. `getAllPlayers()` in tick handlers, residual allocations), and byte sizes.

## Correctness: effects, not vibes

The test suite (68 tests) proves **effects-equivalence**: scripts run against a mock `@minecraft/server` with an effect recorder that logs every *mutating* call and registration in order — reads return scripted sequences and are free to be eliminated. Original and optimized must produce **identical effect traces** across simulated ticks and events, for every fixture and for the example pack. Mocks exist for all ten `@minecraft/*` runtime modules (functional for `server`/`server-ui`, generated from real type definitions for the rest).

```bash
npm test                # 68 tests
npm run fetch-corpus    # pull the real-world benchmark corpus (JaylyDev/ScriptAPI, MIT)
npm run update-snapshot # regenerate the example report snapshot
```

## Limitations

- Same-file analysis only; cross-file helpers aren't auto-hot (annotate with `// optipack-hot`).
- No bundling/minification — pair with esbuild etc. if you use npm libraries like `@minecraft/math`.
- S5 assumes dense arrays (sparse-array provenance bails); S7's before-loop hoist evaluates once per loop entry (safe for live host objects, documented edge for null roots + zero-iteration loops).

## Development

```
npm install
npm test
npm run update-snapshot     # example report snapshot
npm run update-mock-stubs   # regenerate @minecraft/* stubs from real type defs
npm run fetch-corpus        # real-world benchmark corpus
```

MIT — see [LICENSE](LICENSE). Benchmark corpus scripts belong to their original authors (see `test/corpus/SOURCES.json`).
