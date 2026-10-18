// S2: dead code shapes.
export function f(x) {
  return x;
  console.log('dead');
}
export function g() {
  if (true) {
    return 1;
  } else {
    return 2;
  }
}
export function w() {
  while (false) {
    sideEffect();
  }
  return 'after';
}
const unused = 1 + 2;
const kept = 3;
export function h() {
  return kept;
}
