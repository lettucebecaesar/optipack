// R4: getter caching across call barriers (risky).
import { world, system } from '@minecraft/server';

function onTick(player) {
  const before = player.location.x;
  world.sendMessage('moving'); // call barrier — B1 would bail, R4 crosses it
  const after = player.location.x;
  world.sendMessage('moved=' + (after - before));
}

system.runInterval(() => onTick(world.getAllPlayers()[0]), 20);
