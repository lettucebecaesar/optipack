// S1: constant folding shapes.
export const a = 1 + 2;
export const b = 'x' + 'y' + 'z';
export const c = typeof 'hello';
export const d = !true;
export const e = 10 > 5 && 3 < 2;
export const f = 2 * 3 + 4;
export const g = `a${1}b`;
export const h = null ?? 'fallback';
export const i = 5;
export const j = i + 1; // never folded: crosses an identifier
export const k = Math.floor(1.5); // never folded: function call
