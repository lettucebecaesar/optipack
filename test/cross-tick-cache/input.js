// R1: cross-tick caches (risky, opt-in).
import { world, system } from '@minecraft/server';

function onTick(player) {
  const health = player.getComponent('minecraft:health');
  const id = player.id;
  const typeId = player.typeId;
  if (health) {
    world.sendMessage(id + ':' + typeId + ':' + health.currentValue);
  }
}

system.runInterval(() => onTick(world.getAllPlayers()[0]), 20);
