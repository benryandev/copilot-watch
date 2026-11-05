import test from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs'; import { resolve } from 'node:path';
import { RACE_TRACKS, raceTrack, openTracks } from '../src/race-tracks.js';
// src/tracks.json is a copy; edits belong in copilot-check (then `pnpm sync-tracks`).
test('the registry is read from src/tracks.json and the Raceway is pinned to the 1 Nov constants', () => {
  assert.deepEqual(RACE_TRACKS['realfi-v1'], { name: 'RealFi Raceway', checkpoints: [211, 300, 420, 500, 550], length: 642, minMs: 22138, maxSpeed: 29, segMaxSpeed: 36 });
  assert.equal(raceTrack('realfi-v1'), RACE_TRACKS['realfi-v1']); assert.equal(raceTrack('nope'), null);
});
test('a track without limits is not open: it is absent from RACE_TRACKS and raceTrack returns null', () => {
  const full = { name: 'Y', checkpoints: [10, 20], length: 30, minMs: 1000, maxSpeed: 29, segMaxSpeed: 36 };
  const t = openTracks({ 'x-v1': { name: 'X', checkpoints: [10, 20], length: 30 }, 'y-v1': full });
  assert.deepEqual(Object.keys(t), ['y-v1']);
  for (const k of ['minMs', 'maxSpeed', 'segMaxSpeed', 'length', 'checkpoints']) {
    const { [k]: _, ...rest } = full;
    assert.deepEqual(Object.keys(openTracks({ z: rest })), [], `missing ${k}`);
  }
  assert.deepEqual(Object.keys(openTracks({ a: { ...full, checkpoints: [20, 10] }, b: { ...full, checkpoints: [10, 30] }, c: { ...full, maxSpeed: 0 }, d: { ...full, length: 30.5 } })), []);
  assert.equal(raceTrack('toString'), null);
});
test('sanity: checkpoints increasing and inside the lap, minMs at most length / maxSpeed × 1000 × 1.05', () => {
  for (const [id, t] of Object.entries(RACE_TRACKS)) {
    assert.ok(t.checkpoints.every((c, i) => c > 0 && c < t.length && (i === 0 || c > t.checkpoints[i - 1])), id);
    assert.ok(t.minMs <= t.length / t.maxSpeed * 1000 * 1.05, id);
  }
});
test("src/tracks.json matches the site's copy (skipped when no sibling checkout is present)", (t) => {
  const root = resolve(import.meta.dirname, '..');
  const c = [process.env.CHECK_DIR && resolve(process.env.CHECK_DIR, 'ecosystem/tracks/tracks.json'),
    resolve(root, '../copilot-check-registry/ecosystem/tracks/tracks.json'), resolve(root, '../copilot-check/ecosystem/tracks/tracks.json')].filter(Boolean);
  const sib = c.find(existsSync);
  if (!sib) return t.skip('no copilot-check checkout beside this one');
  assert.equal(readFileSync(resolve(root, 'src/tracks.json'), 'utf8'), readFileSync(sib, 'utf8'));
});
