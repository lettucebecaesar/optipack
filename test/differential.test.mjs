/**
 * Bespoke differential scenarios.
 *
 * Every scenario loads the original and optimized entry with the mock
 * @minecraft/server, runs identical steps (ticks / events), and requires the
 * recorded EFFECTS to match exactly, in order. Reads return scripted sequences
 * so data flows deterministically; eliminated reads are invisible by design.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { differentialCheck, runVariant, pathToUrl, buildVariantPack } from '../src/harness/driver.js';

const PLAYER_READS = {
  'location:p1': [{ x: 1, y: 64, z: 2 }, { x: 2, y: 65, z: 3 }],
  'location:p2': [{ x: 5, y: 70, z: 6 }, { x: 6, y: 71, z: 7 }],
  'name:p1': ['Alice'],
  'name:p2': ['Bob'],
};

const TWO_PLAYERS = { players: [{ id: 'p1' }, { id: 'p2' }] };

test('differential: hot tick loop with heavy host reads (S4/S5/S7/B1/B3/B4)', async () => {
  const main = [
    "import { world, system } from '@minecraft/server';",
    '',
    'function onTick() {',
    '  const players = world.getAllPlayers();',
    '  let report = "";',
    '  for (let i = 0; i < players.length; i++) {',
    '    const p = players[i];',
    '    report += p.name + "@" + p.location.x + "," + p.location.x;',
    '    p.setDynamicProperty("optipack:x", p.location.x);',
    '    let baseline = 0;',
    '    for (let j = 0; j < 3; j++) {',
    '      baseline += p.location.y;',
    '    }',
    '    p.setDynamicProperty("optipack:baseline", baseline);',
    '  }',
    '  if (report.length > 0) {',
    '    world.sendMessage(report);',
    '  }',
    '  const zones = ["overworld", "nether", "the_end"].filter((z) => z.length > 4);',
    '  for (const z of zones) {',
    '    world.setDynamicProperty("optipack:zone:" + z, true);',
    '  }',
    '  const doubled = ["a", "bb"].map((v) => v + v);',
    '  world.setDynamicProperty("optipack:doubled", doubled.join(","));',
    '}',
    '',
    'system.runInterval(onTick, 20);',
  ].join('\n');

  const scenario = {
    entry: 'scripts/main.js',
    reads: PLAYER_READS,
    state: TWO_PLAYERS,
    steps: [{ op: 'tick', n: 40 }],
  };
  await differentialCheck({ 'scripts/main.js': main }, { level: 'balanced' }, scenario, 'hot-tick-loop');
});

test('differential: event-driven worldLoad -> runInterval -> playerSpawn', async () => {
  const main = [
    "import { world, system } from '@minecraft/server';",
    "import { makeGreeting } from './util.js';",
    '',
    'world.afterEvents.worldLoad.subscribe(() => {',
    "  world.sendMessage('loaded');",
    '  system.runInterval(onTick, 10);',
    '  world.afterEvents.playerSpawn.subscribe(onSpawn);',
    '});',
    '',
    'function onTick() {',
    '  const players = world.getAllPlayers();',
    '  for (const p of players) {',
    "    p.setDynamicProperty('seen', true);",
    '  }',
    '}',
    '',
    'function onSpawn(ev) {',
    '  const p = ev.player;',
    '  if (!p) return;',
    '  world.sendMessage(makeGreeting(p.name));',
    "  p.setDynamicProperty('spawned', 1);",
    '}',
  ].join('\n');

  const util = [
    "const PREFIX = 'hello ';",
    'export function makeGreeting(name) {',
    '  return PREFIX + name;',
    '}',
  ].join('\n');

  const scenario = {
    entry: 'scripts/main.js',
    reads: PLAYER_READS,
    state: TWO_PLAYERS,
    steps: [
      { op: 'fire', event: 'world.afterEvents.worldLoad', payload: {} },
      { op: 'tick', n: 25 },
      { op: 'fire', event: 'world.afterEvents.playerSpawn', payload: { player: { __entity: 'p1' } } },
      { op: 'tick', n: 5 },
    ],
  };
  await differentialCheck({ 'scripts/main.js': main, 'scripts/util.js': util }, { level: 'balanced' }, scenario, 'event-driven');
});

test('differential: runJob generator with yield barriers', async () => {
  const main = [
    "import { world, system } from '@minecraft/server';",
    '',
    'function* chunkScan() {',
    '  for (let cx = 0; cx < 3; cx++) {',
    "    const before = world.getDynamicProperty('scan:' + cx);",
    '    yield;',
    "    world.setDynamicProperty('scan:' + cx, (before ?? 0) + 1);",
    '  }',
    '  yield;',
    "  world.sendMessage('scan done');",
    '}',
    '',
    'world.afterEvents.worldLoad.subscribe(() => {',
    '  system.runJob(chunkScan());',
    '});',
  ].join('\n');

  const scenario = {
    entry: 'scripts/main.js',
    reads: { 'world.dp:scan:0': [0], 'world.dp:scan:1': [10], 'world.dp:scan:2': [20] },
    state: {},
    steps: [
      { op: 'fire', event: 'world.afterEvents.worldLoad', payload: {} },
      { op: 'tick', n: 10 },
    ],
  };
  await differentialCheck({ 'scripts/main.js': main }, { level: 'balanced' }, scenario, 'run-job');
});

test('differential: risky cross-tick cache stays effects-equivalent', async () => {
  const main = [
    "import { world, system } from '@minecraft/server';",
    '',
    'function onTick(player) {',
    '  const health = player.getComponent("minecraft:health");',
    '  if (health) {',
    '    player.setDynamicProperty("hp", health.currentValue);',
    '  }',
    '  player.setDynamicProperty("id", player.id);',
    '}',
    '',
    'system.runInterval(() => onTick(world.getAllPlayers()[0]), 1);',
  ].join('\n');

  const scenario = {
    entry: 'scripts/main.js',
    reads: {
      // Stable component value: R1's documented precondition (stale reads are
      // only observable when the underlying component changes).
      'component:p1:minecraft:health': [{ currentValue: 20 }],
      'name:p1': ['Alice'],
    },
    state: { players: [{ id: 'p1' }] },
    steps: [{ op: 'tick', n: 6 }],
  };
  await differentialCheck({ 'scripts/main.js': main }, { level: 'risky' }, scenario, 'cross-tick-cache');
});

test('differential: string building over many ticks (B3 O(n^2) fix)', async () => {
  const main = [
    "import { world, system } from '@minecraft/server';",
    '',
    'function onTick() {',
    '  const players = world.getAllPlayers();',
    '  let scoreboard = "";',
    '  for (let i = 0; i < players.length; i++) {',
    '    scoreboard += players[i].name + ";";',
    '  }',
    '  world.setDynamicProperty("scoreboard", scoreboard);',
    '}',
    '',
    'system.runInterval(onTick, 1);',
  ].join('\n');

  const scenario = {
    entry: 'scripts/main.js',
    reads: PLAYER_READS,
    state: TWO_PLAYERS,
    steps: [{ op: 'tick', n: 12 }],
  };
  const { a, b } = await differentialCheck({ 'scripts/main.js': main }, { level: 'balanced' }, scenario, 'string-build');
  // The optimized effect list must contain exactly the same number of
  // setDynamicProperty effects with the same joined values.
  assert.equal(a.effects.length, b.effects.length);
});

test('differential: guards and optional chains (B5) across ticks', async () => {
  const main = [
    "import { world, system } from '@minecraft/server';",
    '',
    'function onTick(ev) {',
    '  const p = ev.player;',
    '  if (!p) return;',
    "  world.sendMessage('n=' + p?.name);",
    "  p.setDynamicProperty('x', p?.location.x);",
    '}',
    '',
    'world.afterEvents.playerJoin.subscribe((ev) => onTick(ev));',
    'system.runInterval(() => onTick({ player: null }), 20);',
  ].join('\n');

  const scenario = {
    entry: 'scripts/main.js',
    reads: PLAYER_READS,
    state: TWO_PLAYERS,
    steps: [
      { op: 'fire', event: 'world.afterEvents.playerJoin', payload: { player: { __entity: 'p1' } } },
      { op: 'tick', n: 3 },
    ],
  };
  await differentialCheck({ 'scripts/main.js': main }, { level: 'balanced' }, scenario, 'null-guard');
});

test('differential: destructure-to-direct with mutation via property access', async () => {
  const main = [
    "import { world, system } from '@minecraft/server';",
    '',
    'function onTick(cfg) {',
    '  const { label, weight } = cfg;',
    "  world.sendMessage(label + ':' + weight);",
    '}',
    '',
    'system.runInterval(() => onTick({ label: "cfg", weight: 3 }), 20);',
  ].join('\n');

  const scenario = {
    entry: 'scripts/main.js',
    reads: {},
    state: TWO_PLAYERS,
    steps: [{ op: 'tick', n: 5 }],
  };
  await differentialCheck({ 'scripts/main.js': main }, { level: 'balanced' }, scenario, 'destructure');
});

test('differential: closure lift with registrations', async () => {
  const main = [
    "import { world, system } from '@minecraft/server';",
    '',
    "const GREETING = 'hi';",
    '',
    'world.afterEvents.worldLoad.subscribe(() => {',
    "  const announce = () => world.sendMessage(GREETING + ':lifted');",
    '  system.runInterval(announce, 30);',
    '});',
  ].join('\n');

  const scenario = {
    entry: 'scripts/main.js',
    reads: {},
    state: {},
    steps: [
      { op: 'fire', event: 'world.afterEvents.worldLoad', payload: {} },
      { op: 'tick', n: 65 },
    ],
  };
  await differentialCheck({ 'scripts/main.js': main }, { level: 'balanced' }, scenario, 'closure-lift');
});
