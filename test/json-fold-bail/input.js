// R2 bail: JSON.parse result is mutated and passed around.
import { world } from '@minecraft/server';

const CFG = JSON.parse('{"n":1}');

export function passAround() {
  return handle(CFG);
}

function handle(c) {
  return c.n;
}

world.sendMessage(passAround());
