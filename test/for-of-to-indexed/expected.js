// S4: for-of conversion over provably-array iterables.
const names = ['a', 'b', 'c'];
export function sumLengths() {
  let n = 0;
  for (let _opI = 0; _opI < names.length; _opI++) {
    const v = names[_opI];
    {
      n += v.length;
    }
  }
  return n;
}
export function letters() {
  let s = 0;
  {
    const _opArr = 'hello'.split('');
    for (let _opI2 = 0; _opI2 < _opArr.length; _opI2++) {
      const ch = _opArr[_opI2];
      {
        if (ch === 'l') s += 1;
      }
    }
  }
  return s;
}
export function mapped() {
  const vals = ['a', 'bb'].map(v => v + '!');
  let out = 0;
  for (let _opI3 = 0; _opI3 < vals.length; _opI3++) {
    const v = vals[_opI3];
    {
      out += v.length;
    }
  }
  return out;
}
export function withDestructure(pairs) {
  const entries = Object.entries({
    a: 1,
    b: 2
  });
  let total = 0;
  for (let _opI4 = 0; _opI4 < entries.length; _opI4++) {
    const _opEl = entries[_opI4];
    const k = _opEl[0];
    const v = _opEl[1];
    {
      total += v;
    }
  }
  return total;
}

// Host returns are never converted (bail).
export function hostIter(players) {
  for (const p of players) {
    p.x = 1;
  }
}
