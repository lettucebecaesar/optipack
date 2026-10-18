/**
 * Node module loader hooks for differential testing.
 *
 * - `@minecraft/*` runtime modules resolve to harness mocks under
 *   test/mock/@minecraft/ (single instances; the recorder is passed via
 *   globalThis.__opkRecorder). @minecraft/server and @minecraft/server-ui
 *   have functional mocks; the remaining runtime modules have permissive
 *   stubs generated from their real type definitions.
 * - Pack files are loaded with a `?opkv=<variant>` query so the original and
 *   optimized variants get separate ESM cache entries; the query is stripped
 *   when reading from disk and propagated to relative imports.
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const mockDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock', '@minecraft');

// Functional mocks.
const FUNCTIONAL = new Set(['@minecraft/server', '@minecraft/server-ui']);

// Permissive stubs generated from each module's real index.d.ts.
const STUBBED = new Set([
  '@minecraft/common',
  '@minecraft/debug-utilities',
  '@minecraft/diagnostics',
  '@minecraft/server-admin',
  '@minecraft/server-editor',
  '@minecraft/server-gametest',
  '@minecraft/server-graphics',
  '@minecraft/server-net',
]);

const MOCK_URLS = new Map([
  ['@minecraft/server', pathToFileURL(path.join(mockDir, 'server.mjs')).href],
  ['@minecraft/server-ui', pathToFileURL(path.join(mockDir, 'server-ui.mjs')).href],
  ...[...STUBBED].map((name) => [
    name,
    pathToFileURL(path.join(mockDir, name.replace('@minecraft/', '').replace(/\//g, '-') + '.mjs')).href,
  ]),
]);

export async function resolve(specifier, context, nextResolve) {
  if (MOCK_URLS.has(specifier)) {
    return { url: MOCK_URLS.get(specifier), shortCircuit: true };
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
