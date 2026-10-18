/**
 * Generator for permissive @minecraft/* stubs.
 * Reads runtime export names from the real index.d.ts of each module and
 * writes test/mock/@minecraft/<module>.mjs stub files. Re-run after bumping
 * the module versions in the versions map below.
 *
 * Usage: node test/update-mock-stubs.mjs   (requires $env:TEMP\mc-stubs with
 * extracted packages, or it will pack them itself)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mockDir = path.join(here, 'mock', '@minecraft');

// module -> version (latest stable/beta at time of writing)
const MODULES = {
  '@minecraft/common': '1.3.0',
  '@minecraft/debug-utilities': '1.0.0-beta.1.20.70-preview.20',
  '@minecraft/diagnostics': '1.0.0-beta.1.21.70-preview.22',
  '@minecraft/server-admin': '1.0.0-beta.11940b24',
  '@minecraft/server-editor': '0.1.0-beta.1.20.20-preview.20',
  '@minecraft/server-gametest': '1.0.0-beta.1.21.60-preview.24',
  '@minecraft/server-graphics': '1.0.0',
  '@minecraft/server-net': '1.0.0-beta.11940b24',
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-stub-gen-'));
for (const [name, version] of Object.entries(MODULES)) {
  const spec = `${name}@${version}`;
  const tarball = execSync(`npm pack ${spec} --silent --pack-destination "${tmp}"`, { encoding: 'utf8' }).trim();
  const dirName = tarball.replace(/\.tgz$/, '');
  fs.mkdirSync(path.join(tmp, dirName), { recursive: true });
  execSync(`tar -xzf "${path.join(tmp, tarball)}" -C "${path.join(tmp, dirName)}"`);
  const dtsPath = path.join(tmp, dirName, 'package', 'index.d.ts');
  const dts = fs.readFileSync(dtsPath, 'utf8');

  // Runtime (value) exports: classes, functions, enums, consts, vars — plus
  // explicit `export { ... }` lists. Type-only exports are skipped.
  const names = new Set();
  const re = /^export (?:declare )?(?:abstract )?(class|function|enum|const|var)\s+([A-Za-z0-9_$]+)/gm;
  for (const m of dts.matchAll(re)) names.add(m[2]);
  for (const m of dts.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z0-9_$]+$/.test(n)) names.add(n);
    }
  }

  const short = name.replace('@minecraft/', '').replace(/\//g, '-');
  const header =
    `/**\n * Permissive stub of ${name}@${version} for the differential harness.\n` +
    ` * Generated from the module's real index.d.ts (see test/update-mock-stubs.mjs).\n` +
    ` * Every runtime export is a permissive value: callable, constructable, and\n` +
    ` * chainable; calls and constructions record harness effects so differential\n` +
    ` * equivalence holds. NOT a behavioral model of the engine module.\n */\n` +
    `import { permissive } from '../permissive.mjs';\n\n`;
  const body = [...names].sort().map((n) => `export const ${n} = permissive('${short}.${n}');`).join('\n');
  fs.writeFileSync(path.join(mockDir, short + '.mjs'), header + body + '\n');
  console.log(`${name}: ${names.size} runtime exports -> mock/@minecraft/${short}.mjs`);
}
fs.rmSync(tmp, { recursive: true, force: true });
