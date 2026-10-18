// B4: dynamic property reads hoisted out of hot loops.
import { world, system } from '@minecraft/server';

function onTick(player) {
  let score = 0;
  for (let i = 0; i < 4; i++) {
    if (player.getDynamicProperty('optipack:active') === true) {
      score += 1;
    }
  }
  world.setDynamicProperty('score', score);
}

// Loop contains another call: bails.
function withOtherCall(player) {
  let score = 0;
  for (let i = 0; i < 4; i++) {
    score += player.getDynamicProperty('optipack:n');
    world.sendMessage('x');
  }
  world.setDynamicProperty('score2', score);
}

system.runInterval(() => onTick(world.getAllPlayers()[0]), 20);
system.runInterval(() => withOtherCall(world.getAllPlayers()[0]), 20);
