import test from 'node:test'; import assert from 'node:assert/strict';
import { pickName, isReserved, RESERVED } from '../src/world.js';

test('pickName: clean names pass, reserved and rude fall back, owner may be Ben', () => {
  assert.deepEqual(pickName('Aveli'), { name: 'Aveli', fallback: false });
  assert.deepEqual(pickName('Shan', { next: () => '07' }), { name: 'Driver 07', fallback: true });
  assert.deepEqual(pickName('Sh@n'), { name: 'Driver 01', fallback: true });
  assert.deepEqual(pickName('STRIKE team'), { name: 'Driver 01', fallback: true });
  assert.deepEqual(pickName('Ben', { owner: true }), { name: 'Ben', fallback: false });
  assert.deepEqual(pickName('Ben'), { name: 'Driver 01', fallback: true });
  assert.deepEqual(pickName('fuck'), { name: 'Driver 01', fallback: true });
  assert.deepEqual(pickName(undefined), { name: 'Driver 01', fallback: true });
  assert.deepEqual(pickName('x'.repeat(21)), { name: 'Driver 01', fallback: true });
  assert.ok(RESERVED.includes('shan'));
  assert.equal(isReserved('Bén Ryan'), true);
  assert.equal(isReserved('Benny'), false);
});

test('pickName: live duplicates get (2), (3); the fallback skips taken numbers', () => {
  assert.equal(pickName('Aveli', { taken: new Set(['aveli']) }).name, 'Aveli (2)');
  assert.equal(pickName('Aveli', { taken: new Set(['aveli', 'aveli (2)']) }).name, 'Aveli (3)');
  let n = 0; const next = () => String(++n).padStart(2, '0');
  assert.equal(pickName(null, { taken: new Set(['driver 01']), next }).name, 'Driver 02');
});
