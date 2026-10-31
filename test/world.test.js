import test from 'node:test'; import assert from 'node:assert/strict';
import { pickName, isReserved, RESERVED, parsePose, WORLD_RADIUS, WORLD_MAX_SPEED, WORLD_FRAME_MAX } from '../src/world.js';

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

test('parsePose: accepts a rounded in-bounds pose, rejects garbage', () => {
  assert.deepEqual(parsePose({ t: 'p', x: 12.34, z: -98.16, h: 1.571, s: 9.44 }), { ok: true, x: 12.3, z: -98.2, h: 1.57, s: 9.4, j: false });
  assert.equal(parsePose({ t: 'p', x: 1, z: 1, h: 0, s: 0, j: 1 }).j, true);
  assert.equal(parsePose({ t: 'p', x: 1, z: 1, h: 0, s: 0, j: true }).j, true);
  assert.equal(parsePose({ t: 'p', x: 0, z: 0, h: 4, s: 0 }).h, 4 - 2 * Math.PI > -Math.PI ? Math.round((4 - 2 * Math.PI) * 100) / 100 : 4);
  assert.equal(parsePose({ t: 'p', x: 0, z: 0, h: 0, s: 40.3 }).s, 40);
  for (const bad of [{ x: NaN, z: 0, h: 0, s: 0 }, { x: '1', z: 0, h: 0, s: 0 }, { x: 1e9, z: 0, h: 0, s: 0 }, { x: 0, z: 0, h: 0, s: 41 },
    { x: 0, z: 0, h: 0, s: -1 }, { x: 401, z: 0, h: 0, s: 0 }, null, 'p', { x: 0, z: 0, h: Infinity, s: 0 }, { x: 0, z: 0, s: 0 }])
    assert.equal(parsePose(bad).ok, false, JSON.stringify(bad));
  assert.equal(WORLD_RADIUS, 400); assert.equal(WORLD_MAX_SPEED, 40); assert.equal(WORLD_FRAME_MAX, 256);
});
