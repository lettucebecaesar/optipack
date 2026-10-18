// R3: try/catch stripping in hot functions (risky).
import { world, system } from '@minecraft/server';

function onTick(player) {
  let x = 0;
  try {
    x = player.location.y;
  } catch {}
  world.setDynamicProperty('x', x);
}

// Catch with a body: bails.
function withCatchBody(player) {
  let x = 0;
  try {
    x = player.location.y;
  } catch (e) {
    world.sendMessage('err');
  }
  world.setDynamicProperty('x2', x);
}

// Try body with a call: bails.
function withCall(player) {
  let x = 0;
  try {
    x = player.getComponent('minecraft:health').currentValue;
  } catch {}
  world.setDynamicProperty('x3', x);
}

system.runInterval(() => onTick(world.getAllPlayers()[0]), 20);
system.runInterval(() => withCatchBody(world.getAllPlayers()[0]), 20);
system.runInterval(() => withCall(world.getAllPlayers()[0]), 20);
