// One-off helper: generate expected.js for every fixture that lacks one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = here; // fixtures live directly under test/

const { normalizeConfig } = await import('../src/config.js');
const { transformSource } = await import('../src/pipeline.js');

const dirs = fs.readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'input.js')))
  .map((e) => e.name)
  .sort();

const only = process.argv[2] || null;
for (const dir of dirs) {
  if (only && dir !== only) continue;
  const fdir = path.join(root, dir);
  if (fs.existsSync(path.join(fdir, 'expected.js'))) continue;
  const input = fs.readFileSync(path.join(fdir, 'input.js'), 'utf8');
  const configPath = path.join(fdir, 'config.json');
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : { level: 'balanced' };
  const cfg = normalizeConfig(raw);
  try {
    const { code, fileReport } = transformSource('input.js', input, cfg);
    fs.writeFileSync(path.join(fdir, 'expected.js'), code);
    console.log(`${dir}: generated (${Object.keys(fileReport.transforms).join(', ') || 'no transforms'})`);
  } catch (e) {
    console.error(`${dir}: FAILED: ${e.message}`);
  }
}
