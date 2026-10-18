/**
 * Fixture runner for per-transform unit tests.
 *
 * A fixture directory contains:
 *   input.js     — source fed through the full pipeline
 *   expected.js  — (optional) exact expected output; when absent the input
 *                  must come out unchanged (bail fixtures)
 *   config.json  — (optional) { level, transforms, hotPath, lint } user config
 *   expects.json — (optional) assertions on the report:
 *                  { transforms: {id: count}, bails: [{transform, reasonContains}],
 *                    lint: [{rule}], warnings: n }
 *   scenario.json— (optional) differential scenario { entry, reads, state, steps }
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export async function runFixtureDir(dir) {
  const inputPath = path.join(dir, 'input.js');
  const input = fs.readFileSync(inputPath, 'utf8');
  const expectedPath = path.join(dir, 'expected.js');
  const hasExpected = fs.existsSync(expectedPath);
  const expected = hasExpected ? fs.readFileSync(expectedPath, 'utf8') : null;

  const configPath = path.join(dir, 'config.json');
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
    : { level: 'balanced' };

  const expectsPath = path.join(dir, 'expects.json');
  const expects = fs.existsSync(expectsPath) ? JSON.parse(fs.readFileSync(expectsPath, 'utf8')) : null;

  const scenarioPath = path.join(dir, 'scenario.json');
  const scenario = fs.existsSync(scenarioPath) ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) : null;

  const { normalizeConfig } = await import('../../src/config.js');
  const { runPack } = await import('../../src/pipeline.js');

  const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optipack-fx-in-'));
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optipack-fx-out-'));
  fs.mkdirSync(path.join(inputDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(inputDir, 'scripts', 'input.js'), input);
  const cfg = normalizeConfig(config);
  const report = runPack(inputDir, outputDir, cfg);
  const output = fs.readFileSync(path.join(outputDir, 'scripts', 'input.js'), 'utf8');

  const result = { input, output, expected, report, expects, scenario, outputDir, config: cfg };

  // Exact output comparison.
  const want = hasExpected ? expected : input;
  const got = output.replace(/\r\n/g, '\n');
  const wantNorm = want.replace(/\r\n/g, '\n');
  if (got !== wantNorm) {
    throw new Error(
      `fixture output mismatch for ${path.basename(dir)}:\n` +
      `--- expected ---\n${wantNorm}\n--- actual ---\n${got}`
    );
  }

  // Report expectations.
  if (expects) {
    const file = report.files[0];
    if (expects.transforms) {
      for (const [id, count] of Object.entries(expects.transforms)) {
        const gotCount = (file.transforms[id] || 0);
        if (gotCount !== count) {
          throw new Error(`fixture ${path.basename(dir)}: expected ${count} of ${id}, got ${gotCount}`);
        }
      }
    }
    if (expects.noTransforms) {
      const total = Object.values(file.transforms).reduce((a, b) => a + b, 0);
      if (total !== 0) {
        throw new Error(`fixture ${path.basename(dir)}: expected no transforms, got ${JSON.stringify(file.transforms)}`);
      }
    }
    if (expects.bails) {
      for (const wantBail of expects.bails) {
        const found = file.bails.find((b) =>
          b.transform === wantBail.transform &&
          (wantBail.reasonContains === undefined || b.reason.includes(wantBail.reasonContains)) &&
          (wantBail.line === undefined || b.line === wantBail.line));
        if (!found) {
          throw new Error(`fixture ${path.basename(dir)}: expected bail ${JSON.stringify(wantBail)}, have ${JSON.stringify(file.bails)}`);
        }
      }
    }
    if (expects.lint) {
      for (const wantLint of expects.lint) {
        const found = file.lint.find((l) => l.rule === wantLint.rule &&
          (wantLint.line === undefined || l.line === wantLint.line));
        if (!found) {
          throw new Error(`fixture ${path.basename(dir)}: expected lint ${JSON.stringify(wantLint)}, have ${JSON.stringify(file.lint)}`);
        }
      }
    }
    if (expects.warnings !== undefined) {
      if (report.warnings.length !== expects.warnings) {
        throw new Error(`fixture ${path.basename(dir)}: expected ${expects.warnings} warnings, got ${report.warnings.length}`);
      }
    }
    if (expects.hotFunctions !== undefined) {
      if (file.hotFunctions !== expects.hotFunctions) {
        throw new Error(`fixture ${path.basename(dir)}: expected ${expects.hotFunctions} hot functions, got ${file.hotFunctions}`);
      }
    }
  }

  return result;
}

export function fixtureDirs(baseDir) {
  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(baseDir, e.name, 'input.js')))
    .map((e) => path.join(baseDir, e.name))
    .sort();
}
