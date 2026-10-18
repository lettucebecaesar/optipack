/**
 * Example pack end-to-end: run the CLI over example/, verify parse validity,
 * manifest fidelity, effects-equivalence across the whole script graph, report
 * snapshot, and determinism.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const CLI = path.join(root, 'bin', 'optipack.js');
const EXAMPLE = path.join(root, 'example');

function mkOut(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('example: CLI produces a valid optimized pack + report', async () => {
  const out = mkOut('optipack-example-');
  const res = spawnSync(process.execPath, [CLI, EXAMPLE, out], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);

  // Manifest and non-scripts copied verbatim.
  assert.equal(
    fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'),
    fs.readFileSync(path.join(EXAMPLE, 'manifest.json'), 'utf8')
  );

  // Report exists with the expected schema shape.
  const report = JSON.parse(fs.readFileSync(path.join(out, 'optipack-report.json'), 'utf8'));
  assert.equal(report.level, 'balanced');
  assert.ok(Array.isArray(report.files) && report.files.length === 3);
  assert.ok(report.files.every((f) => f.path.startsWith('scripts/')));
  assert.ok(report.totals.transforms > 0, 'transforms applied');
  for (const f of report.files) {
    for (const key of ['path', 'hotFunctions', 'transforms', 'bails', 'lint', 'residualAllocs', 'bytes']) {
      assert.ok(key in f, `report file has ${key}`);
    }
    assert.ok(f.bytes.after > 0);
  }

  // Every output script re-parses as ESM.
  const { parseSource } = await import('../src/pipeline.js');
  for (const f of ['scripts/main.js', 'scripts/util.js', 'scripts/drops.js']) {
    const src = fs.readFileSync(path.join(out, f), 'utf8');
    assert.doesNotThrow(() => parseSource(f, src), `${f} round-trips`);
  }
});

test('example: effects-equivalence across the whole script graph', async () => {
  const out = mkOut('optipack-example-');
  const res = spawnSync(process.execPath, [CLI, EXAMPLE, out], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);

  const { runVariant, assertSameEffects, pathToUrl } = await import('../src/harness/driver.js');
  const scenario = {
    reads: {
      'location:p1': [{ x: 10, y: 64, z: 20 }, { x: 12, y: 65, z: 22 }],
      'name:p1': ['Alex'],
      'dp:p1:optipack:lastDist': [undefined],
      'dp:p1:optipack:baseline': [undefined],
      'dp:p1:optipack:drops': [undefined],
      'world.dp:scan:0': [0],
      'world.dp:scan:1': [0],
      'world.dp:scan:2': [0],
      'world.dp:scan:3': [0],
    },
    state: { players: [{ id: 'p1' }] },
    steps: [
      { op: 'fire', event: 'world.afterEvents.worldLoad', payload: {} },
      { op: 'tick', n: 60 },
      { op: 'fire', event: 'world.afterEvents.playerSpawn', payload: { player: { __entity: 'p1' } } },
      { op: 'tick', n: 40 },
    ],
  };

  const a = await runVariant(pathToUrl(path.join(EXAMPLE, 'scripts', 'main.js')), 'orig', scenario);
  const b = await runVariant(pathToUrl(path.join(out, 'scripts', 'main.js')), 'opt', scenario);
  assertSameEffects(a, b, 'example pack');
  assert.ok(a.effects.length > 10, 'scenario exercised real effects');
});

test('example: report snapshot is stable', () => {
  const out = mkOut('optipack-example-');
  const res = spawnSync(process.execPath, [CLI, EXAMPLE, out, '--report', path.join(out, 'r.json')], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const actual = fs.readFileSync(path.join(out, 'r.json'), 'utf8');
  const snapshotPath = path.join(here, 'example-report-snapshot.json');
  if (process.env.UPDATE_SNAPSHOT) {
    fs.writeFileSync(snapshotPath, actual);
  }
  assert.ok(fs.existsSync(snapshotPath), 'snapshot exists (run npm run update-snapshot)');
  const expected = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const got = JSON.parse(actual);
  assert.deepEqual(got, expected, 'report matches snapshot');
});

test('example: deterministic output â€” two runs are byte-identical', () => {
  const out1 = mkOut('optipack-det1-');
  const out2 = mkOut('optipack-det2-');
  spawnSync(process.execPath, [CLI, EXAMPLE, out1], { encoding: 'utf8' });
  spawnSync(process.execPath, [CLI, EXAMPLE, out2], { encoding: 'utf8' });
  for (const f of ['scripts/main.js', 'scripts/util.js', 'scripts/drops.js', 'optipack-report.json']) {
    assert.equal(
      fs.readFileSync(path.join(out1, f), 'utf8'),
      fs.readFileSync(path.join(out2, f), 'utf8'),
      `${f} identical across runs`
    );
  }
});
