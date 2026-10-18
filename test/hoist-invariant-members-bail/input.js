// S7 bails: loop-variable roots, computed members, reassignment.
import { world, system } from '@minecraft/server';

function loopVar(chests) {
  let total = 0;
  for (let i = 0; i < chests.length; i++) {
    total += chests[i].location.y;
  }
  world.setDynamicProperty('t', total);
}

function reassigned(player) {
  let total = 0;
  for (let i = 0; i < 4; i++) {
    total += player.location.y;
  }
  player = null;
  world.setDynamicProperty('t', total);
}

system.runInterval(() => loopVar([1, 2]), 20);
system.runInterval(() => reassigned(world.getAllPlayers()[0]), 20);
