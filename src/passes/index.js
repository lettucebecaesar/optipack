/**
 * Ordered pass registry. Running level N enables all passes at level <= N.
 */
import * as s1 from './s1-const-fold.js';
import * as s2 from './s2-dead-code.js';
import * as s3 from './s3-bool-simplify.js';
import * as s4 from './s4-for-of-to-indexed.js';
import * as s5 from './s5-array-methods-to-loops.js';
import * as s6 from './s6-destructure-to-direct.js';
import * as s7 from './s7-hoist-invariant-members.js';
import * as b1 from './b1-cache-getter-chains.js';
import * as b2 from './b2-closure-lift.js';
import * as b3 from './b3-string-build.js';
import * as b4 from './b4-dynprop-hoist.js';
import * as b5 from './b5-null-chain-flatten.js';
import * as r1 from './r1-cross-tick-cache.js';
import * as r2 from './r2-json-fold.js';
import * as r3 from './r3-try-catch-strip.js';
import * as r4 from './r4-getter-cache-cross-barrier.js';

export const PASSES = [
  { code: 'S1', id: s1.ID, level: 'safe', run: s1.default },
  { code: 'S2', id: s2.ID, level: 'safe', run: s2.default },
  { code: 'S3', id: s3.ID, level: 'safe', run: s3.default },
  { code: 'S4', id: s4.ID, level: 'safe', run: s4.default },
  { code: 'S5', id: s5.ID, level: 'safe', run: s5.default },
  { code: 'S6', id: s6.ID, level: 'safe', run: s6.default },
  { code: 'S7', id: s7.ID, level: 'safe', run: s7.default },
  { code: 'B1', id: b1.ID, level: 'balanced', run: b1.default },
  { code: 'B2', id: b2.ID, level: 'balanced', run: b2.default },
  { code: 'B3', id: b3.ID, level: 'balanced', run: b3.default },
  { code: 'B4', id: b4.ID, level: 'balanced', run: b4.default },
  { code: 'B5', id: b5.ID, level: 'balanced', run: b5.default },
  { code: 'R1', id: r1.ID, level: 'risky', run: r1.default },
  { code: 'R2', id: r2.ID, level: 'risky', run: r2.default },
  { code: 'R3', id: r3.ID, level: 'risky', run: r3.default },
  { code: 'R4', id: r4.ID, level: 'risky', run: r4.default },
];

export const PASS_BY_ID = new Map(PASSES.map((p) => [p.id, p]));
export const PASS_BY_CODE = new Map(PASSES.map((p) => [p.code, p]));
export const PASS_IDS = new Set(PASSES.map((p) => p.id));
export const PASS_CODES = new Map(PASSES.map((p) => [p.code, p.id]));
