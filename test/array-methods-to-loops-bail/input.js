// S5 bails: non-inline callbacks, this/arguments, optional chaining.
import { world, system } from '@minecraft/server';

function handler(t) {
  world.sendMessage(t);
}

function onTick(tags) {
  tags.forEach(handler);

  const obj = {
    run: function () {
      tags.forEach((t) => this.log(t));
      return 1;
    },
  };
  return obj;
}

function optionalTick(tags) {
  tags?.forEach((t) => world.sendMessage(t));
}

system.runInterval(() => optionalTick(['a']), 20);
