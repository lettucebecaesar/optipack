// B5: optional chains flattened after proven guards.
import { world, system } from '@minecraft/server';
function onTick(player) {
  if (!player) return;
  world.sendMessage('n=' + player.name);
  const loc = player?.location;
  world.sendMessage('y=' + (loc === undefined ? -1 : loc.y));

  // Barrier (call) ends the guard window: `player?.name` below stays.
  world.sendMessage('mid');
  world.sendMessage('after=' + player?.name);
}

// Guard on an undefined-strictness check.
function withEqNull(ev) {
  if (ev.player == null) return;
  world.sendMessage('eq=' + ev.player?.name);
}
system.runInterval(() => onTick(world.getAllPlayers()[0]), 20);
system.runInterval(() => withEqNull({
  player: null
}), 20);
