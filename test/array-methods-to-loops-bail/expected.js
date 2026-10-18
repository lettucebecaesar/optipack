// S5 bails: non-inline callbacks, this/arguments, optional chaining.
import { world, system } from '@minecraft/server';
const _opLift = t => world.sendMessage(t);
function handler(t) {
  world.sendMessage(t);
}
function optionalTick(tags) {
  tags?.forEach(_opLift);
}
system.runInterval(() => optionalTick(['a']), 20);
