// S3: boolean simplification shapes.
export function f(x, y) {
  const a = !!(x > 0);
  return !!(y > 1);
}
export function g(x) {
  return x > 0;
}
export function h(x) {
  return x !== 3;
}
export function b(x) {
  return x === true; // bails: x not statically boolean-typed
}
