/**
 * Node module loader hooks for differential testing.
 *
 * - `@minecraft/server` resolves to the mock module (single instance; the
 *   recorder is passed via globalThis.__opkRecorder).
 * - Pack files are loaded with a `?opkv=<variant>` query so the original and
 *   optimized variants get separate ESM cache entries; the query is stripped
 *   when reading from disk and propagated to relative imports.
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const MOCK_URL = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock', '@minecraft', 'server.mjs')
).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@minecraft/server') {
    return { url: MOCK_URL, shortCircuit: true };
  }
  const res = await nextResolve(specifier, context);
  const parentURL = context.parentURL || '';
  if (parentURL.includes('opkv=') && res.url.startsWith('file:') && !res.url.includes('opkv=')) {
    const q = new URL(parentURL).search;
    return { ...res, url: res.url + q, shortCircuit: true };
  }
  return res;
}

export async function load(url, context, nextLoad) {
  const u = new URL(url);
  if (u.protocol === 'file:' && u.search) {
    const clean = pathToFileURL(fileURLToPath(u)).href;
    const r = await nextLoad(clean, context);
    return { format: r.format || 'module', source: r.source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
