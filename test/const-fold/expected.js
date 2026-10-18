// S1: constant folding shapes.
export const a = 3;
export const b = "xyz";
export const c = "string";
export const d = false;
export const e = false;
export const f = 10;
export const g = "a1b";
export const h = 'fallback';
export const i = 5;
export const j = i + 1; // never folded: crosses an identifier
export const k = Math.floor(1.5); // never folded: function call
