// S6 bails: nested patterns, rest, member-chain objects, loops.
import { world, system } from '@minecraft/server';

export function nested(cfg) {
  const { a: { b } } = cfg;
  return b;
}

export function withRest(cfg) {
  const { a, ...rest } = cfg;
  return a + rest.length;
}

export function memberObj(player) {
  const { x, y } = player.location;
  return x + y;
}

export function loopHead(list) {
  for (const { id } of list) {
    world.sendMessage(id);
  }
}

system.runInterval(() => nested({ a: { b: 1 } }), 20);
