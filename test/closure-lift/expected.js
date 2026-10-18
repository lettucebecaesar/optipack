// B2: closure lifting inside a hot handler.
import { world, system } from '@minecraft/server';
const _opLift = () => {
  world.sendMessage('tick');
};
const _opLift2 = () => world.sendMessage(PREFIX + ':2');
const _opCap = 7;
const _opLift3 = () => world.sendMessage('n=' + _opCap);
let _opCell;
const _opLift4 = suffix => world.sendMessage(_opCell.tag + suffix);
const _opLift5 = () => setup(world.getAllPlayers()[0]);
const _opLift6 = () => reassigned(world.getAllPlayers()[0]);
const PREFIX = 'op';
function onTick() {
  // Captures nothing: lifted.
  const announce = _opLift;
  announce();

  // Captures a module-level const: lifted.
  const announce2 = _opLift2;
  announce2();

  // Captures a per-invocation const primitive: lifted with the value inlined
  // as a module const (_opCap).
  const local = 7;
  const announce3 = _opLift3;
  announce3();

  // Captures a never-reassigned live local, called synchronously: lifted via
  // a module-level cell assigned at the creation point.
  const ctxObj = {
    tag: 'x'
  };
  _opCell = ctxObj;
  const announce4 = _opLift4;
  announce4('!4');
}

// Escaping arrow (registration) capturing a live local: bails — each
// registration needs its own capture and the invocation count is unprovable.
function setup(player) {
  const cb = () => world.sendMessage('hi ' + player.name);
  system.runInterval(cb, 20);
}

// Reassigned capture: bails.
function reassigned(player) {
  let n = player.location.y;
  const cb = () => world.sendMessage('n=' + n);
  cb();
  n = 9;
  cb();
}
world.afterEvents.worldLoad.subscribe(() => {
  system.runInterval(onTick, 20);
  system.runInterval(_opLift5, 20);
  system.runInterval(_opLift6, 20);
});
