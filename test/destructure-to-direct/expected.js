// S6: destructure-to-direct inside a hot handler.
import { world, system } from '@minecraft/server';
function onTick(cfg) {
  world.sendMessage('' + cfg.x + cfg.y);
}

// > 3 total uses: bails, stays untouched.
function tooManyUses(cfg) {
  const {
    x,
    y
  } = cfg;
  world.sendMessage('' + x);
  world.sendMessage('' + y);
  world.sendMessage('' + x);
  world.sendMessage('' + y);
}

// Default value hoisted to an if.
function withDefault(cfg) {
  let z = cfg.z;
  if (z === undefined) z = 42;
  world.sendMessage('' + cfg.x + z);
}
system.runInterval(() => {
  onTick({
    x: 1,
    y: 2
  });
  tooManyUses({
    x: 1,
    y: 2
  });
  withDefault({
    x: 1
  });
}, 20);
