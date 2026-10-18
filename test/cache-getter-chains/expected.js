// B1: repeated host chains cached within barrier-free regions.
import { world, system } from '@minecraft/server';
function onTick(player) {
  const _opC = player.location.x;
  // Two uses in one statement: cached with one const before the statement.
  world.sendMessage('x=' + _opC + ' again=' + _opC);

  // Two uses across barrier-free statements: cached across both.
  const _opC2 = player.location.y;
  const first = _opC2;
  const second = _opC2 + 1;
  world.sendMessage('y=' + (first + second));

  // Uses split by a call barrier: bails.
  const a = player.location.z;
  world.sendMessage('mid');
  const b = player.location.z;
  world.sendMessage('z=' + (a + b));
}
system.runInterval(onTick, 20);
