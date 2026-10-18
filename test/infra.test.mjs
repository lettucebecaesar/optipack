/**
 * Infrastructure tests: pragmas, config handling, CLI behaviors, determinism.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const CLI = path.join(root, 'bin', 'optipack.js');

const { normalizeConfig, loadConfigFile, ConfigError } = await import('../src/config.js');
const { transformSource, runPack } = await import('../src/pipeline.js');

function mkPack(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optipack-infra-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

const cfg = (over = {}) => normalizeConfig({ level: 'balanced', ...over });

test('config: normalize + validation', () => {
  assert.equal(cfg().level, 'balanced');
  assert.equal(cfg({ level: 'risky' }).level, 'risky');
  assert.equal(cfg({ hotPath: { transitiveDepth: 3 } }).hotPath.transitiveDepth, 3);
  assert.throws(() => normalizeConfig({ level: 'nope' }), ConfigError);
  assert.throws(() => normalizeConfig({ transforms: { 'x': 1 } }), ConfigError);
  assert.throws(() => normalizeConfig({ hotPath: { transitiveDepth: -1 } }), ConfigError);
  assert.throws(() => normalizeConfig({ unknownKey: true }), ConfigError);
});

test('config: file loading with BOM + explicit path', () => {
  const dir = mkPack({ 'optipack.config.json': '\uFEFF{"level":"safe","transforms":{"json-fold":false}}' });
  const { config } = loadConfigFile(path.join(dir, 'optipack.config.json'));
  assert.equal(config.level, 'safe');
  assert.equal(config.transforms['json-fold'], false);
  assert.throws(() => loadConfigFile(path.join(dir, 'nope.json')), ConfigError);
});
test('pragma: file-level optipack: off disables everything', () => {
  const src = [
    '// optipack: off',
    "export const a = 1 + 2;",
    "export function f() {",
    "  let s = '';",
    "  for (const x of ['a']) { s += x; }",
    "  return s;",
    '}',
  ].join('\n');
  const { code, fileReport } = transformSource('t.js', src, cfg());
  assert.equal(code, src);
  assert.deepEqual(fileReport.transforms, {});
});

test('pragma: optipack-disable on the line before a statement', () => {
  const src = [
    '// const-fold disabled for this declaration only',
    '// optipack-disable const-fold',
    'export const a = 1 + 2;',
    'export const b = 3 + 4;',
  ].join('\n');
  const { code, fileReport } = transformSource('t.js', src, cfg());
  assert.ok(code.includes('export const a = 1 + 2;'), 'disabled line unchanged');
  assert.ok(code.includes('export const b = 7;'), 'enabled line folded');
  assert.equal(fileReport.transforms['const-fold'], 1);
});

test('pragma: optipack-disable all', () => {
  const src = [
    'export function f() {',
    '  // optipack-disable all',
    '  return 1 + 2;',
    '}',
    'export const g = 2 + 3;',
  ].join('\n');
  const { code, fileReport } = transformSource('t.js', src, cfg());
  assert.ok(code.includes('return 1 + 2;'), 'disabled return unchanged');
  assert.ok(code.includes('export const g = 5;'), 'other code folded');
  assert.equal(fileReport.transforms['const-fold'], 1);
});

test('pragma: optipack-hot force-marks a function', () => {
  const src = [
    "import { world } from '@minecraft/server';",
    '// optipack-hot',
    'function notRegistered(player) {',
    '  const a = player.location.x;',
    '  const b = player.location.x;',
    '  world.sendMessage(String(a + b));',
    '}',
  ].join('\n');
  const { fileReport } = transformSource('t.js', src, cfg());
  // Hot-marked -> B1 applies even without registration.
  assert.ok(fileReport.transforms['cache-getter-chains'] >= 1, 'B1 applied to pragma-hot function');
});

test('pipeline: determinism — same input produces byte-identical output', () => {
  const src = [
    "import { world, system } from '@minecraft/server';",
    'function onTick() {',
    "  const tags = ['a', 'b'].filter((t) => t.length > 0);",
    '  let s = 0;',
    '  for (const t of tags) { s += t.length; }',
    "  world.sendMessage('' + s);",
    '}',
    'system.runInterval(onTick, 20);',
  ].join('\n');
  const r1 = transformSource('t.js', src, cfg());
  const r2 = transformSource('t.js', src, cfg());
  assert.equal(r1.code, r2.code);
});

test('pipeline: output round-trips as ESM', () => {
  const src = [
    "import { world } from '@minecraft/server';",
    'export class Thing { #n = 1; get n() { return this.#n; } }',
    'export const arrow = async (x) => x ?? 0;',
  ].join('\n');
  const { code } = transformSource('t.js', src, cfg());
  assert.ok(code.includes('class Thing'), 'modern syntax preserved');
});

test('pipeline: parse failure reports file and line', () => {
  assert.throws(() => transformSource('scripts/bad.js', 'function {{{', cfg()), (e) => {
    assert.equal(e.code, 2);
    assert.ok(e.message.includes('scripts/bad.js'), 'file name in message');
    assert.match(e.message, /:\d+:\d+/, 'line:column in message');
    return true;
  });
});

test('pack walker: non-script files copied verbatim, manifest untouched', () => {
  const input = mkPack({
    'manifest.json': '{"format_version": 2, "header": {"name": "keep"}}',
    'scripts/main.js': 'export const a = 1 + 2;\n',
    'functions/tick.mcfunction': 'say hi\n',
    'texts/en_US.lang': 'item.name=Thing\n',
    'textures/foo.png': 'not-really-a-png',
    'scripts/nested/sub.js': 'const b = 2 + 2;\n',
  });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'optipack-out-')), 'pack');
  const report = runPack(input, out, cfg());
  assert.equal(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'), '{"format_version": 2, "header": {"name": "keep"}}');
  assert.equal(fs.readFileSync(path.join(out, 'functions/tick.mcfunction'), 'utf8'), 'say hi\n');
  assert.equal(fs.readFileSync(path.join(out, 'textures/foo.png'), 'utf8'), 'not-really-a-png');
  assert.equal(fs.readFileSync(path.join(out, 'texts/en_US.lang'), 'utf8'), 'item.name=Thing\n');
  const mainOut = fs.readFileSync(path.join(out, 'scripts/main.js'), 'utf8');
  assert.ok(mainOut.includes('3'), 'script transformed');
  assert.ok(fs.existsSync(path.join(out, 'scripts/nested/sub.js')));
  assert.equal(report.files.length, 2);
});

test('CLI: exit 0 on the example pack, report written, manifest identical', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'optipack-cli-')), 'out');
  const res = spawnSync(process.execPath, [CLI, path.join(root, 'example'), out, '--report', path.join(out, 'report.json')], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(out, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(out, 'report.json')));
  assert.ok(fs.existsSync(path.join(out, 'scripts/main.js')));
});

test('CLI: exit 1 on usage errors', () => {
  const res1 = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(res1.status, 1);
  const res2 = spawnSync(process.execPath, [CLI, 'Z:/definitely/missing/dir', 'out'], { encoding: 'utf8' });
  assert.equal(res2.status, 1);
  const res3 = spawnSync(process.execPath, [CLI, path.join(root, 'example'), 'out', '--level', 'bogus'], { encoding: 'utf8' });
  assert.equal(res3.status, 1);
  const res4 = spawnSync(process.execPath, [CLI, path.join(root, 'example'), 'out', '--only', 'no-such-transform'], { encoding: 'utf8' });
  assert.equal(res4.status, 1);
});

test('CLI: exit 2 on parse failure with file+line in stderr', () => {
  const input = mkPack({
    'manifest.json': '{}',
    'scripts/broken.js': 'function broken( {\n  return 1;\n}\n',
  });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'optipack-out-')), 'out');
  const res = spawnSync(process.execPath, [CLI, input, out], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.ok(res.stderr.includes('scripts/broken.js'), res.stderr);
  assert.match(res.stderr, /:\d+:/, 'line number present');
});

test('CLI: --dry-run writes nothing', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'optipack-out-')), 'out');
  const res = spawnSync(process.execPath, [CLI, path.join(root, 'example'), out, '--dry-run'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('"level"'), 'report printed to stdout');
  assert.equal(fs.existsSync(out), false, 'no output directory created');
});

test('CLI: --only restricts to the named transforms', () => {
  const input = mkPack({ 'scripts/main.js': "export const a = 1 + 2;\nexport const b = 'x' + 'y';\n" });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'optipack-out-')), 'out');
  const res = spawnSync(process.execPath, [CLI, input, out, '--only', 'for-of-to-indexed', '--report', path.join(out, 'r.json')], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const outCode = fs.readFileSync(path.join(out, 'scripts/main.js'), 'utf8');
  assert.ok(outCode.includes('1 + 2'), 'const-fold excluded');
});

test('CLI: --except disables a transform', () => {
  const input = mkPack({ 'scripts/main.js': "export const a = 1 + 2;\n" });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'optipack-out-')), 'out');
  const res = spawnSync(process.execPath, [CLI, input, out, '--except', 'const-fold', '--report', path.join(out, 'r.json')], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.readFileSync(path.join(out, 'scripts/main.js'), 'utf8').includes('1 + 2'));
});

test('CLI: --diff prints unified diffs', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'optipack-out-')), 'out');
  const res = spawnSync(process.execPath, [CLI, path.join(root, 'example'), out, '--diff', '--report', path.join(out, 'r.json')], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('--- a/scripts/main.js'), 'diff header present');
  assert.ok(res.stdout.includes('@@'), 'hunk headers present');
});

test('CLI: --level safe skips balanced passes', () => {
  const input = mkPack({
    'scripts/main.js': [
      "import { world, system } from '@minecraft/server';",
      'function onTick(player) {',
      '  const a = player.location.x;',
      '  const b = player.location.x;',
      "  world.sendMessage('' + (a + b));",
      '}',
      'system.runInterval(onTick, 20);',
    ].join('\n'),
  });
  const outSafe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'optipack-out-')), 'safe');
  spawnSync(process.execPath, [CLI, input, outSafe, '--level', 'safe', '--report', path.join(outSafe, 'r.json')], { encoding: 'utf8' });
  const safeCode = fs.readFileSync(path.join(outSafe, 'scripts/main.js'), 'utf8');
  assert.ok(safeCode.includes('player.location.x'), 'B1 did not run at safe level');
});

test('CLI: risky passes only run at risky level or explicit config', () => {
  const src = [
    "import { world, system } from '@minecraft/server';",
    "const CFG = JSON.parse('{\"n\":1}');",
    'function onTick(player) {',
    "  world.sendMessage('' + CFG.n + player.id);",
    '}',
    'system.runInterval(onTick, 20);',
  ].join('\n');
  const balanced = transformSource('t.js', src, cfg({ level: 'balanced' }));
  assert.ok(balanced.code.includes('JSON.parse'), 'R2 did not run at balanced');
  const risky = transformSource('t.js', src, cfg({ level: 'risky' }));
  assert.ok(risky.code.includes('_opJson'), 'R2 ran at risky level');
  assert.ok(risky.fileReport.warnings >= 1, 'R2 emitted a warning');
  const explicit = transformSource('t.js', src, cfg({ level: 'safe', transforms: { 'json-fold': true } }));
  assert.ok(explicit.code.includes('_opJson'), 'R2 ran via explicit config');
});
