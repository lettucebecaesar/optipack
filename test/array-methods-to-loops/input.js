// S5: array-method inlining inside a hot tick handler.
import { world, system } from '@minecraft/server';

const tags = ['a', 'bb', 'ccc'];

function onTick() {
  tags.forEach((t) => {
    world.sendMessage('tag:' + t);
  });

  const doubled = tags.map((t) => t + '!');
  world.setDynamicProperty('doubled', doubled.join(','));

  const longs = tags.filter((t) => t.length > 1);
  world.setDynamicProperty('longs', longs.length);

  const hasBb = tags.some((t) => t === 'bb');
  const allShort = tags.every((t) => t.length < 5);
  const found = tags.find((t) => t.length === 3);
  world.setDynamicProperty('checks', String(hasBb) + String(allShort) + String(found));
}

system.runInterval(onTick, 20);
