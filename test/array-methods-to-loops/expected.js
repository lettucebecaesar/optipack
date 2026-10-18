// S5: array-method inlining inside a hot tick handler.
import { world, system } from '@minecraft/server';
const tags = ['a', 'bb', 'ccc'];
function onTick() {
  const _opArr = tags;
  for (let _opI = 0; _opI < _opArr.length; _opI++) {
    const t = _opArr[_opI];
    world.sendMessage('tag:' + t);
  }
  const _opArr2 = tags;
  const _opAcc2 = [];
  for (let _opI2 = 0; _opI2 < _opArr2.length; _opI2++) {
    const t = _opArr2[_opI2];
    _opAcc2.push(t + '!');
  }
  const doubled = _opAcc2;
  world.setDynamicProperty('doubled', doubled.join(','));
  const _opArr3 = tags;
  const _opAcc3 = [];
  for (let _opI3 = 0; _opI3 < _opArr3.length; _opI3++) {
    const t = _opArr3[_opI3];
    if (t.length > 1) _opAcc3.push(t);
  }
  const longs = _opAcc3;
  world.setDynamicProperty('longs', longs.length);
  const _opArr4 = tags;
  let _opRes4 = false;
  for (let _opI4 = 0; _opI4 < _opArr4.length; _opI4++) {
    const t = _opArr4[_opI4];
    if (t === 'bb') {
      _opRes4 = true;
      break;
    }
  }
  const hasBb = _opRes4;
  const _opArr5 = tags;
  let _opRes5 = true;
  for (let _opI5 = 0; _opI5 < _opArr5.length; _opI5++) {
    const t = _opArr5[_opI5];
    if (!(t.length < 5)) {
      _opRes5 = false;
      break;
    }
  }
  const allShort = _opRes5;
  const _opArr6 = tags;
  let _opRes6;
  for (let _opI6 = 0; _opI6 < _opArr6.length; _opI6++) {
    const t = _opArr6[_opI6];
    if (t.length === 3) {
      _opRes6 = t;
      break;
    }
  }
  const found = _opRes6;
  world.setDynamicProperty('checks', String(hasBb) + String(allShort) + String(found));
}
system.runInterval(onTick, 20);
