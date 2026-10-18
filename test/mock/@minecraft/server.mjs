/**
 * Mock @minecraft/server for differential testing.
 *
 * Effect-recorder contract: only MUTATING calls and registrations are recorded
 * as effects. Pure reads return scripted sequences and are intentionally not
 * recorded — transforms may legitimately eliminate reads, that is the point.
 *
 * The active recorder is read from globalThis.__opkRecorder at call time, so a
 * single mock module instance serves both the original and the optimized
 * variant of a script.
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

class Dimension {
  constructor(id) {
    this.id = id;
  }
  getEntities(options) {
    effect('dimension.getEntities', { dimension: this.id, options: serialize(options) });
    return scriptedRead(`entities:${this.id}`, []);
  }
  getPlayers() {
    effect('dimension.getPlayers', { dimension: this.id });
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
}

class Entity {
  constructor(id, typeId, dimension) {
    this._id = id;
    this.typeId = typeId;
    this._dimension = dimension;
  }
  get id() {
    return this._id;
  }
  get name() {
    return scriptedRead(`name:${this._id}`, 'player' + this._id);
  }
  get location() {
    return scriptedRead(`location:${this._id}`, { x: 0, y: 0, z: 0 });
  }
  get dimension() {
    return this._dimension;
  }
  getComponent(componentId) {
    return scriptedRead(`component:${this._id}:${componentId}`, undefined);
  }
  getComponents() {
    effect('entity.getComponents', { entity: this._id });
    return [];
  }
  getDynamicProperty(identifier) {
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
    return scriptedRead(`rotation:${this._id}`, { x: 0, y: 0 });
  }
  getVelocity() {
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

const worldAfterEvents = {
  worldLoad: makeEvent('world.afterEvents.worldLoad'),
  worldInitialize: makeEvent('world.afterEvents.worldInitialize'),
  playerSpawn: makeEvent('world.afterEvents.playerSpawn'),
  playerJoin: makeEvent('world.afterEvents.playerJoin'),
  playerLeave: makeEvent('world.afterEvents.playerLeave'),
  entityDie: makeEvent('world.afterEvents.entityDie'),
  entityHurt: makeEvent('world.afterEvents.entityHurt'),
  itemUse: makeEvent('world.afterEvents.itemUse'),
  chatSend: makeEvent('world.afterEvents.chatSend'),
};
const worldBeforeEvents = {
  worldLoad: makeEvent('world.beforeEvents.worldLoad'),
  playerInteractWithBlock: makeEvent('world.beforeEvents.playerInteractWithBlock'),
  playerInteractWithEntity: makeEvent('world.beforeEvents.playerInteractWithEntity'),
  itemUse: makeEvent('world.beforeEvents.itemUse'),
  chatSend: makeEvent('world.beforeEvents.chatSend'),
};

function currentPlayers() {
  const r = rec();
  if (!r) return [];
  ensurePlayers(r);
  return r._players;
}

function ensurePlayers(r) {
  if (r._players) return r._players;
  const specs = (r.state && r.state.players) || [];
  r._players = specs.map((s) => new Entity(s.id, s.typeId || 'minecraft:player', new Dimension(s.dimension || 'minecraft:overworld')));
  return r._players;
}

// The differential driver hydrates event payloads via this hook.
if (typeof globalThis !== 'undefined') {
  globalThis.__opkEnsurePlayers = ensurePlayers;
}

export const world = {
  get afterEvents() {
    return worldAfterEvents;
  },
  get beforeEvents() {
    return worldBeforeEvents;
  },
  getAllPlayers() {
    effect('world.getAllPlayers', null);
    return currentPlayers();
  },
  getPlayers() {
    effect('world.getPlayers', null);
    return currentPlayers();
  },
  getDynamicProperty(identifier) {
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
    return new Dimension(dimensionId);
  },
  playSound(soundId, options) {
    effect('world.playSound', { soundId, options: serialize(options) });
  },
};

const systemBeforeEvents = {
  tick: makeEvent('system.beforeEvents.tick'),
  watchdogTerminate: makeEvent('system.beforeEvents.watchdogTerminate'),
};
const systemAfterEvents = {
  tick: makeEvent('system.afterEvents.tick'),
  watchdogTerminate: makeEvent('system.afterEvents.watchdogTerminate'),
};

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

export { Entity, Dimension };
export const TicksPerSecond = 20;
export const GameMode = { survival: 'survival', creative: 'creative', adventure: 'adventure' };
export default { world, system, Entity, Dimension, TicksPerSecond, GameMode };
