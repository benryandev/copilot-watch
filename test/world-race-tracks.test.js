// A live race runs on the host's track (7 Nov 2026): race.open names the track, the room keeps it, counts its checkpoints,
// and sends a race on any track but RealFi only to clients that said in their hi they know about tracks.
import test from 'node:test'; import assert from 'node:assert/strict';
import { Room, WORLD_RACE_TRACKS, RACE_CHECKPOINTS, RACE_JOIN_MS } from '../src/world.js';
import { RACE_TRACKS } from '../src/race-tracks.js';

const room = o => new Room({ ownerToken: 'own', ...o });
const to = (out, id) => out.filter(([i]) => i === id).map(([, m]) => m);
const NEW = { raceTracks: true };
const hi = (r, id, name, now = 0, extra = NEW) => { r.open(id, { ipKey: 'k' + id }, now); return r.onMessage(id, JSON.stringify({ t: 'hi', v: 1, name, ...extra }), now); };
const send = (r, id, m, now) => r.onMessage(id, JSON.stringify(m), now);
const TRACK_ERR = { t: 'err', error: 'race_track', why: 'Live races run on the RealFi Raceway and The Lagoon' };
const OLD_ERR = { t: 'err', error: 'race_zone', why: 'A race is on at The Lagoon. Reload the page to join it' };
/** n new clients, p0 opens on `track`, the rest join, and the race goes running. */
function running(track, n = 2) {
  const r = room(); for (let i = 0; i < n; i++) hi(r, 'p' + i, 'P' + i);
  send(r, 'p0', { t: 'race.open', track }, 0); for (let i = 1; i < n; i++) send(r, 'p' + i, { t: 'race.join' }, i);
  r.timers(17_000); r.timers(20_000); assert.equal(r.race.state, 'running'); return r;
}

test('the hub race tracks are RealFi and the Lagoon, each open in the registry', () => {
  assert.deepEqual([...WORLD_RACE_TRACKS], ['realfi-v1', 'lagoon-v2']); assert.ok(Object.isFrozen(WORLD_RACE_TRACKS));
  for (const id of WORLD_RACE_TRACKS) assert.ok(RACE_TRACKS[id], id);
  assert.equal(RACE_CHECKPOINTS, 5, 'RealFi\'s count, as before');
});

test('race.open on each hub track opens a race on it, and the race reports its track to everyone', () => {
  for (const track of WORLD_RACE_TRACKS) {
    const r = room(); hi(r, 'a', 'A'); hi(r, 'b', 'B');
    const { out, raceChanged } = send(r, 'a', { t: 'race.open', track }, 1000);
    assert.equal(raceChanged, true); assert.equal(r.race.track, track);
    const o = to(out, 'b').find(m => m.t === 'race.open');
    assert.equal(o.track, track); assert.equal(o.startsAt, 1000 + RACE_JOIN_MS);
    const late = to(hi(r, 'c', 'C', 2000).out, 'c').find(m => m.t === 'ok');
    assert.equal(late.race.track, track, 'a late arrival hears the track too');
  }
});

test('race.open with a junk, unknown, venue-only or retired track, or none from a new client, is refused and nobody moves', () => {
  for (const track of [undefined, null, '', 7, {}, ['lagoon-v2'], 'Lagoon', 'evil-zone', 'lagoon-v1', 'x'.repeat(40)]) {
    const r = room(); hi(r, 'a', 'A'); hi(r, 'b', 'B');
    const res = send(r, 'a', { t: 'race.open', ...(track === undefined ? {} : { track }) }, 1000);
    assert.deepEqual(res, { out: [['a', TRACK_ERR]] }, JSON.stringify(track)); assert.equal(r.race, null);
    assert.equal(r.players.get('a').bad, 0, 'a refused open is not a bad frame');
  }
  // venue-only: a track in the registry that the hub does not race on (the list is a constructor seam)
  const r = room({ raceTracks: ['realfi-v1'] }); hi(r, 'a', 'A');
  assert.deepEqual(send(r, 'a', { t: 'race.open', track: 'lagoon-v2' }, 1000), { out: [['a', { ...TRACK_ERR, why: 'Live races run on the RealFi Raceway' }]] }, 'the note names the tracks this room races');
  assert.equal(r.race, null);
  assert.equal(send(r, 'a', { t: 'race.open', track: 'realfi-v1' }, 2000).raceChanged, true);
});

test('an old client (no raceTracks in hi) opens without a track: the race is on RealFi, as before', () => {
  const r = room(); hi(r, 'old', 'Old', 0, {}); hi(r, 'b', 'B');
  const { out } = send(r, 'old', { t: 'race.open' }, 1000);
  assert.equal(r.race.track, 'realfi-v1'); assert.equal(to(out, 'b')[0].track, 'realfi-v1');
  const r2 = room(); hi(r2, 'old', 'Old', 0, { raceTracks: 1 }); // strict: only true counts
  send(r2, 'old', { t: 'race.open' }, 1000); assert.equal(r2.race.track, 'realfi-v1');
});

test('checkpoints count per track: a Lagoon race needs 11 to finish, a RealFi race 5', () => {
  for (const [track, n] of [['lagoon-v2', 11], ['realfi-v1', 5]]) {
    assert.equal(RACE_TRACKS[track].checkpoints.length, n);
    const r = running(track);
    for (let i = 1; i <= n - 1; i++) send(r, 'p0', { t: 'race.cp', i }, 21_000 + i * 100);
    assert.deepEqual(send(r, 'p0', { t: 'race.fin', ms: 30_000 }, 40_000).out, [], `${track}: a checkpoint short, no finish`);
    assert.equal(send(r, 'p0', { t: 'race.cp', i: n }, 41_000).out.length, 2);
    assert.deepEqual(send(r, 'p0', { t: 'race.cp', i: n + 1 }, 41_500).out, [], `${track}: no checkpoint past the last`);
    const f = send(r, 'p0', { t: 'race.fin', ms: 30_000 }, 42_000);
    assert.equal(r.race.entrants.get('p0').fin.ms, 30_000, `${track}: finished`);
    assert.equal(to(f.out, 'p1').find(m => m.t === 'race.pos').order[0].cp, n);
  }
});

test('old clients neither hear nor join a Lagoon race, and the invite on hi skips them; RealFi races reach everyone', () => {
  const r = room(); hi(r, 'a', 'A'); hi(r, 'old', 'Old', 0, {});
  const open = send(r, 'a', { t: 'race.open', track: 'lagoon-v2' }, 0);
  assert.deepEqual(to(open.out, 'old'), [], 'no invite');
  assert.deepEqual(send(r, 'old', { t: 'race.join' }, 100), { out: [['old', OLD_ERR]] }, 'a join is refused');
  assert.deepEqual(send(r, 'old', { t: 'race.open' }, 1200), { out: [['old', OLD_ERR]] }, 'an open while it is on joins nothing either');
  assert.equal(r.race.entrants.size, 1);
  assert.equal(to(hi(r, 'old2', 'Old2', 200, {}).out, 'old2').find(m => m.t === 'ok').race, null, 'an old arrival sees no race');
  hi(r, 'b', 'B', 300); const g = send(r, 'b', { t: 'race.join' }, 400);
  assert.deepEqual(to(g.out, 'old'), [], 'no grid'); assert.equal(to(g.out, 'a').length, 1);
  const go = r.timers(17_000); assert.deepEqual(to(go.out, 'old'), [], 'no go'); assert.equal(to(go.out, 'b')[0].t, 'race.go');
  r.timers(20_000);
  const pos = send(r, 'a', { t: 'race.cp', i: 1 }, 21_000); assert.deepEqual(to(pos.out, 'old'), [], 'no positions');
  // RealFi: old clients hear it and can join
  const r2 = room(); hi(r2, 'a', 'A'); hi(r2, 'old', 'Old', 0, {});
  const o2 = send(r2, 'a', { t: 'race.open', track: 'realfi-v1' }, 0);
  assert.equal(to(o2.out, 'old')[0].t, 'race.open');
  const j2 = send(r2, 'old', { t: 'race.join' }, 100);
  assert.equal(to(j2.out, 'old')[0].t, 'race.grid'); assert.equal(r2.race.entrants.size, 2);
  const c2 = r2.timers(17_000); assert.equal(to(c2.out, 'old')[0].t, 'race.go');
  // a cancelled Lagoon race tells only the new clients
  const r3 = room(); hi(r3, 'a', 'A'); hi(r3, 'old', 'Old', 0, {});
  send(r3, 'a', { t: 'race.open', track: 'lagoon-v2' }, 0);
  const c3 = r3.timers(17_000); assert.equal(to(c3.out, 'a')[0].t, 'race.cancel'); assert.deepEqual(to(c3.out, 'old'), []);
});

test('the raceTracks flag survives a wake-up through the attachment, and only true is kept', () => {
  const r = room(); hi(r, 'a', 'A'); hi(r, 'old', 'Old', 0, {}); hi(r, 'junk', 'J', 0, { raceTracks: 'yes' });
  assert.equal(r.attachment('a').rt, 1); assert.equal('rt' in r.attachment('old'), false); assert.equal('rt' in r.attachment('junk'), false);
  const r2 = room(); r2.restore(['a', 'old', 'junk'].map(id => r.attachment(id)));
  const o = send(r2, 'a', { t: 'race.open', track: 'lagoon-v2' }, 0);
  assert.deepEqual(o.out.map(([id]) => id), ['a'], 'only the flagged player hears a Lagoon race after the wake-up');
});

test('raceState/restoreRace keep the track; a stored race with no track is RealFi, one on a track not raced is dropped', () => {
  const r = running('lagoon-v2');
  const snap = JSON.parse(JSON.stringify(r.raceState()));
  assert.equal(snap.track, 'lagoon-v2');
  const r2 = room(); hi(r2, 'p0', 'P0'); hi(r2, 'p1', 'P1'); r2.restoreRace(snap, 30_000);
  assert.equal(r2.race.track, 'lagoon-v2');
  for (let i = 1; i <= 11; i++) send(r2, 'p0', { t: 'race.cp', i }, 30_000 + i);
  send(r2, 'p0', { t: 'race.fin', ms: 30_000 }, 31_000);
  assert.ok(r2.race.entrants.get('p0').fin, 'the restored Lagoon race still counts 11');
  const late = to(hi(r2, 'c', 'C', 32_000).out, 'c').find(m => m.t === 'ok'); assert.equal(late.race.track, 'lagoon-v2');
  const { track, ...noTrack } = snap; // a race stored before this deploy
  const r3 = room(); hi(r3, 'p0', 'P0'); hi(r3, 'p1', 'P1'); r3.restoreRace(noTrack, 30_000);
  assert.equal(r3.race.track, 'realfi-v1');
  const r4 = room(); hi(r4, 'p0', 'P0'); hi(r4, 'p1', 'P1'); r4.restoreRace({ ...snap, track: 'lagoon-v1' }, 30_000);
  assert.equal(r4.race, null);
});

test('still one race at a time: a Lagoon race open makes a RealFi open a join', () => {
  const r = room(); hi(r, 'a', 'A'); hi(r, 'b', 'B');
  send(r, 'a', { t: 'race.open', track: 'lagoon-v2' }, 0);
  const j = send(r, 'b', { t: 'race.open', track: 'realfi-v1' }, 100);
  assert.equal(to(j.out, 'b')[0].t, 'race.grid'); assert.equal(r.race.track, 'lagoon-v2'); assert.equal(r.race.entrants.size, 2);
});
