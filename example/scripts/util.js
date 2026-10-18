// optipack example — utilities. Hot helpers called from the tick loop.
import { world } from '@minecraft/server';

export function toZoneLabel(player) {
  const x = player.location.x;
  const z = player.location.z;
  return 'pos:' + Math.floor(x) + ',' + Math.floor(z);
}

export function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// Called from onPlayerSpawn which is called from a subscribed handler, and
// re-reads the same host chain in a loop: the S7 pattern.
export function trackBaseline(player) {
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += player.location.y;
  }
  world.setDynamicProperty('optipack:baseline', sum);
  return sum;
}

// Bool-shape helpers (S3).
export function isAboveWater(player) {
  return player.location.y > 62 ? true : false;
}
