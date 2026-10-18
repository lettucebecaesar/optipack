// S1 bail: identifiers and calls never fold.
export const a = x + 1;
export const b = Math.floor(1.5);
export const c = obj.k + 1;
export function d(x) {
  return x * 2 + 1;
}
