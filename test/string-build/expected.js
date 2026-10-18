// B3: string accumulation in a hot loop -> parts + join.
import { world, system } from '@minecraft/server';
function onTick(players) {
  let summary = '';
  const _opParts = [];
  for (let i = 0; i < players.length; i++) {
    _opParts.push("" + (players[i].name + ';'));
  }
  summary = _opParts.join("");
  world.sendMessage(summary);
}

// Written outside a loop: bails.
export function notALoop(players) {
  let s = '';
  s += 'x';
  world.sendMessage(s);
}

// Read inside the loop: bails.
export function readInside(players) {
  let s = '';
  for (let i = 0; i < players.length; i++) {
    s += players[i].name;
    world.sendMessage(s);
  }
  world.sendMessage(s);
}
system.runInterval(() => onTick(world.getAllPlayers()), 20);
