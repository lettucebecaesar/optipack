// S4: for-of conversion over provably-array iterables.
const names = ['a', 'b', 'c'];

export function sumLengths() {
  let n = 0;
  for (const v of names) {
    n += v.length;
  }
  return n;
}

export function letters() {
  let s = 0;
  for (const ch of 'hello'.split('')) {
    if (ch === 'l') s += 1;
  }
  return s;
}

export function mapped() {
  const vals = ['a', 'bb'].map((v) => v + '!');
  let out = 0;
  for (const v of vals) {
    out += v.length;
  }
  return out;
}

export function withDestructure(pairs) {
  const entries = Object.entries({ a: 1, b: 2 });
  let total = 0;
  for (const [k, v] of entries) {
    total += v;
  }
  return total;
}

// Host returns are never converted (bail).
export function hostIter(players) {
  for (const p of players) {
    p.x = 1;
  }
}
