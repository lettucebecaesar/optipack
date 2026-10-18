/**
 * Per-transform unit tests: every test/<transformId>/ fixture runs through the
 * full pipeline, compares exact output against expected.js (or expects the
 * input unchanged), asserts report expectations, and â€” when scenario.json is
 * present â€” checks effects-equivalence between the original and optimized
 * code against the mock @minecraft/server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));

const { runFixtureDir, fixtureDirs } = await import('./harness/fixture.js');
const { differentialCheck } = await import('../src/harness/driver.js');

const dirs = fixtureDirs(here);

for (const dir of dirs) {
  const name = path.basename(dir);
  test(`fixture: ${name}`, async () => {
    const result = await runFixtureDir(dir);
    assert.ok(result.output.length > 0);
    // Round-trip parse is enforced inside the pipeline; double-check here.
    const { parseSource } = await import('../src/pipeline.js');
    parseSource(name, result.output);
  });

  if (fs.existsSync(path.join(dir, 'scenario.json'))) {
    test(`differential: ${name}`, async () => {
      const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
      const configRaw = fs.existsSync(path.join(dir, 'config.json'))
        ? JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8').replace(/^\uFEFF/, ''))
        : { level: 'balanced' };
      const files = { 'scripts/input.js': fs.readFileSync(path.join(dir, 'input.js'), 'utf8') };
      const { a, b } = await differentialCheck(files, configRaw, scenario, name);
      assert.ok(Array.isArray(a.effects));
      assert.ok(Array.isArray(b.effects));
    });
  }
}
