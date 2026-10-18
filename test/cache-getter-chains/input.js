// B1: repeated host chains cached within barrier-free regions.
import { world, system } from '@minecraft/server';

function onTick(player) {
  // Two uses in one statement: cached with one const before the statement.
  world.sendMessage('x=' + player.location.x + ' again=' + player.location.x);

  // Two uses across barrier-free statements: cached across both.
  const first = player.location.y;
  const second = player.location.y + 1;
  world.sendMessage('y=' + (first + second));

  // Uses split by a call barrier: bails.
  const a = player.location.z;
  world.sendMessage('mid');
  const b = player.location.z;
  world.sendMessage('z=' + (a + b));
}

system.runInterval(onTick, 20);
