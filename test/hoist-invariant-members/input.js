// S7: loop-invariant member hoisting inside hot functions.
import { world, system } from '@minecraft/server';

// Before-loop hoist: player.location read once instead of 10 times.
function onTick(player) {
  let total = 0;
  for (let i = 0; i < 10; i++) {
    total += player.location.y;
  }
  world.setDynamicProperty('total', total);
}

// Two chains, each used twice per iteration: both hoisted.
function onTick2(chest) {
  let dx = 0;
  for (let i = 0; i < 5; i++) {
    dx += chest.location.x + chest.location.y;
  }
  world.setDynamicProperty('dx', dx);
}

// Loop body with a call: barrier, bails.
function onTick3(player) {
  let total = 0;
  for (let i = 0; i < 4; i++) {
    total += player.location.y;
    world.sendMessage('tick');
  }
  world.setDynamicProperty('total3', total);
}

system.runInterval(onTick, 20);
system.runInterval(onTick2, 20);
system.runInterval(onTick3, 20);
