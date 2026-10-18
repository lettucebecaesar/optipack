// R3: try/catch stripping in hot functions (risky).
import { world, system } from '@minecraft/server';
const __opR1Cache = new WeakMap();
function __opR1Component(obj, key) {
  let m = __opR1Cache.get(obj);
  if (m === undefined) {
    m = new Map();
    __opR1Cache.set(obj, m);
  }
  let v = m.get(key);
  if (v === undefined) {
    v = obj.getComponent(key);
    m.set(key, v);
  }
  return v;
}
function __opR1Field(obj, key) {
  let m = __opR1Cache.get(obj);
  if (m === undefined) {
    m = new Map();
    __opR1Cache.set(obj, m);
  }
  let v = m.get(key);
  if (v === undefined) {
    v = obj[key];
    m.set(key, v);
  }
  return v;
}
function onTick(player) {
  let x = 0;
  x = player.location.y;
  world.setDynamicProperty('x', x);
}

// Catch with a body: bails.
function withCatchBody(player) {
  let x = 0;
  try {
    x = player.location.y;
  } catch (e) {
    world.sendMessage('err');
  }
  world.setDynamicProperty('x2', x);
}

// Try body with a call: bails.
function withCall(player) {
  let x = 0;
  try {
    x = __opR1Component(player, "minecraft:health").currentValue;
  } catch {}
  world.setDynamicProperty('x3', x);
}
system.runInterval(() => onTick(world.getAllPlayers()[0]), 20);
system.runInterval(() => withCatchBody(world.getAllPlayers()[0]), 20);
system.runInterval(() => withCall(world.getAllPlayers()[0]), 20);
