// S3: boolean simplification shapes.
export function f(x, y) {
  const a = x > 0 ? true : false;
  if (y > 1) {
    return true;
  } else {
    return false;
  }
}
export function g(x) {
  return (x > 0) === true;
}
export function h(x) {
  return (x !== 3) !== false;
}
export function b(x) {
  return x === true; // bails: x not statically boolean-typed
}
