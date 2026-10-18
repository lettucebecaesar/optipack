import fs from 'node:fs';
import path from 'node:path';

export const LEVELS = ['safe', 'balanced', 'risky'];
export const LEVEL_RANK = { safe: 0, balanced: 1, risky: 2 };

export const DEFAULT_CONFIG = {
  level: 'balanced',
  transforms: {},
  hotPath: { transitiveDepth: 1 },
  lint: true,
};

export class ConfigError extends Error {}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseLevel(v) {
  if (typeof v !== 'string' || !LEVELS.includes(v)) {
    throw new ConfigError(`invalid level "${String(v)}" (expected one of ${LEVELS.join(', ')})`);
  }
  return v;
}

/**
 * Validate a raw parsed config object and normalize it onto the defaults.
 * Throws ConfigError on any structural problem.
 */
export function normalizeConfig(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULT_CONFIG, transforms: {}, hotPath: { transitiveDepth: 1 } };
  if (!isPlainObject(raw)) throw new ConfigError('config root must be a JSON object');
  const cfg = {
    level: DEFAULT_CONFIG.level,
    transforms: {},
    hotPath: { transitiveDepth: 1 },
    lint: true,
  };
  if (raw.level !== undefined) cfg.level = parseLevel(raw.level);
  if (raw.lint !== undefined) {
    if (typeof raw.lint !== 'boolean') throw new ConfigError('lint must be a boolean');
    cfg.lint = raw.lint;
  }
  if (raw.transforms !== undefined) {
    if (!isPlainObject(raw.transforms)) throw new ConfigError('transforms must be an object of booleans');
    for (const [k, v] of Object.entries(raw.transforms)) {
      if (typeof v !== 'boolean') throw new ConfigError(`transforms["${k}"] must be a boolean`);
      cfg.transforms[k] = v;
    }
  }
  if (raw.hotPath !== undefined) {
    if (!isPlainObject(raw.hotPath)) throw new ConfigError('hotPath must be an object');
    if (raw.hotPath.transitiveDepth !== undefined) {
      const d = raw.hotPath.transitiveDepth;
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 10) {
        throw new ConfigError('hotPath.transitiveDepth must be an integer between 0 and 10');
      }
      cfg.hotPath.transitiveDepth = d;
    }
    for (const k of Object.keys(raw.hotPath)) {
      if (k !== 'transitiveDepth') throw new ConfigError(`unknown hotPath option "${k}"`);
    }
  }
  for (const k of Object.keys(raw)) {
    if (!['level', 'transforms', 'hotPath', 'lint'].includes(k)) {
      throw new ConfigError(`unknown config key "${k}"`);
    }
  }
  return cfg;
}

/**
 * Load the config file. `explicitPath` wins; otherwise `./optipack.config.json`
 * is used when present relative to cwd. Returns { config, path } where path is
 * null when no file was found.
 */
export function loadConfigFile(explicitPath, cwd = process.cwd()) {
  let file = explicitPath;
  if (!file) {
    const def = path.join(cwd, 'optipack.config.json');
    if (fs.existsSync(def)) file = def;
  }
  if (!file) return { config: normalizeConfig(undefined), path: null };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read config file ${file}: ${e.message}`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // tolerate BOM
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`config file ${file} is not valid JSON: ${e.message}`);
  }
  return { config: normalizeConfig(raw), path: file };
}

/**
 * Merge CLI flags over a loaded config. CLI flags always win.
 * Only recognized transform ids may appear in the transforms map; the caller
 * passes the known id set (from the pass registry).
 */
export function mergeCliOverrides(config, cli, knownPassIds, knownPassCodes) {
  const out = {
    level: config.level,
    transforms: { ...config.transforms },
    hotPath: { ...config.hotPath },
    lint: config.lint,
  };
  if (cli.level !== undefined) out.level = parseLevel(cli.level);
  if (cli.config && cli.lint !== undefined) out.lint = cli.lint;
  else if (!cli.config && cli.lint !== undefined) out.lint = cli.lint;

  const normalizeList = (flag, list) => {
    if (!list) return null;
    const ids = list
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const id of ids) {
      if (!knownPassIds.has(id) && !knownPassCodes.has(id)) {
        throw new ConfigError(`unknown transform "${id}" in --${flag} (known: ${[...knownPassIds].join(', ')})`);
      }
    }
    return ids;
  };
  const only = normalizeList('only', cli.only);
  const except = normalizeList('except', cli.except);
  if (except) {
    for (const id of except) out.transforms[knownPassIds.has(id) ? id : knownPassCodes.get(id)] = false;
  }
  if (only) {
    // --only replaces the enabled set entirely.
    out.only = new Set(only.map((id) => (knownPassIds.has(id) ? id : knownPassCodes.get(id))));
  }
  if (cli.lint !== undefined) out.lint = cli.lint;
  return out;
}
