// S6: destructure-to-direct inside a hot handler.
import { world, system } from '@minecraft/server';

function onTick(cfg) {
  const { x, y } = cfg;
  world.sendMessage('' + x + y);
}

// > 3 total uses: bails, stays untouched.
function tooManyUses(cfg) {
  const { x, y } = cfg;
  world.sendMessage('' + x);
  world.sendMessage('' + y);
  world.sendMessage('' + x);
  world.sendMessage('' + y);
}

// Default value hoisted to an if.
function withDefault(cfg) {
  const { x, z = 42 } = cfg;
  world.sendMessage('' + x + z);
}

system.runInterval(() => {
  onTick({ x: 1, y: 2 });
  tooManyUses({ x: 1, y: 2 });
  withDefault({ x: 1 });
}, 20);
