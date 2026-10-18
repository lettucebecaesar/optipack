# Benchmarking optipack

Two complementary ways to measure what optipack actually buys you.

## 1. Automated A/B (`optipack bench`) — engine-independent crossing counts

```bash
optipack bench <packDir> [--ticks N] [--scenario file.json] [--level safe|balanced|risky] [--json out.json]
```

Builds the optimized pack, then runs the **original** and **optimized** scripts
side by side under the harness mock for N simulated ticks with identical
scenario input, and reports:

- **Host-boundary crossings by kind** — the number of `player.location` reads,
  `getComponent()` calls, `getDynamicProperty()` calls, `getEntities()` sweeps,
  etc. This is the metric optipack exists to reduce, and it is
  **engine-independent**: a crossing is a crossing in V8 (the test harness) or
  QuickJS (the game).
- **Wall time per tick** — *indicative only*. The harness runs in Node (V8, with
  a JIT); Minecraft runs QuickJS (interpreter, no JIT). Use the in-game
  workflow below for authoritative numbers.
- **Effect-trace equality** — if the two builds diverge behaviorally, the bench
  is flagged invalid (`exit code 1`).

Example (real output over 147 community scripts from JaylyDev/ScriptAPI):

```
optipack bench — test/corpus/jayly-pack (entry scripts/main.js, 100 ticks, level risky)
  boundary crossing      original  optimized  delta
  boundary.getBlock            29         29  0%
  boundary.getComponent       400        202  -49%
  boundary.getPlayers         206        206  0%
  boundary.location            20         10  -50%
  TOTAL                       655        447  -32%
  transforms applied: 97
  wall (indicative, Node/V8): original 6.5ms (65µs/tick), optimized 6.4ms (64µs/tick)
```

Read it as: at `--level risky`, R1's cross-tick component cache halves
`getComponent` crossings and S7/B1 halve location reads, with identical
behavior verified. At `balanced`, crossings stay flat on this corpus because
its hot paths are call-dominated (caching those is exactly what R1 opts into).

Scenario files drive events between ticks (`test/corpus/jayly-scenario.json`
is an example): `{"reads": {...}, "state": {players: [{id: "p1"}]}, "steps":
[{"op": "fire", "event": "world.afterEvents.worldLoad", "payload": {}},
{"op": "fireMany", "event": "world.afterEvents.playerBreakBlock", "count": 30,
"payload": {...}}, {"op": "tick", "n": 0}]}`. Payloads may reference mock
objects with `{"__entity": "p1"}`, `{"__dimension": "minecraft:overworld"}`,
or `{"__block": {"location": {...}, "dimension": "..."}}`.

A real-world corpus of MIT-licensed community scripts is fetched with:

```bash
npm run fetch-corpus
node bin/optipack.js bench test/corpus/jayly-pack --scenario test/corpus/jayly-scenario.json
```

## 2. In-game A/B with the script profiler — authoritative numbers

The numbers that matter run on the real engine: **QuickJS inside Minecraft**,
where the script watchdog and the server tick budget live. Bedrock ships a
built-in script profiler.

1. **Build both packs.** The original is just a copy (optipack always
   optimizes):

   ```powershell
   # Windows
   robocopy MyPack MyPack-original /E
   optipack MyPack MyPack-optimized --level balanced
   ```

   ```bash
   # Linux/macOS
   cp -r MyPack MyPack-original
   optipack MyPack MyPack-optimized --level balanced
   ```

2. **Install one pack** into your `development_behavior_packs` folder and apply
   it to a test world (enable the required experiments if the pack needs them).

3. **Profile a consistent play pattern.** In the world, run:

   ```
   /script profiler start
   ```

   exercise the same actions for a fixed period (e.g. 60 seconds of the same
   movement/interactions, or a repeatable redstone/tick-driven scenario), then:

   ```
   /script profiler stop
   ```

   The profiler writes the execution profile to the content log (visible in
   the in-game content log screen and in the world's log files under
   `content_log/`).

4. **Repeat with the other pack**, same actions, same duration.

5. **Compare.** What to look for in the two profiles:
   - total script time per tick / per frame;
   - time in your hottest handlers (the profiler reports per-function costs);
   - the count of host API calls attributed to your entry points.

   optipack's transforms reduce *calls into the host* (location reads,
   component queries, dynamic properties) and *allocations per tick*
   (closures, form objects, intermediate strings) — those show up as smaller
   per-function times and fewer API-call entries, without any behavioral
   difference (which the harness already proved).

6. **Send the logs back.** If you're reporting results, include both content
   log profile sections (original + optimized), the optipack report JSON from
   the optimized build, and the level you used. The structured
   `optipack bench --json` output pairs well with this.

### Notes and caveats

- Enable the script watchdog thresholds or keep profiling sessions short —
  a pathological pack can trip the watchdog during profiling; that itself is
  useful signal.
- Profile at least two sessions per variant and compare like with like (same
  world, same player count, same actions). Entity counts dominate host costs.
- `optipack bench` crossing counts are the cheapest regression signal for
  CI; the in-game profiler is the ground truth for player-visible wins.
