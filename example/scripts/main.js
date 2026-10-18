// optipack example — main entry.
// Registers a tick loop, an event handler, and a runJob generator.
import { world, system } from '@minecraft/server';
import { toZoneLabel, trackBaseline } from './util.js';
import { buildDropSummary, pollDropState } from './drops.js';

world.afterEvents.worldLoad.subscribe(() => {
  world.sendMessage('optipack example loaded');
  system.runInterval(onTick, 20);
  world.afterEvents.playerSpawn.subscribe(onPlayerSpawn);
});

// Per-tick handler: re-reads host getters every run, builds a string with +=,
// and iterates provable arrays with for...of + array methods.
function onTick() {
  const players = world.getAllPlayers();
  let summary = '';
  for (const player of players) {
    const label = toZoneLabel(player);
    const dist = player.location.x + player.location.y;
    summary += label + ' dist=' + dist;
    player.setDynamicProperty('optipack:lastDist', dist);
    // Per-player baseline: re-reads the same host chain every iteration (S7).
    let baseline = 0;
    for (let i = 0; i < 4; i++) {
      baseline += player.location.y;
    }
    player.setDynamicProperty('optipack:baseline', baseline);
  }
  if (summary.length > 0) {
    world.sendMessage(summary);
  }

  const zones = ['overworld', 'nether', 'the_end'].filter((z) => z.length > 4);
  for (const z of zones) {
    world.setDynamicProperty('optipack:zone:' + z, true);
  }

  system.runJob(chunkScan());

  if (players.length > 0) {
    pollDropState(players[0]);
  }
}

// runJob iterator: every yield is a barrier for host-object caching.
function* chunkScan() {
  for (let cx = 0; cx < 4; cx++) {
    const before = world.getDynamicProperty('optipack:scan:' + cx);
    yield;
    world.setDynamicProperty('optipack:scan:' + cx, (before ?? 0) + 1);
  }
}

function onPlayerSpawn(ev) {
  const p = ev.player;
  if (!p) return;
  world.sendMessage('welcome ' + p.name);
  const health = p.getComponent('minecraft:health');
  if (health) {
    p.setDynamicProperty('optipack:spawnHp', health.currentValue);
  }
  const drops = buildDropSummary(2);
  p.setDynamicProperty('optipack:drops', drops);
  // Hot helper defined in util.js — exercises transitive hot-path analysis.
  trackBaseline(p);
}
