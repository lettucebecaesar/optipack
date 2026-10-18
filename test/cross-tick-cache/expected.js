// R1: cross-tick caches (risky, opt-in).
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
  const health = __opR1Component(player, "minecraft:health");
  const id = __opR1Field(player, "id");
  const typeId = __opR1Field(player, "typeId");
  if (health) {
    world.sendMessage(id + ':' + typeId + ':' + health.currentValue);
  }
}
system.runInterval(() => onTick(world.getAllPlayers()[0]), 20);
