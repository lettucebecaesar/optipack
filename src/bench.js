/**
 * `optipack bench` — A/B benchmark of a pack's original vs optimized scripts
 * under the harness mock.
 *
 * Measures, for identical simulated scenarios:
 *  - host-boundary crossings by kind (the metric optipack exists to reduce:
 *    location reads, getComponent, getDynamicProperty, getEntities, ...).
 *    Engine-independent: a crossing is a crossing in V8 or QuickJS.
 *  - wall-clock time (INDICATIVE ONLY: Node is V8 with a JIT, Minecraft is
 *    QuickJS without one — use the in-game `/script profiler` workflow in
 *    BENCHMARKING.md for authoritative numbers).
 *  - effect-trace equality (a bench between non-equivalent builds is invalid
 *    and is flagged).
 *
 * Determinism: a virtual clock replaces Date during variant execution and
 * advances a fixed 50ms per tick, so time-gated script logic sees identical
 * clocks on both sides regardless of how fast each variant actually runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

import { makeRecorder, runVariant, assertSameEffects, pathToUrl, ensureHooks } from './harness/driver.js';
import { runPack } from './pipeline.js';
import { normalizeConfig } from './config.js';

const TICK_MS = 50; // 20 TPS

function installVirtualClock() {
  const RealDate = Date;
  let now = RealDate.now();
  class VirtualDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() {
      return now;
    }
  }
  globalThis.Date = VirtualDate;
  return {
    advance(ms) { now += ms; },
    restore() { globalThis.Date = RealDate; },
  };
}

/**
 * Run one variant end to end and collect measurements.
 */
async function measureVariant(entryAbsPath, variant, scenario, ticks) {
  const clock = installVirtualClock();
  const rec = makeRecorder({ reads: scenario.reads, state: scenario.state });
  globalThis.__opkRecorder = rec;
  const t = { importMs: 0, ticksMs: 0 };
  try {
    const importStart = performance.now();
    await import(`${pathToUrl(entryAbsPath)}?opkv=${variant}&t=${Date.now()}-${Math.floor(performance.now() * 1000)}`);
    t.importMs = performance.now() - importStart;

    const steps = scenario.steps || [];
    const tickStart = performance.now();
    for (const step of steps) {
      if (step.op === 'tick') {
        for (let i = 0; i < step.n; i++) {
          rec.tick(1);
          clock.advance(TICK_MS);
        }
      } else if (step.op === 'fire') {
        rec.fire(step.event, step.payload);
      } else if (step.op === 'fireMany') {
        for (let i = 0; i < (step.count || 1); i++) rec.fire(step.event, step.payload);
      } else if (step.op === 'call') {
        step.fn(rec);
      }
    }
    if (ticks > 0) {
      for (let i = 0; i < ticks; i++) {
        rec.tick(1);
        clock.advance(TICK_MS);
      }
    }
    t.ticksMs = performance.now() - tickStart;
  } finally {
    globalThis.__opkRecorder = null;
    clock.restore();
  }
  return {
    counters: rec.counters,
    effects: rec.effects,
    wall: t,
    totalTicks: rec.tickCounter,
  };
}

function compareCounters(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.map((k) => {
    const av = a[k] || 0;
    const bv = b[k] || 0;
    const delta = bv - av;
    const pct = av === 0 ? (bv === 0 ? 0 : 100) : Math.round((delta / av) * 100);
    return { kind: k, original: av, optimized: bv, delta, pct };
  });
}

/**
 * Full bench: build the optimized pack, measure both variants, report.
 */
export async function benchPack(inputDirRaw, options = {}) {
  const inputDir = path.resolve(inputDirRaw);
  const {
    ticks = 200,
    entry = null,
    scenario: scenarioPath = null,
    quiet = false,
  } = options;

  const configRaw = { ...(options.config || {}) };
  if (options.level) configRaw.level = options.level;
  const config = normalizeConfig(configRaw);
  ensureHooks();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optipack-bench-'));
  const report = runPack(inputDir, outputDir, config);

  // Locate the entry: explicit, manifest, or first script with subscribers.
  let entryRel = entry;
  if (!entryRel) {
    const manifestPath = path.join(inputDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
        const scriptModule = (manifest.modules || []).find((m) => m.type === 'script');
        if (scriptModule && scriptModule.entry) entryRel = scriptModule.entry;
      } catch { /* fall through */ }
    }
  }
  if (!entryRel) {
    const scripts = report.files.map((f) => f.path);
    entryRel = scripts[0];
  }
  if (!entryRel) throw new Error('bench: pack has no script files');
  if (!report.files.some((f) => f.path === entryRel)) {
    throw new Error(`bench: entry "${entryRel}" is not among the pack's script files`);
  }

  const scenario = scenarioPath
    ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8').replace(/^\uFEFF/, ''))
    : { reads: {}, state: {}, steps: [] };

  const entryOriginal = path.join(inputDir, entryRel);
  const entryOptimized = path.join(outputDir, entryRel);

  // 3 alternating rounds per variant; report the median tick-phase time. A
  // single round is dominated by V8 JIT warm-up noise (Node is only indicative
  // anyway — see BENCHMARKING.md for the in-game workflow).
  const rounds = 3;
  const run = (v) => measureVariant(v === 'orig' ? entryOriginal : entryOptimized, v, scenario, ticks);
  const aRuns = [];
  const bRuns = [];
  for (let i = 0; i < rounds; i++) {
    aRuns.push(await run('orig'));
    bRuns.push(await run('opt'));
  }
  const a = aRuns[0];
  const b = bRuns[0];
  a.wall.ticksMs = median(aRuns.map((r) => r.wall.ticksMs));
  b.wall.ticksMs = median(bRuns.map((r) => r.wall.ticksMs));

  let identical = true;
  try {
    assertSameEffects(a, b, 'bench');
  } catch (e) {
    identical = false;
    if (!quiet) console.error(`optipack bench: WARNING — effect traces diverge, benchmark is not meaningful:\n${e.message}`);
  }

  const counters = compareCounters(a.counters, b.counters);
  const totalCrossings = (v) => Object.values(v).reduce((x, y) => x + y, 0);
  const result = {
    pack: inputDir,
    entry: entryRel,
    ticks: a.totalTicks,
    level: config.level,
    effectsIdentical: identical,
    boundary: counters,
    boundaryTotals: { original: totalCrossings(a.counters), optimized: totalCrossings(b.counters) },
    wall: {
      original: a.wall,
      optimized: b.wall,
      note: 'Node/V8 numbers are indicative only; Minecraft runs QuickJS (no JIT).',
    },
    transforms: report.totals.transforms,
  };

  if (!quiet) printBench(result);
  return result;
}

function fmtPct(pct) {
  const s = pct > 0 ? `+${pct}%` : `${pct}%`;
  return s;
}

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function printBench(result) {
  const rows = result.boundary;
  const width = Math.max(10, ...rows.map((r) => r.kind.length));
  console.log(`optipack bench — ${result.pack} (entry ${result.entry}, ${result.ticks} ticks, level ${result.level})`);
  if (!result.effectsIdentical) {
    console.log('  !! effect traces DIVERGE — the two builds are not behavior-equivalent; treat numbers with suspicion');
  }
  console.log(`  ${'boundary crossing'.padEnd(width)}  original  optimized  delta`);
  for (const r of rows) {
    console.log(`  ${r.kind.padEnd(width)}  ${String(r.original).padStart(8)}  ${String(r.optimized).padStart(9)}  ${fmtPct(r.pct)}`);
  }
  const tot = result.boundaryTotals;
  const totalPct = tot.original === 0 ? 0 : Math.round(((tot.optimized - tot.original) / tot.original) * 100);
  console.log(`  ${'TOTAL'.padEnd(width)}  ${String(tot.original).padStart(8)}  ${String(tot.optimized).padStart(9)}  ${fmtPct(totalPct)}`);
  const w = result.wall;
  const usPerTick = (v) => (result.ticks > 0 ? Math.round((v.ticksMs / result.ticks) * 1000) : 0);
  console.log(`  transforms applied: ${result.transforms}`);
  console.log(`  wall (indicative, Node/V8): original ${w.original.ticksMs.toFixed(1)}ms (${usPerTick(w.original)}µs/tick)` +
    `, optimized ${w.optimized.ticksMs.toFixed(1)}ms (${usPerTick(w.optimized)}µs/tick)`);
}
