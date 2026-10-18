// optipack example — drop tables and dynamic property loops.
// Constant JSON folded at build time when R2 (json-fold) is enabled.

const DROP_TABLE = JSON.parse('{"common":["apple","bread"],"rare":["diamond"]}');

export function buildDropSummary(count) {
  const items = DROP_TABLE.common;
  let out = '';
  for (let i = 0; i < items.length && i < count; i++) {
    out += items[i] + ';';
  }
  return out;
}

// Hot loop re-reading dynamic properties: the B4 pattern when called per-tick.
export function pollDropState(entity) {
  let picked = 0;
  for (let i = 0; i < 3; i++) {
    if (entity.getDynamicProperty('optipack:drops') !== undefined) {
      picked = picked + 1;
    }
  }
  return picked;
}
