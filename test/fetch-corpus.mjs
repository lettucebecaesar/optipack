/**
 * Fetch the real-world benchmark corpus.
 *
 * Downloads MIT-licensed community behavior-pack scripts from JaylyDev/ScriptAPI
 * (used with attribution; see the header comment of each fetched file for its
 * original author), assembles a runnable pack under test/corpus/jayly-pack/,
 * and records the source commit in SOURCES.json.
 *
 * The corpus is gitignored — run `npm run fetch-corpus` before benching it.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, 'corpus');
const repo = 'JaylyDev/ScriptAPI';

// Self-registering modules (subscribe or runInterval at import time) that the
// corpus pack's entry imports. Others ship in scripts/ for relative imports.
const ENTRY_IMPORTS = [
  './anti-nuker/index.js',
  './anti-32k/index.js',
  './anti-32k-event/index.js',
  './world-border/index.js',
  './health-display/index.js',
  './player-death-event/index.js',
];

const manifest = {
  format_version: 2,
  header: {
    name: 'optipack bench corpus (JaylyDev/ScriptAPI)',
    description: 'Real-world community scripts assembled for optipack A/B benchmarking. Scripts are MIT-licensed by their original authors.',
    uuid: '3f7c2d91-8a44-4e0b-9c55-1b2c3d4e5f60',
    version: [1, 0, 0],
    min_engine_version: [1, 21, 0],
  },
  modules: [
    { type: 'data', uuid: '4a8d3e02-9b55-4f1c-8d66-2c3d4e5f6a70', version: [1, 0, 0] },
    { type: 'script', language: 'javascript', uuid: '5b9e4f13-ac66-402d-9e77-3d4e5f6a7b80', entry: 'scripts/main.js', version: [1, 0, 0] },
  ],
  dependencies: [{ module_name: '@minecraft/server', version: '2.0.0' }],
};

// 1. Download + extract.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'optipack-corpus-'));
const tgz = path.join(tmp, 'repo.tar.gz');
console.log(`fetching ${repo} tarball...`);
execSync(`curl -sL "https://github.com/${repo}/archive/refs/heads/main.tar.gz" -o "${tgz}"`, { stdio: 'inherit' });
fs.mkdirSync(path.join(tmp, 'x'), { recursive: true });
execSync(`tar -xzf "${tgz}" -C "${path.join(tmp, 'x')}"`);
const extracted = fs.readdirSync(path.join(tmp, 'x'))[0];
const commit = execSync(`git ls-remote https://github.com/${repo}.git HEAD`, { encoding: 'utf8' }).trim().split(/\s+/)[0];

// 2. Assemble the corpus pack.
const packDir = path.join(corpusDir, 'jayly-pack');
fs.rmSync(corpusDir, { recursive: true, force: true });
fs.mkdirSync(path.join(packDir, 'scripts'), { recursive: true });
fs.cpSync(path.join(tmp, 'x', extracted, 'scripts'), path.join(packDir, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const imports = ENTRY_IMPORTS.map((rel) => `import '${rel}';`).join('\n');
const entry = [
  '// optipack bench corpus entry — imports real-world community scripts',
  '// (JaylyDev/ScriptAPI, MIT). Each module self-registers its handlers.',
  imports,
  '',
].join('\n');
fs.writeFileSync(path.join(packDir, 'scripts', 'main.js'), entry);

// 3. Record provenance.
fs.writeFileSync(
  path.join(corpusDir, 'SOURCES.json'),
  JSON.stringify({
    sources: [{ repo, commit, license: 'MIT', fetched: new Date().toISOString() }],
    note: 'Scripts belong to their original authors (see file headers). Fetched for optipack benchmarking only.',
  }, null, 2) + '\n'
);
fs.rmSync(tmp, { recursive: true, force: true });

const scriptCount = (function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => {
    const p = path.join(dir, e.name);
    return n + (e.isDirectory() ? walk(p) : e.name.endsWith('.js') ? 1 : 0);
  }, 0);
})(path.join(packDir, 'scripts'));

console.log(`corpus ready: ${packDir} (${scriptCount} script files, ${repo}@${commit.slice(0, 9)})`);
console.log('next: node bin/optipack.js bench test/corpus/jayly-pack --scenario test/corpus/jayly-scenario.json');
