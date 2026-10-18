// R4: getter caching across call barriers (risky).
import { world, system } from '@minecraft/server';
function onTick(player) {
  const _opC = player.location.x;
  const before = _opC;
  world.sendMessage('moving'); // call barrier — B1 would bail, R4 crosses it
  const after = _opC;
  world.sendMessage('moved=' + (after - before));
}
system.runInterval(() => onTick(world.getAllPlayers()[0]), 20);
