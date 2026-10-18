/**
 * Differential harness.
 *
 * Equivalence notion: transforms may legitimately eliminate READS — that is
 * the point — so we compare EFFECTS, not API-call traces. Every mutating call
 * (sendMessage, setDynamicProperty, runCommand, spawnEntity, applyDamage,
 * component writes, runInterval/runTimeout/runJob registrations) must match
 * exactly, in order, between original and optimized code.
 *
 * Reads return scripted sequences from the recorder, so data flows through
 * the script deterministically.
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Register the ESM loader hooks (idempotent). Only needed for variant loading. */
export function ensureHooks() {
  if (!globalThis.__opkHooksRegistered) {
    register(
      pathToFileURL(path.join(here, 'loader-hooks.mjs')).href,
      pathToFileURL(path.join(here, 'driver.js')).href
    );
    globalThis.__opkHooksRegistered = true;
  }
}

export function makeRecorder({ reads = {}, state = {} } = {}) {
  const r = {
    effects: [],
    handlers: new Map(),
    intervals: [],
    timeouts: [],
    jobs: [],
    readQueues: structuredClone(reads),
    readIdx: {},
    state,
    tickCounter: 0,
    counters: {},
  };
  r.count = (kind, n = 1) => {
    r.counters[kind] = (r.counters[kind] || 0) + n;
  };
  r.effect = (call, args) => {
    r.effects.push({ call, args });
  };
  // Scripted reads index by TICK, not by call: the engine is synchronous, so
  // repeated reads within one tick return the same value, and values may only
  // change between ticks. This models the real host boundary correctly.
  r.scriptedRead = (key, fallback) => {
    const q = r.readQueues[key];
    if (!q || q.length === 0) return fallback;
    return q[r.tickCounter % q.length];
  };
  r.addHandler = (name, cb) => {
    if (!r.handlers.has(name)) r.handlers.set(name, []);
    r.handlers.get(name).push(cb);
  };
  r.removeHandler = (name, cb) => {
    const arr = r.handlers.get(name);
    if (arr) {
      const idx = arr.indexOf(cb);
      if (idx >= 0) arr.splice(idx, 1);
    }
  };
  r.addInterval = (cb, interval) => {
    const id = r.intervals.length;
    r.intervals.push({ fn: cb, interval });
    return id;
  };
  r.addTimeout = (cb, delay) => {
    const id = r.timeouts.length;
    r.timeouts.push({ fn: cb, delay, due: r.tickCounter + delay });
    return id;
  };
  r.addJob = (gen) => {
    r.jobs.push({ gen });
  };
  // One game tick: run due interval callbacks, timeouts, and one job step each.
  r.tick = (n = 1) => {
    for (let t = 0; t < n; t++) {
      r.tickCounter++;
      const intervals = [...r.intervals];
      for (const it of intervals) {
        if (r.tickCounter % it.interval === 0) it.fn();
      }
      const due = r.timeouts.filter((to) => to.due <= r.tickCounter);
      for (const to of due) {
        to.fn();
      }
      r.timeouts = r.timeouts.filter((to) => to.due > r.tickCounter);
      for (const j of r.jobs) {
        try {
          j.gen.next();
        } catch (e) {
          // Generator exceptions propagate like engine errors; record them.
          r.effects.push({ call: 'job.error', args: String(e && e.message) });
        }
      }
    }
  };
  r.fire = (eventName, payload) => {
    const handlers = [...(r.handlers.get(eventName) || [])];
    const hydrated = hydrate(payload, r);
    for (const cb of handlers) cb(hydrated);
  };
  r.tickCount = () => r.tickCounter;
  return r;
}

/** Recursively replace {__entity}/{__dimension}/{__block} markers in a payload with live mock objects. */
function hydrate(value, rec) {
  if (globalThis.__opkEnsurePlayers) globalThis.__opkEnsurePlayers(rec);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => hydrate(v, rec));
  if (typeof value.__entity === 'string') {
    const players = rec._players || [];
    const found = players.find((p) => p.id === value.__entity);
    return found || value;
  }
  if (typeof value.__dimension === 'string') {
    if (!globalThis.__opkMakeDimension) throw new Error('hydrate __dimension: server mock not loaded');
    return globalThis.__opkMakeDimension(value.__dimension);
  }
  if (value.__block) {
    if (!globalThis.__opkMakeBlock) throw new Error('hydrate __block: server mock not loaded');
    return globalThis.__opkMakeBlock(hydrate(value.__block.location, rec), value.__block.dimension);
  }
  const out = {};
  for (const k of Object.keys(value)) out[k] = hydrate(value[k], rec);
  return out;
}

/**
 * Load a script entry with a fresh recorder and run the step list.
 * Steps: {op:'tick', n}, {op:'fire', event, payload}, {op:'call', fn(rec)}
 */
export async function runVariant(entryUrl, variant, { reads, state, steps = [] }) {
  ensureHooks();
  const rec = makeRecorder({ reads, state });
  globalThis.__opkRecorder = rec;
  try {
    const mod = await import(`${entryUrl}?opkv=${variant}&t=${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
    for (const step of steps) {
      if (step.op === 'tick') rec.tick(step.n);
      else if (step.op === 'fire') rec.fire(step.event, step.payload);
      else if (step.op === 'fireMany') {
        for (let i = 0; i < (step.count || 1); i++) rec.fire(step.event, step.payload);
      } else if (step.op === 'call') step.fn(rec);
    }
  } finally {
    globalThis.__opkRecorder = null;
  }
  return rec;
}

export function assertSameEffects(a, b, label = '') {
  const ja = JSON.stringify(a.effects);
  const jb = JSON.stringify(b.effects);
  if (ja !== jb) {
    // Find the first divergence for a helpful message.
    const la = a.effects;
    const lb = b.effects;
    let i = 0;
    while (i < la.length && i < lb.length && JSON.stringify(la[i]) === JSON.stringify(lb[i])) i++;
    const fmt = (e) => JSON.stringify(e);
    throw new Error(
      `effects diverge${label ? ' (' + label + ')' : ''} at index ${i}:\n` +
      `  original:   ${la[i] ? fmt(la[i]) : '<none>'}\n` +
      `  optimized:  ${lb[i] ? fmt(lb[i]) : '<none>'}\n` +
      `  (original had ${la.length} effects, optimized had ${lb.length})`
    );
  }
}

/**
 * Build a temp pack from sources, run the pipeline over it, and return both
 * the original and optimized file paths.
 */
export async function buildVariantPack(files, config, testSuffix) {
  const { normalizeConfig } = await import('../config.js');
  const { runPack } = await import('../pipeline.js');
  const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), `optipack-${testSuffix}-in-`));
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `optipack-${testSuffix}-out-`));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(inputDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const cfg = normalizeConfig(config || { level: 'balanced' });
  const report = runPack(inputDir, outputDir, cfg);
  return { inputDir, outputDir, report };
}

export function pathToUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');
}

/**
 * Full differential check: run original + optimized with the same scenario
 * and compare effect traces.
 */
export async function differentialCheck(files, config, scenario, label) {
  const { inputDir, outputDir } = await buildVariantPack(files, config, label.replace(/\W+/g, '-'));
  const entryRel = scenario.entry; // e.g. 'scripts/main.js'
  const origUrl = pathToUrl(path.join(inputDir, entryRel));
  const optUrl = pathToUrl(path.join(outputDir, entryRel));
  const a = await runVariant(origUrl, 'orig', scenario);
  const b = await runVariant(optUrl, 'opt', scenario);
  assertSameEffects(a, b, label);
  return { a, b, outputDir };
}
