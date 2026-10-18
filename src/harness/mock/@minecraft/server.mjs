/**
 * Mock @minecraft/server for the differential harness and `optipack bench`.
 *
 * Effect-recorder contract: only MUTATING calls and registrations are recorded
 * as effects. Pure reads return scripted sequences and are intentionally not
 * recorded — transforms may legitimately eliminate reads, that is the point.
 *
 * Boundary counters: the optipack-relevant metric — host-boundary crossings
 * (location reads, getComponent, getDynamicProperty, ...) — is counted on the
 * recorder (`r.counters`). Location reads return a FRESH object per read, like
 * the engine (each read allocates a new Vector3), so allocation pressure is
 * visible in the counter too.
 *
 * Tolerance: arbitrary real-world scripts use wider API surface than any mock
 * can enumerate. world/Dimension/Entity instances are wrapped so unknown
 * members resolve to permissive values that record `stub.*` effects (identical
 * on both sides of a comparison), and event collections accept ANY event name.
 * Known hot-path members keep real implementations with counters.
 */

const rec = () => globalThis.__opkRecorder;

function scriptedRead(key, fallback) {
  const r = rec();
  if (!r) return fallback;
  return r.scriptedRead(key, fallback);
}

function effect(call, args) {
  const r = rec();
  if (r) r.effect(call, args === undefined ? null : args);
}

function count(kind) {
  const r = rec();
  if (r) r.count(kind);
}

function serialize(v) {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') return v;
  if (v instanceof Entity) return { __entity: v.id };
  if (v instanceof Dimension) return { __dimension: v.id };
  if (Array.isArray(v)) return v.map(serialize);
  if (t === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = serialize(v[k]);
    return out;
  }
  return String(v);
}

/** Permissive fallback for unknown members on wrapped host objects. */
function unknownMember(label) {
  const asPrimitive = (hint) => (hint === 'number' ? 0 : label);
  const fn = function (...args) {
    effect('stub.call', { target: label, args: serialize(args) });
    return unknownMember(label + '()');
  };
  fn.toString = () => label;
  fn.valueOf = () => label;
  return new Proxy(fn, {
    get(target, prop, receiver) {
      if (prop === Symbol.toPrimitive) return asPrimitive;
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then' || prop === 'catch' || prop === 'finally' || prop === 'toJSON') return undefined;
      if (prop === 'toString' || prop === 'valueOf') return Reflect.get(target, prop, receiver);
      return unknownMember(label + '.' + String(prop));
    },
    construct(target, args) {
      effect('stub.new', { target: label, args: serialize(args) });
      return unknownMember('new ' + label);
    },
    apply(target, thisArg, args) {
      effect('stub.call', { target: label, args: serialize(args) });
      return unknownMember(label + '()');
    },
    has() { return true; },
  });
}

class Block {
  constructor(location, dimensionId) {
    this.location = location;
    this.__dim = dimensionId;
    this.typeId = scriptedRead(`blockType:${this.__dim}`, 'minecraft:stone');
  }
  get permutation() {
    count('boundary.block.permutation');
    return scriptedRead(`blockPerm:${this.__dim}`, { type: this.typeId });
  }
  setPermutation(permutation) {
    effect('block.setPermutation', { dimension: this.__dim, location: serialize(this.location), permutation: serialize(permutation) });
  }
  setType(blockType) {
    effect('block.setType', { dimension: this.__dim, location: serialize(this.location), type: serialize(blockType) });
  }
  getComponent(name) {
    count('boundary.getComponent');
    return scriptedRead(`component:block:${name}`, undefined);
  }
}

function wrapHost(instance, label) {
  return new Proxy(instance, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'catch' || prop === 'finally') {
        return typeof prop === 'symbol' ? undefined : Reflect.get(target, prop, receiver);
      }
      if (prop in target) return Reflect.get(target, prop, receiver);
      return unknownMember(label + '.' + String(prop));
    },
  });
}

class Dimension {
  constructor(id) {
    this.id = id;
  }
  getEntities(options) {
    count('boundary.getEntities');
    effect('dimension.getEntities', { dimension: this.id, options: serialize(options) });
    return scriptedRead(`entities:${this.id}`, []);
  }
  getPlayers() {
    count('boundary.getPlayers');
    effect('dimension.getPlayers', { dimension: this.id });
    return scriptedRead(`players:${this.id}`, []);
  }
  get players() {
    count('boundary.players');
    return scriptedRead(`players:${this.id}`, []);
  }
  spawnEntity(type, location) {
    effect('dimension.spawnEntity', { dimension: this.id, type, location: serialize(location) });
    return scriptedRead(`spawn:${this.id}:${type}`, null);
  }
  spawnParticle(effectName, location, molangVariables) {
    effect('dimension.spawnParticle', { dimension: this.id, effectName, location: serialize(location), molang: serialize(molangVariables) });
  }
  runCommand(commandString) {
    effect('dimension.runCommand', { dimension: this.id, command: commandString });
  }
  getBlock(location) {
    count('boundary.getBlock');
    return new Block({ x: location.x, y: location.y, z: location.z }, this.id);
  }
  getEntitiesAtBlockLocation(location) {
    count('boundary.getEntitiesAtBlockLocation');
    effect('dimension.getEntitiesAtBlockLocation', { dimension: this.id, location: serialize(location) });
    return scriptedRead(`entitiesAt:${this.id}`, []);
  }
}

function wrapDimension(dim) {
  return wrapHost(dim, 'dimension.' + dim.id);
}

class Entity {
  constructor(id, typeId, dimension) {
    this._id = id;
    this.typeId = typeId;
    this._dimension = dimension;
    return wrapHost(this, 'entity.' + id);
  }
  get id() {
    return this._id;
  }
  get name() {
    return scriptedRead(`name:${this._id}`, 'player' + this._id);
  }
  get location() {
    count('boundary.location');
    const v = scriptedRead(`location:${this._id}`, { x: 0, y: 0, z: 0 });
    // The engine allocates a fresh Vector3 on every read; mirror that.
    return { x: v.x, y: v.y, z: v.z };
  }
  get dimension() {
    count('boundary.dimension');
    return this._dimension;
  }
  getComponent(componentId) {
    count('boundary.getComponent');
    const v = scriptedRead(`component:${this._id}:${componentId}`, undefined);
    // Real-world scripts assume queried components exist; default to a
    // chainable permissive component instead of undefined (identical on both
    // sides of a comparison).
    return v === undefined ? unknownMember('entity.' + this._id + '.component.' + componentId) : v;
  }
  getComponents() {
    count('boundary.getComponents');
    effect('entity.getComponents', { entity: this._id });
    return [];
  }
  getDynamicProperty(identifier) {
    count('boundary.getDynamicProperty');
    return scriptedRead(`dp:${this._id}:${identifier}`, undefined);
  }
  setDynamicProperty(identifier, value) {
    effect('entity.setDynamicProperty', { entity: this._id, key: identifier, value: serialize(value) });
  }
  sendMessage(message) {
    effect('entity.sendMessage', { entity: this._id, message: serialize(message) });
  }
  runCommand(commandString) {
    effect('entity.runCommand', { entity: this._id, command: commandString });
  }
  teleport(location, teleportOptions) {
    effect('entity.teleport', { entity: this._id, location: serialize(location), options: serialize(teleportOptions) });
  }
  applyDamage(amount, options) {
    effect('entity.applyDamage', { entity: this._id, amount, options: serialize(options) });
    return scriptedRead(`damage:${this._id}`, true);
  }
  applyKnockback(direction, horizontalStrength, verticalStrength) {
    effect('entity.applyKnockback', { entity: this._id, direction: serialize(direction), horizontalStrength, verticalStrength });
  }
  applyImpulse(impulse) {
    effect('entity.applyImpulse', { entity: this._id, impulse: serialize(impulse) });
  }
  kill() {
    effect('entity.kill', { entity: this._id });
  }
  addTag(tag) {
    effect('entity.addTag', { entity: this._id, tag });
    return true;
  }
  removeTag(tag) {
    effect('entity.removeTag', { entity: this._id, tag });
    return true;
  }
  hasTag(tag) {
    return scriptedRead(`tag:${this._id}:${tag}`, false);
  }
  playAnimation(animationName, options) {
    effect('entity.playAnimation', { entity: this._id, animationName, options: serialize(options) });
  }
  triggerEvent(eventName) {
    effect('entity.triggerEvent', { entity: this._id, eventName });
  }
  getRotation() {
    count('boundary.getRotation');
    return scriptedRead(`rotation:${this._id}`, { x: 0, y: 0 });
  }
  getVelocity() {
    count('boundary.getVelocity');
    return scriptedRead(`velocity:${this._id}`, { x: 0, y: 0, z: 0 });
  }
}

function makeEvent(fullName) {
  return {
    subscribe(callback, options) {
      effect('subscribe', { event: fullName, options: serialize(options) });
      const r = rec();
      if (r) r.addHandler(fullName, callback);
    },
    unsubscribe(callback) {
      effect('unsubscribe', { event: fullName });
      const r = rec();
      if (r) r.removeHandler(fullName, callback);
    },
  };
}

// Event collections accept ANY event name (real-world scripts use the full
// API surface; unknown names record the same effect shape).
function eventCollection(prefix) {
  return new Proxy({}, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (prop in target) return target[prop];
      const ev = makeEvent(`${prefix}.${String(prop)}`);
      target[prop] = ev;
      return ev;
    },
  });
}

function currentPlayers() {
  const r = rec();
  if (!r) return [];
  if (!r._players) {
    const specs = (r.state && r.state.players) || [];
    r._players = specs.map((s) => new Entity(s.id, s.typeId || 'minecraft:player', wrapDimension(new Dimension(s.dimension || 'minecraft:overworld'))));
  }
  return r._players;
}

function ensurePlayers(r) {
  if (r._players) return r._players;
  const specs = (r.state && r.state.players) || [];
  r._players = specs.map((s) => new Entity(s.id, s.typeId || 'minecraft:player', wrapDimension(new Dimension(s.dimension || 'minecraft:overworld'))));
  return r._players;
}

// The differential driver hydrates event payloads via these hooks.
if (typeof globalThis !== 'undefined') {
  globalThis.__opkEnsurePlayers = ensurePlayers;
  globalThis.__opkMakeDimension = (id) => wrapDimension(new Dimension(id));
  globalThis.__opkMakeBlock = (location, dimensionId) => new Block(location, dimensionId || 'minecraft:overworld');
}

const worldImpl = {
  get afterEvents() {
    return eventCollection('world.afterEvents');
  },
  get beforeEvents() {
    return eventCollection('world.beforeEvents');
  },
  getAllPlayers() {
    count('boundary.getAllPlayers');
    effect('world.getAllPlayers', null);
    return currentPlayers();
  },
  getPlayers() {
    count('boundary.getPlayers');
    effect('world.getPlayers', null);
    return currentPlayers();
  },
  getDynamicProperty(identifier) {
    count('boundary.getDynamicProperty');
    return scriptedRead(`world.dp:${identifier}`, undefined);
  },
  setDynamicProperty(identifier, value) {
    effect('world.setDynamicProperty', { key: identifier, value: serialize(value) });
  },
  sendMessage(message) {
    effect('world.sendMessage', { message: serialize(message) });
  },
  getEntity(identifier) {
    effect('world.getEntity', { id: identifier });
    return scriptedRead(`world.entity:${identifier}`, undefined);
  },
  getDimension(dimensionId) {
    effect('world.getDimension', { id: dimensionId });
    return wrapDimension(new Dimension(dimensionId));
  },
  playSound(soundId, options) {
    effect('world.playSound', { soundId, options: serialize(options) });
  },
};

export const world = wrapHost(worldImpl, 'world');

const systemBeforeEvents = eventCollection('system.beforeEvents');
const systemAfterEvents = eventCollection('system.afterEvents');

export const system = {
  get beforeEvents() {
    return systemBeforeEvents;
  },
  get afterEvents() {
    return systemAfterEvents;
  },
  runInterval(callback, tickInterval) {
    const interval = tickInterval === undefined ? 1 : tickInterval;
    effect('system.runInterval', { interval });
    const r = rec();
    return r ? r.addInterval(callback, interval) : -1;
  },
  runTimeout(callback, timeoutTicks) {
    const delay = timeoutTicks === undefined ? 1 : timeoutTicks;
    effect('system.runTimeout', { delay });
    const r = rec();
    return r ? r.addTimeout(callback, delay) : -1;
  },
  run(callback) {
    effect('system.run', null);
    const r = rec();
    return r ? r.addTimeout(callback, 1) : -1;
  },
  runJob(generator) {
    effect('system.runJob', null);
    const r = rec();
    if (r) r.addJob(generator);
    return { cancel() { effect('system.clearRun', { id: 'job' }); } };
  },
  clearRun(runId) {
    effect('system.clearRun', { id: serialize(runId) });
  },
};

export { Entity, Dimension, Block };
export const TicksPerSecond = 20;
export const GameMode = { survival: 'survival', creative: 'creative', adventure: 'adventure' };

// Full API surface: every other runtime export of the real module is a
// permissive value (generated from the real index.d.ts) so real-world
// scripts' named imports link under the harness.
export * from './server-extras.mjs';

export default { world, system, Entity, Dimension, TicksPerSecond, GameMode };
