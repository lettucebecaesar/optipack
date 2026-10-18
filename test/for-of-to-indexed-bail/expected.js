// S4 bails: Map/Set/strings/host returns are never converted.
const m = new Map();
export function mapIter(m2) {
  for (const [k, v] of m2) {
    m.set(k, v);
  }
}
export function stringIter(s) {
  let n = 0;
  for (const ch of s) {
    n += 1;
  }
  return n;
}
export function hostReturns(players) {
  for (const p of worldPlayers()) {
    p.ping = 1;
  }
  for (const p of players) {
    p.pong = 2;
  }
}
function worldPlayers() {
  return [];
}
