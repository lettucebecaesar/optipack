/**
 * Pack walker — walks the input behavior pack, copies non-script files
 * verbatim, and returns the list of script files to transform.
 *
 * Only files under `scripts/` with .js/.mjs extensions are transformed.
 * node_modules/ and .git/ are skipped entirely. Everything else (manifest.json,
 * JSON, functions, texts, textures) is copied byte-for-byte.
 */
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT_EXT = new Set(['.js', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', '.git']);

export function walkPack(inputDir) {
  const scripts = [];
  const copies = [];
  const visit = (dir, rel) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        visit(abs, relPath);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        const inScripts = relPath === 'scripts' || relPath.startsWith('scripts/');
        if (inScripts && SCRIPT_EXT.has(ext)) {
          scripts.push({ abs, relPath });
        } else {
          copies.push({ abs, relPath });
        }
      }
    }
  };
  visit(inputDir, '');
  return { scripts, copies };
}

export function copyFile(srcAbs, destAbs) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(srcAbs, destAbs);
}

export function writeFile(destAbs, content) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.writeFileSync(destAbs, content);
}
