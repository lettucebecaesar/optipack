// R2: JSON.parse on a constant string folded to a module const (risky).
import { world } from '@minecraft/server';
const _opJson = JSON.parse('{"region":"eu","retries":3,"features":["a","b"]}');
export function describeConfig() {
  return _opJson.region + ':' + _opJson.retries + ':' + _opJson.features.length;
}

// Reassignment of the parsed object: bails.
const MUT = JSON.parse('{"n":1}');
export function bump() {
  MUT.n = 2;
  return MUT.n;
}
world.sendMessage(describeConfig());
