// B3 bails: prepend pattern and accumulator read inside the loop.
import { world, system } from '@minecraft/server';

function prepend(players) {
  let s = '';
  for (let i = 0; i < players.length; i++) {
    s = players[i].name + s;
  }
  world.sendMessage(s);
}

function readInside(players) {
  let s = '';
  for (let i = 0; i < players.length; i++) {
    s += players[i].name;
    world.sendMessage(s.length);
  }
  world.sendMessage(s);
}

system.runInterval(() => prepend(world.getAllPlayers()), 20);
