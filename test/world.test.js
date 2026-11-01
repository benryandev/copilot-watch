import test from 'node:test'; import assert from 'node:assert/strict';
import { pickName, isReserved, RESERVED, parsePose, WORLD_RADIUS, WORLD_MAX_SPEED, WORLD_FRAME_MAX, Room, WORLD_MAX, WORLD_IP_MAX, COLOURS, offChecker, WORLD_FLOOD_BLOCK_MS, WORLD_IDLE_MS, RACE_JOIN_MS, RACE_GRID, RACE_GO_LEAD_MS, RACE_CLOSE_MS, RACE_KEEP_MS, RACE_CHECKPOINTS, RACE_MAX_RUN_MS, EMOTE_COUNT, EMOTE_MAX_HZ } from '../src/world.js';

test('pickName: clean names pass, reserved and rude fall back, owner may be Ben', () => {
  assert.deepEqual(pickName('Aveli'), { name: 'Aveli', fallback: false });
  assert.deepEqual(pickName('BenRyan', { next: () => '07' }), { name: 'Driver 07', fallback: true, reason: 'reserved' });
  assert.deepEqual(pickName('B3n Ry@n'), { name: 'Driver 01', fallback: true, reason: 'reserved' });
  assert.deepEqual(pickName('Strike team'), { name: 'Strike team', fallback: false }); // free since 31 Oct
  assert.deepEqual(pickName('BenRyan', { owner: true }), { name: 'BenRyan', fallback: false });
  assert.deepEqual(pickName('Ben'), { name: 'Ben', fallback: false }); assert.deepEqual(pickName('Shan'), { name: 'Shan', fallback: false }); // another Ben or Shan may be themselves
  assert.deepEqual(pickName('fuck'), { name: 'Driver 01', fallback: true, reason: 'rude' });
  assert.deepEqual(pickName(undefined), { name: 'Driver 01', fallback: true, reason: 'bad' });
  assert.deepEqual(pickName('x'.repeat(21)), { name: 'Driver 01', fallback: true, reason: 'bad' });
  assert.deepEqual(RESERVED, ['benryan', 'benryanme']); assert.equal(isReserved('Shan'), false);
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

// ---- the room ----
const room = o => new Room({ ownerToken: 'own', ...o });
const hi = (r, id, name, now = 0, extra = {}) => { r.open(id, { ipKey: 'k' + id }, now); return r.onMessage(id, JSON.stringify({ t: 'hi', v: 1, name, ...extra }), now); };
const to = (out, id) => out.filter(([i]) => i === id).map(([, m]) => m);
const pose = (r, id, now, over = {}) => r.onMessage(id, JSON.stringify({ t: 'p', x: 1, z: 2, h: 0.5, s: 3, ...over }), now);
const snaps = out => out.filter(([, m]) => m.t === 's');

test('room: hi joins, replies ok with peers, tells the others, counts', () => {
  const r = room(); hi(r, 'a', 'BenRyan');
  const { out } = hi(r, 'b', 'Aveli', 10);
  const ok = to(out, 'b').find(m => m.t === 'ok');
  assert.equal(ok.id, 'b'); assert.equal(ok.name, 'Aveli'); assert.equal(ok.now, 10);
  assert.equal(ok.peers.length, 1); assert.equal(ok.peers[0].name, 'Driver 01'); assert.equal(ok.peers[0].id, 'a');
  assert.deepEqual(to(out, 'a').map(m => m.t), ['join', 'n']);
  assert.equal(to(out, 'a')[1].online, 2); assert.equal(r.online(), 2);
  assert.deepEqual(r.attachment('b'), { id: 'b', name: 'Aveli', colour: ok.colour, ipKey: 'kb', since: 10, heardAt: 10 });
});

test('room: owner token lets Ben be Ben; colours differ for the first eight', () => {
  const r = room(); const { out } = hi(r, 'a', 'BenRyan', 0, { owner: 'own' });
  assert.equal(to(out, 'a')[0].name, 'BenRyan');
  assert.equal(to(hi(r, 'z', 'BenRyan', 0, { owner: 'wrong' }).out, 'z')[0].name, 'Driver 01');
  const cols = new Set(); for (let i = 0; i < 8; i++) cols.add(to(hi(r, 'p' + i, 'P' + i).out, 'p' + i)[0].colour);
  assert.equal(cols.size, 8); assert.equal(COLOURS.length, 8);
});

test('room: poses are coalesced into 100 ms snapshots for everyone, movers only', () => {
  const r = room(); hi(r, 'a', 'A'); hi(r, 'b', 'B');
  const first = pose(r, 'a', 0);
  assert.equal(snaps(first.out).length, 2); assert.equal(snaps(first.out)[0][1].p.length, 1); assert.equal(first.flushIn, undefined);
  const second = pose(r, 'b', 50);
  assert.equal(second.out.length, 0); assert.equal(second.flushIn, 50);
  assert.equal(pose(r, 'a', 60, { x: 5 }).flushIn, 40);
  const f = r.flush(100);
  assert.deepEqual(f.out.map(([id]) => id).sort(), ['a', 'b']);
  const s = f.out[0][1]; assert.equal(s.t, 's'); assert.equal(s.now, 100); assert.equal(s.p.length, 2);
  assert.deepEqual(s.p.find(p => p[0] === 'a'), ['a', 5, 2, 0.5, 3, 0]);
  assert.equal(r.flush(200).out.length, 0);
});

test('room: a jump flag survives into the snapshot once and is rate-limited to one per second', () => {
  const r = room(); hi(r, 'a', 'A');
  // Each pose is over 100 ms after the last, so each flushes at once
  const j = (now) => snaps(pose(r, 'a', now, { j: 1 }).out)[0][1].p[0][5];
  assert.equal(j(0), 1); assert.equal(j(500), 0); assert.equal(j(1100), 1);
});

test('room: garbage frames count, three in a row close, a good one resets', () => {
  const r = room(); hi(r, 'a', 'A'); hi(r, 'b', 'B');
  assert.equal(r.onMessage('a', 'x', 0).close, undefined);
  assert.equal(r.onMessage('a', '{"t":"zz"}', 1).close, undefined);
  assert.equal(pose(r, 'a', 2).close, undefined); // resets
  r.onMessage('a', 'x', 3); r.onMessage('a', '{"t":"p","x":"no"}', 4);
  assert.equal(r.onMessage('a', '[]', 5).close, 'bad');
  r.close('a', 6);
  assert.equal(r.online(), 1);
});

test('room: a pose before hi is bad', () => {
  const r = room(); r.open('a', { ipKey: 'ka' }, 0);
  assert.equal(pose(r, 'a', 0).close, undefined); pose(r, 'a', 1);
  assert.equal(pose(r, 'a', 2).close, 'bad');
});

test('room: pose floods over 20 Hz are dropped, not fatal', () => {
  const r = room(); hi(r, 'a', 'A');
  let landed = 0, closed = false;
  for (let i = 0; i < 30; i++) { const res = pose(r, 'a', i * 33, { x: i }); if (res.close) closed = true; for (const [, m] of snaps(res.out)) landed += m.p.length; }
  landed += r.flush(1000).out.reduce((n, [, m]) => n + m.p.length, 0);
  assert.equal(closed, false);
  assert.ok(landed <= 20, `landed ${landed}`); assert.ok(landed >= 5, `landed ${landed}`);
});

test('room: a frame over 256 bytes is bad', () => {
  const r = room(); hi(r, 'a', 'A');
  const big = JSON.stringify({ t: 'p', x: 1, z: 1, h: 0, s: 0, pad: 'x'.repeat(300) });
  r.onMessage('a', big, 0); r.onMessage('a', big, 1);
  assert.equal(r.onMessage('a', big, 2).close, 'bad');
});

test('room: rename is filtered, rate-limited and broadcast', () => {
  const r = room(); hi(r, 'a', 'A'); hi(r, 'b', 'B');
  const { out } = r.onMessage('a', JSON.stringify({ t: 'name', name: 'Aveli' }), 1000);
  assert.deepEqual(to(out, 'a'), [{ t: 'named', name: 'Aveli' }]);
  assert.deepEqual(to(out, 'b'), [{ t: 'rename', id: 'a', name: 'Aveli' }]);
  assert.deepEqual(to(r.onMessage('a', JSON.stringify({ t: 'name', name: 'Other' }), 6000).out, 'a'), [{ t: 'err', error: 'rate' }]);
  assert.equal(to(r.onMessage('a', JSON.stringify({ t: 'name', name: 'BenRyan' }), 11000).out, 'a')[0].name, 'Driver 01');
  assert.equal(r.who().find(p => p.id === 'a').name, 'Driver 01');
});

test('room: duplicates and fallbacks resolve across joins', () => {
  const r = room();
  assert.equal(to(hi(r, 'a', 'Aveli').out, 'a')[0].name, 'Aveli');
  assert.equal(to(hi(r, 'b', 'Aveli').out, 'b')[0].name, 'Aveli (2)');
  assert.equal(to(hi(r, 'c').out, 'c')[0].name, 'Driver 01');
  assert.equal(to(hi(r, 'd').out, 'd')[0].name, 'Driver 02');
});

test('room: close broadcasts leave and count; a leaver frees their name', () => {
  const r = room(); hi(r, 'a', 'Aveli'); hi(r, 'b', 'B');
  const { out } = r.close('a', 5);
  assert.deepEqual(to(out, 'b'), [{ t: 'leave', id: 'a' }, { t: 'n', online: 1 }]);
  assert.equal(to(hi(r, 'c', 'Aveli', 6).out, 'c')[0].name, 'Aveli');
  assert.equal(r.close('zz', 7).out.length, 0);
});

test('room: open refuses when full, over 4 per ip, or blocked', () => {
  const r = room();
  for (let i = 0; i < WORLD_MAX; i++) assert.equal(r.open('p' + i, { ipKey: 'ip' + i }, 0).ok, true);
  assert.deepEqual(r.open('late', { ipKey: 'ipx' }, 0), { ok: false, error: 'full' });
  const r2 = room();
  for (let i = 0; i < WORLD_IP_MAX; i++) assert.equal(r2.open('s' + i, { ipKey: 'same' }, 0).ok, true);
  assert.deepEqual(r2.open('s9', { ipKey: 'same' }, 0), { ok: false, error: 'ip' });
  hi(r2, 'v', 'Victim', 0);
  const k = r2.kick({ id: 'v' }, 30, 1000);
  assert.deepEqual(k.closed, ['v']);
  assert.deepEqual(r2.open('v', { ipKey: 'fresh' }, 2000), { ok: false, error: 'blocked' });
  assert.deepEqual(r2.open('other', { ipKey: 'kv' }, 2000), { ok: false, error: 'blocked' });
  assert.equal(r2.open('other', { ipKey: 'kv' }, 1000 + 30 * 60_000 + 1).ok, true);
  assert.equal(new Room({ blocks: k.blocks }).open('v', { ipKey: 'x' }, 2000).error, 'blocked');
});

test('room: kick by name closes every match and returns persistent blocks', () => {
  const r = room(); hi(r, 'a', 'Aveli'); hi(r, 'b', 'aveli'); hi(r, 'c', 'C'); // b wears "aveli (2)"
  const k = r.kick({ name: 'AVELI' }, 60, 0);
  assert.deepEqual(k.closed.sort(), ['a', 'b']);
  assert.deepEqual(Object.keys(k.blocks).sort(), ['i:ka', 'i:kb', 's:a', 's:b']);
  assert.equal(r.online(), 1);
  assert.deepEqual(to(k.out, 'c').map(m => m.t), ['leave', 'n', 'leave', 'n']);
});

test('room: restore rebuilds the roster from attachments and the next snapshot reaches all', () => {
  const r = room(); hi(r, 'a', 'A'); hi(r, 'b', 'B');
  const r2 = room(); r2.restore(['a', 'b'].map(id => r.attachment(id)));
  assert.equal(r2.online(), 2);
  assert.deepEqual(r2.who().map(p => p.name), ['A', 'B']);
  const { out } = pose(r2, 'a', 5000);
  assert.deepEqual(snaps(out).map(([id]) => id).sort(), ['a', 'b']);
  assert.equal(to(hi(r2, 'c', 'A', 6000).out, 'c')[0].name, 'A (2)');
});

test('room: who() never includes ipKey', () => {
  const r = room(); hi(r, 'a', 'A'); pose(r, 'a', 0);
  const w = r.who()[0];
  assert.deepEqual(Object.keys(w).sort(), ['colour', 'id', 'name', 'since', 'x', 'z']);
  assert.equal(w.x, 1);
});

test('offChecker: reads the switch at most once per ttl and remembers the answer', async () => {
  let reads = 0, value = null;
  const paused = offChecker(async () => { reads++; return value; }, 30_000);
  assert.equal(await paused(0), false); assert.equal(await paused(10_000), false); assert.equal(reads, 1);
  value = '1';
  assert.equal(await paused(29_999), false); assert.equal(await paused(30_000), true); assert.equal(reads, 2);
  value = null;
  assert.equal(await paused(59_000), true); assert.equal(await paused(61_000), false); assert.equal(reads, 3);
});

// ---- review fixes ----
test('isReserved: Cyrillic and Greek look-alikes count', () => {
  assert.equal(isReserved('ВenRyan'), true); // Cyrillic capital Ve for B
  assert.equal(isReserved('BеnRyаn'), true); // Cyrillic e and a
  assert.equal(isReserved('ΒеnRyan'), true); // Greek Beta + Cyrillic e
  assert.equal(isReserved('Benny'), false);
  assert.equal(pickName('ВenRyan').name, 'Driver 01');
});

test('room: ping storms and rate-dropped floods close the socket and block the address briefly', () => {
  const r = room(); hi(r, 'a', 'A'); hi(r, 'b', 'B');
  let closed = null;
  for (let i = 0; i < 400 && !closed; i++) { const res = pose(r, 'a', i, { x: i % 50 }); if (res.close) closed = res.close; }
  assert.equal(closed, 'flood');
  r.close('a', 500);
  assert.deepEqual(r.open('a2', { ipKey: 'ka' }, 600), { ok: false, error: 'blocked' });
  assert.equal(r.open('a2', { ipKey: 'ka' }, 600 + WORLD_FLOOD_BLOCK_MS + 1).ok, true);
  assert.equal(r.online(), 1); // b is untouched by a's flood; a2 has opened but not said hi
  const r2 = room(); hi(r2, 'p', 'P');
  closed = null;
  for (let i = 0; i < 400 && !closed; i++) { const res = r2.onMessage('p', JSON.stringify({ t: 'ping', echo: i }), i * 10); if (res.close) closed = res.close; }
  assert.equal(closed, 'flood');
});

test('room: a ping neither resets the bad count nor counts as bad at a sane rate', () => {
  const r = room(); hi(r, 'a', 'A');
  r.onMessage('a', 'x', 0); r.onMessage('a', 'x', 1);
  assert.equal(r.onMessage('a', JSON.stringify({ t: 'ping', echo: 1 }), 2).close, undefined);
  assert.equal(r.onMessage('a', 'x', 3).close, 'bad');
});

test('room: rename with the owner token may take a reserved name', () => {
  const r = room(); hi(r, 'a', 'A');
  assert.equal(to(r.onMessage('a', JSON.stringify({ t: 'name', name: 'BenRyan', owner: 'own' }), 1000).out, 'a')[0].name, 'BenRyan');
  assert.equal(to(r.onMessage('a', JSON.stringify({ t: 'name', name: 'BenRyan', owner: 'nope' }), 20000).out, 'a')[0].name, 'Driver 01');
});

test('room: reap drops sockets silent for over a minute, joined or not, and tells the others', () => {
  const r = room(); hi(r, 'a', 'A', 0); hi(r, 'b', 'B', 0); r.open('c', { ipKey: 'kc' }, 0); // c never says hi
  pose(r, 'b', 30_000);
  assert.deepEqual(r.reap(59_000), { closed: [], out: [] });
  const k = r.reap(61_000);
  assert.deepEqual(k.closed.sort(), ['a', 'c']);
  assert.deepEqual(to(k.out, 'b').map(m => m.t), ['leave', 'n']);
  assert.equal(r.online(), 1);
  assert.deepEqual(r.reap(90_000).closed, []); // b spoke at 30 s
  assert.deepEqual(r.reap(90_001).closed, ['b']);
  assert.equal(WORLD_IDLE_MS, 60_000);
});

test('room: restore keeps when each socket was last heard (from the attachment), so a wake-up cannot refresh a dead one', () => {
  const r = room(); hi(r, 'a', 'A', 0); pose(r, 'a', 40_000);
  assert.equal(r.attachment('a').heardAt, 40_000);
  const r2 = room();
  r2.restore([r.attachment('a'), { id: 'z', name: 'Zombie', colour: '#fff', ipKey: 'kz', since: 0 }], 100_000);
  assert.deepEqual(r2.reap(99_000).closed, ['z']); // never heard since it joined at 0
  assert.deepEqual(r2.reap(100_001).closed, ['a']); // a was last heard at 40 s: over a minute ago now
});

test('room: a rejected rename keeps the Driver number you already wear and says why; a kept name says taken', () => {
  const r = room(); hi(r, 'a'); hi(r, 'b', 'Aveli'); // a is Driver 01
  const first = to(r.onMessage('a', JSON.stringify({ t: 'name', name: 'BenRyan' }), 1000).out, 'a')[0];
  assert.deepEqual(first, { t: 'named', name: 'Driver 01', reason: 'reserved', asked: 'BenRyan' });
  const second = to(r.onMessage('a', JSON.stringify({ t: 'name', name: 'fuck' }), 12000).out, 'a')[0];
  assert.deepEqual(second, { t: 'named', name: 'Driver 01', reason: 'rude', asked: 'fuck' });
  const third = to(r.onMessage('a', JSON.stringify({ t: 'name', name: 'Aveli' }), 23000).out, 'a')[0];
  assert.deepEqual(third, { t: 'named', name: 'Aveli (2)', reason: 'taken', asked: 'Aveli' });
  const fourth = to(r.onMessage('a', JSON.stringify({ t: 'name', name: 'Nova' }), 34000).out, 'a')[0];
  assert.deepEqual(fourth, { t: 'named', name: 'Nova' });
  assert.equal(pickName('BenRyan').reason, 'reserved'); assert.equal(pickName('').reason, 'bad'); assert.equal(pickName('Nova').reason, undefined);
});

test('room: a guest token unlocks only the reserved names it was issued for, on hi and on rename', () => {
  const r = new Room({ ownerToken: 'own', guests: { 'guest-token': ['benryanme'] } });
  assert.equal(to(hi(r, 'a', 'benryanme', 0, { owner: 'guest-token' }).out, 'a')[0].name, 'benryanme');
  assert.equal(to(hi(r, 'b', 'BenRyan', 0, { owner: 'guest-token' }).out, 'b')[0].name, 'Driver 01'); // not theirs to take
  assert.equal(to(hi(r, 'c', 'benryanme', 0, { owner: 'nope' }).out, 'c')[0].name, 'Driver 02');
  assert.equal(to(r.onMessage('b', JSON.stringify({ t: 'name', name: 'benryanme', owner: 'guest-token' }), 1000).out, 'b')[0].name, 'benryanme (2)');
  assert.equal(to(hi(r, 'd', 'Nova', 0, { owner: 'guest-token' }).out, 'd')[0].name, 'Nova'); // ordinary names unaffected
  assert.equal(pickName('benryanme', { allow: new Set(['benryanme']) }).name, 'benryanme');
  assert.equal(pickName('BenRyan', { allow: new Set(['benryanme']) }).name, 'Driver 01');
});

test('room: announce broadcasts a record to everyone joined; bad payloads are refused', () => {
  const r = room(); hi(r, 'a', 'Aveli'); hi(r, 'b', 'Rook'); r.open('c', { ipKey: 'kc' }, 0); // c never said hi
  const { out, ok } = r.announce({ t: 'record', name: 'BigBaws', ms: 24778.4, track: 'realfi-v1' });
  assert.equal(ok, true);
  assert.deepEqual(out.map(([id]) => id).sort(), ['a', 'b']);
  assert.deepEqual(out[0][1], { t: 'record', name: 'BigBaws', ms: 24778, track: 'realfi-v1' });
  for (const bad of [null, {}, { t: 'record', name: '', ms: 1 }, { t: 'record', name: 'x', ms: -1 }, { t: 'record', name: 'x'.repeat(21), ms: 1 }, { t: 'nope', name: 'x', ms: 1 }]) {
    const b = r.announce(bad); assert.equal(b.ok, false, JSON.stringify(bad)); assert.equal(b.out.length, 0);
  }
});

// ---- stage two: live races ----
const raceMsg = (r, id, m, now) => r.onMessage(id, JSON.stringify(m), now);

test('race: open creates a race with the host in slot 1 and tells everyone; a second open while open joins instead', () => {
  const r = room(); hi(r, 'a', 'A'); hi(r, 'b', 'B'); hi(r, 'c', 'C');
  const { out } = raceMsg(r, 'a', { t: 'race.open' }, 1000);
  const o = to(out, 'b').find(m => m.t === 'race.open');
  assert.ok(o); assert.equal(o.host, 'a'); assert.equal(o.name, 'A'); assert.equal(o.startsAt, 1000 + RACE_JOIN_MS);
  assert.deepEqual(o.grid, [{ id: 'a', name: 'A', slot: 1 }]);
  assert.deepEqual(to(out, 'a').map(m => m.t), ['race.open']); assert.deepEqual(to(out, 'c').map(m => m.t), ['race.open']);
  assert.equal(r.race.state, 'open'); assert.equal(o.id, r.race.id); assert.equal(typeof r.race.id, 'string');
  const j = raceMsg(r, 'b', { t: 'race.open' }, 1500);
  const g = to(j.out, 'c').find(m => m.t === 'race.grid');
  assert.deepEqual(g.grid.map(x => [x.id, x.slot]), [['a', 1], ['b', 2]]);
  assert.equal(r.race.state, 'open');
});

test('race: join fills slots in order, the ninth is told race_full and can watch; joining twice is nothing', () => {
  const r = room(); for (let i = 0; i < 10; i++) hi(r, 'p' + i, 'P' + i);
  raceMsg(r, 'p0', { t: 'race.open' }, 0);
  for (let i = 1; i < RACE_GRID; i++) raceMsg(r, 'p' + i, { t: 'race.join' }, i);
  assert.equal(r.grid().length, RACE_GRID); assert.equal(r.grid()[7].slot, 8);
  const { out } = raceMsg(r, 'p8', { t: 'race.join' }, 20);
  assert.deepEqual(out, [['p8', { t: 'err', error: 'race_full' }]]);
  assert.equal(raceMsg(r, 'p1', { t: 'race.join' }, 21).out.length, 0);
});

test('race: leave before Go frees the slot, later slots keep their numbers, the host leaving keeps the race open', () => {
  const r = room(); hi(r, 'a', 'A'); hi(r, 'b', 'B'); hi(r, 'c', 'C');
  raceMsg(r, 'a', { t: 'race.open' }, 0); raceMsg(r, 'b', { t: 'race.join' }, 1); raceMsg(r, 'c', { t: 'race.join' }, 2);
  const { out } = raceMsg(r, 'b', { t: 'race.leave' }, 3);
  assert.deepEqual(to(out, 'a').find(m => m.t === 'race.grid').grid.map(x => [x.id, x.slot]), [['a', 1], ['c', 3]]);
  hi(r, 'd', 'D'); raceMsg(r, 'd', { t: 'race.join' }, 4);
  assert.deepEqual(r.grid().map(x => [x.id, x.slot]), [['a', 1], ['d', 2], ['c', 3]]);
  raceMsg(r, 'a', { t: 'race.leave' }, 5);
  assert.equal(r.race.state, 'open'); assert.deepEqual(r.grid().map(x => x.id), ['d', 'c']);
  assert.equal(raceMsg(r, 'b', { t: 'race.leave' }, 6).out.length, 0);
});

test('race: close(id) of an entrant before Go drops them from the grid and broadcasts race.grid', () => {
  const r = room(); hi(r, 'a', 'A'); hi(r, 'b', 'B'); hi(r, 'c', 'C');
  raceMsg(r, 'a', { t: 'race.open' }, 0); raceMsg(r, 'b', { t: 'race.join' }, 1);
  const { out } = r.close('b');
  assert.ok(to(out, 'c').some(m => m.t === 'race.grid' && m.grid.length === 1));
  assert.ok(to(out, 'c').some(m => m.t === 'leave'));
  assert.equal(r.grid().length, 1);
});

test('race: open or join before hi is bad; join with no race is race_none', () => {
  const r = room(); r.open('x', { ipKey: 'kx' }, 0); hi(r, 'a', 'A');
  assert.deepEqual(raceMsg(r, 'x', { t: 'race.open' }, 1), { out: [] });
  assert.deepEqual(raceMsg(r, 'a', { t: 'race.join' }, 2).out, [['a', { t: 'err', error: 'race_none' }]]);
});

const raceOf = (n, now = 0) => { const r = room(); for (let i = 0; i < n; i++) hi(r, 'p' + i, 'P' + i); raceMsg(r, 'p0', { t: 'race.open' }, now); for (let i = 1; i < n; i++) raceMsg(r, 'p' + i, { t: 'race.join' }, now + i); return r; };
const running = (n) => { const r = raceOf(n); r.timers(17_000); r.timers(20_000); return r; };
const cp = (r, id, i, now) => raceMsg(r, id, { t: 'race.cp', i }, now);
const fin = (r, id, ms, now) => raceMsg(r, id, { t: 'race.fin', ms }, now);
const lapTo = (r, id, upTo, from) => { for (let i = 1; i <= upTo; i++) cp(r, id, i, from + i * 1000); };

test('race timers: alone at go time cancels with "Nobody joined"; two entrants get race.go 3 s before startsAt', () => {
  const alone = raceOf(1);
  assert.equal(alone.due(), 20_000 - RACE_GO_LEAD_MS);
  assert.equal(alone.timers(16_999).out.length, 0);
  const c = alone.timers(17_000);
  assert.deepEqual(to(c.out, 'p0'), [{ t: 'race.cancel', id: c.out[0][1].id, why: 'Nobody joined' }]);
  assert.equal(alone.race, null); assert.equal(alone.due(), null);
  const r = raceOf(2);
  const g = r.timers(17_000);
  assert.deepEqual(to(g.out, 'p1'), [{ t: 'race.go', id: r.race.id, startsAt: 20_000 }]);
  assert.equal(r.race.state, 'countdown'); assert.equal(r.due(), 20_000);
  assert.equal(r.timers(20_000).out.length, 0); assert.equal(r.race.state, 'running'); assert.equal(r.due(), 20_000 + RACE_MAX_RUN_MS, 'a running race always has an end in sight');
});

test('race: checkpoints count only in order and only while running; a repeat or a skip is ignored, not bad', () => {
  const r = raceOf(2);
  assert.equal(cp(r, 'p0', 1, 5000).out.length, 0, 'before Go: ignored'); assert.equal(r.players.get('p0').bad, 0);
  r.timers(17_000); r.timers(20_000);
  const a = cp(r, 'p0', 1, 25_000);
  const pos = to(a.out, 'p1').find(m => m.t === 'race.pos');
  assert.deepEqual(pos.order.find(o => o.id === 'p0'), { id: 'p0', name: 'P0', cp: 1, at: 5000, ms: null, fin: false, dnf: false, pos: 1 });
  assert.equal(cp(r, 'p0', 1, 25_500).out.length, 0, 'repeat'); assert.equal(cp(r, 'p0', 3, 26_000).out.length, 0, 'skip');
  assert.equal(r.players.get('p0').bad, 0);
  assert.equal(cp(r, 'p0', 2, 27_000).out.length, 2); assert.equal(r.race.entrants.get('p0').cps.length, 2);
});

test('race: a non-entrant\'s cp or fin is a bad frame (a spectator who arrived mid-race too)', () => {
  const r = running(2); hi(r, 'late', 'Late');
  assert.deepEqual(cp(r, 'late', 1, 21_000), { out: [] }); assert.equal(r.players.get('late').bad, 1);
  assert.deepEqual(fin(r, 'late', 25_000, 22_000), { out: [] }); assert.equal(r.players.get('late').bad, 2);
});

test('race: fin needs all checkpoints; order is finishers first by time, then furthest checkpoint earliest; dead heat shares a position', () => {
  const r = running(3);
  assert.equal(fin(r, 'p0', 24_000, 30_000).out.length, 0, 'no checkpoints yet');
  lapTo(r, 'p0', RACE_CHECKPOINTS, 20_000); lapTo(r, 'p1', RACE_CHECKPOINTS, 20_100); lapTo(r, 'p2', 3, 20_200);
  let o = r.order();
  assert.deepEqual(o.map(x => x.id), ['p0', 'p1', 'p2'], 'furthest then earliest');
  fin(r, 'p1', 25_010, 45_080); // p1 is received first…
  fin(r, 'p0', 25_000, 45_000); // …but p0's finish carries an earlier server time? No: `at` is the receive time; 45000 < 45080 means p0 crossed earlier on the server clock
  o = r.order();
  assert.deepEqual(o.map(x => [x.id, x.pos]), [['p0', 1], ['p1', 1], ['p2', 3]], 'within 100 ms: dead heat for P1, next is P3');
  assert.equal(o[0].ms, 25_000); assert.equal(o[0].at, 25_000); assert.equal(r.due(), 45_080 + RACE_CLOSE_MS, 'close runs from the first to cross by the server clock (p1)');
  cp(r, 'p2', 4, 46_000); cp(r, 'p2', 5, 47_000);
  const end = fin(r, 'p2', 27_000, 47_500);
  const e = to(end.out, 'p0').find(m => m.t === 'race.end');
  assert.ok(e, 'everyone finished: race.end'); assert.deepEqual(e.dnf, []); assert.equal(e.order[2].pos, 3);
  assert.equal(r.race.state, 'done'); assert.equal(r.due(), 47_500 + RACE_KEEP_MS);
  assert.equal(r.timers(47_500 + RACE_KEEP_MS).raceChanged, true); assert.equal(r.race, null);
});

test('race: 60 s after the first finisher the race ends with the rest DNF; a leaver mid-race is DNF; the host leaving after Go changes nothing', () => {
  const r = running(3);
  lapTo(r, 'p1', RACE_CHECKPOINTS, 20_000); fin(r, 'p1', 25_000, 46_000);
  raceMsg(r, 'p0', { t: 'race.leave' }, 47_000); // the host, mid-race
  assert.equal(r.race.state, 'running'); assert.equal(r.race.entrants.get('p0').dnf, true);
  assert.equal(cp(r, 'p2', 1, 48_000).out.length, 3, 'p2 still racing: race.pos to all three in the room');
  assert.equal(r.due(), 46_000 + RACE_CLOSE_MS);
  const t = r.timers(46_000 + RACE_CLOSE_MS);
  const e = to(t.out, 'p2').find(m => m.t === 'race.end');
  assert.deepEqual(e.dnf.sort(), ['p0', 'p2']); assert.equal(e.order[0].id, 'p1');
  // a new race can start once this one is done
  assert.equal(raceMsg(r, 'p2', { t: 'race.open' }, 200_000).out.filter(([, m]) => m.t === 'race.open').length, 3);
});

test('race: raceState() round-trips through restoreRace() with entrants, slots, checkpoints and timers intact', () => {
  const r = running(3);
  lapTo(r, 'p1', 2, 20_000); fin(r, 'p0', 1, 1); // p0's fin is ignored (no cps); p1 has two checkpoints
  const snap = JSON.parse(JSON.stringify(r.raceState()));
  const r2 = room(); for (let i = 0; i < 3; i++) hi(r2, 'p' + i, 'P' + i);
  r2.restoreRace(snap);
  assert.equal(r2.race.id, r.race.id); assert.equal(r2.race.state, 'running'); assert.equal(r2.race.startsAt, 20_000);
  assert.deepEqual(r2.grid(), r.grid()); assert.deepEqual(r2.order(), r.order()); assert.equal(r2.due(), r.due());
  assert.deepEqual(cp(r2, 'p1', 3, 30_000).out.length, 3, 'the restored race takes the next checkpoint');
  assert.equal(room().raceState(), null); const r3 = room(); r3.restoreRace(null); assert.equal(r3.race, null);
});

// ---- review fixes ----
test('race: a field that empties during the countdown is cancelled at Go, never left running', () => {
  const r = raceOf(2); r.timers(17_000);
  raceMsg(r, 'p0', { t: 'race.leave' }, 18_000);
  const last = raceMsg(r, 'p1', { t: 'race.leave' }, 18_500);
  assert.ok(to(last.out, 'p0').some(m => m.t === 'race.cancel'), 'the last one out cancels it at once');
  assert.equal(r.race, null);
  assert.equal(r.timers(20_000).out.length, 0);
});

test('race: a running race ends on its own after RACE_MAX_RUN_MS even if nobody finishes', () => {
  const r = running(2);
  assert.equal(r.due(), 20_000 + RACE_MAX_RUN_MS);
  const t = r.timers(20_000 + RACE_MAX_RUN_MS);
  const e = to(t.out, 'p1').find(m => m.t === 'race.end');
  assert.deepEqual(e.dnf.sort(), ['p0', 'p1']); assert.equal(r.race.state, 'done');
});

test('race: restoreRace marks entrants the roster no longer has as DNF, and ends the race if nobody is left', () => {
  const r = running(3); lapTo(r, 'p1', 2, 20_000);
  const snap = JSON.parse(JSON.stringify(r.raceState()));
  const r2 = room(); hi(r2, 'p1', 'P1'); // only p1 came back after the restart
  const res = r2.restoreRace(snap, 30_000);
  assert.equal(r2.race.entrants.get('p0').dnf, true); assert.equal(r2.race.entrants.get('p2').dnf, true); assert.equal(r2.race.entrants.get('p1').dnf, false);
  assert.equal(r2.race.state, 'running');
  const r3 = room(); hi(r3, 'x', 'X'); const res3 = r3.restoreRace(snap, 30_000); // nobody from the race came back
  assert.equal(r3.race.state, 'done'); assert.ok(res3.out.length >= 0);
});

test('race: open/join/leave are rate-limited like poses (over 2 a second is dropped, a flood closes)', () => {
  const r = raceOf(2);
  let dropped = 0;
  for (let i = 0; i < 10; i++) { const o = raceMsg(r, 'p1', { t: i % 2 ? 'race.join' : 'race.leave' }, 100 + i * 10); if (!o.out.length) dropped++; }
  assert.ok(dropped >= 7, `dropped ${dropped}`);
  assert.equal(r.players.get('p1').bad, 0, 'rate drops are not bad frames');
});

test('race: hi during a race carries the race, so late arrivals see it', () => {
  const r = running(2); lapTo(r, 'p0', 1, 20_000);
  const { out } = hi(r, 'late', 'Late', 30_000);
  const ok = to(out, 'late').find(m => m.t === 'ok');
  assert.equal(ok.race.id, r.race.id); assert.equal(ok.race.state, 'running'); assert.equal(ok.race.order[0].id, 'p0'); assert.equal(ok.race.grid.length, 2);
  const r2 = room(); hi(r2, 'a', 'A');
  assert.equal(to(hi(r2, 'b', 'B').out, 'b')[0].race, null);
});

test('race: close(id, now) that ends the race keeps the result for the usual time', () => {
  const r = running(2); lapTo(r, 'p0', RACE_CHECKPOINTS, 20_000); fin(r, 'p0', 25_000, 46_000);
  r.close('p1', 47_000);
  assert.equal(r.race.state, 'done'); assert.equal(r.race.endedAt, 47_000); assert.equal(r.due(), 47_000 + RACE_KEEP_MS);
});

test('race: dead heats are measured from the first of the group, so a chain does not creep', () => {
  const r = running(3);
  for (const id of ['p0', 'p1', 'p2']) lapTo(r, id, RACE_CHECKPOINTS, 20_000);
  fin(r, 'p0', 25_000, 45_000); fin(r, 'p1', 25_000, 45_090); fin(r, 'p2', 25_000, 45_180);
  assert.deepEqual(r.order().map(o => [o.id, o.pos]), [['p0', 1], ['p1', 1], ['p2', 3]]);
});

// ---- emotes ----
test('room: an emote goes to everyone else, not back to the sender; garbage is bad; more than two a second are dropped', () => {
  const r = room(); hi(r, 'a', 'A'); hi(r, 'b', 'B'); hi(r, 'c', 'C');
  assert.equal(EMOTE_COUNT, 5); assert.equal(EMOTE_MAX_HZ, 2);
  const send = (e, now) => r.onMessage('a', JSON.stringify({ t: 'emote', e }), now);
  let { out } = send(3, 1000);
  assert.deepEqual(out.map(([id]) => id).sort(), ['b', 'c']);
  assert.deepEqual(to(out, 'b'), [{ t: 'emote', id: 'a', e: 3 }]);
  for (const bad of [5, -1, 1.5, '2', null, undefined]) {
    const res = send(bad, 1100);
    assert.deepEqual(res.out, [], JSON.stringify(bad)); assert.notEqual(res.close, 'flood');
  }
  assert.equal(send(0, 1200).out.length, 2); // second in the second: fine
  assert.deepEqual(send(1, 1300).out, []); // third: dropped
  assert.equal(send(1, 2001).out.length, 2); // the window has moved on
  assert.deepEqual(r.onMessage('zz', JSON.stringify({ t: 'emote', e: 1 }), 3000).out, [], 'unknown socket');
});
