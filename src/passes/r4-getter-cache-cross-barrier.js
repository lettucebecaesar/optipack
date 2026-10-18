/**
 * R4 getter-cache-cross-barrier — RISKY.
 *
 * B1 (cache-getter-chains), but allowed to cross call and assignment barriers
 * within one synchronous callback invocation. Await/yield remain barriers.
 *
 * Failure mode: if an intervening call moves or modifies the entity (teleport,
 * damage, dimension change), cached values are stale — e.g. teleport then read
 * cached `location`. Every hoisted chain emits a warning.
 */
import traverse from '@babel/traverse';
import b1Impl from './b1-cache-getter-chains.js';

const _traverse = traverse.default || traverse;

export const ID = 'getter-cache-cross-barrier';
export const CODE = 'R4';

export default function getterCacheCrossBarrier(programPath, ctx) {
  b1Impl(programPath, ctx, {
    id: ID,
    code: CODE,
    crossBarriers: true,
    onApply: (line, links) => {
      ctx.warn(line, CODE,
        `chain .${links} cached across call barriers — stale if an intervening call moves/modifies the entity`);
    },
  });
}
