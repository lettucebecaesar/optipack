/**
 * Snapshot updater: regenerates test/example-report-snapshot.json from the
 * current pipeline over example/. Run: npm run update-snapshot
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const { runPack } = await import('../src/pipeline.js');
const { normalizeConfig } = await import('../src/config.js');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'optipack-snap-'));
const report = runPack(path.join(root, 'example'), out, normalizeConfig({ level: 'balanced' }));
fs.writeFileSync(path.join(here, 'example-report-snapshot.json'), report.serialize());
console.log('snapshot updated: test/example-report-snapshot.json');
