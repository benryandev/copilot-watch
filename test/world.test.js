import test from 'node:test'; import assert from 'node:assert/strict';
import { pickName, isReserved, RESERVED, parsePose, WORLD_RADIUS, WORLD_MAX_SPEED, WORLD_FRAME_MAX, Room, WORLD_MAX, WORLD_IP_MAX, COLOURS, offChecker, WORLD_FLOOD_BLOCK_MS, WORLD_IDLE_MS } from '../src/world.js';

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

// ---- the room ----
const room = o => new Room({ ownerToken: 'own', ...o });
const hi = (r, id, name, now = 0, extra = {}) => { r.open(id, { ipKey: 'k' + id }, now); return r.onMessage(id, JSON.stringify({ t: 'hi', v: 1, name, ...extra }), now); };
const to = (out, id) => out.filter(([i]) => i === id).map(([, m]) => m);
const pose = (r, id, now, over = {}) => r.onMessage(id, JSON.stringify({ t: 'p', x: 1, z: 2, h: 0.5, s: 3, ...over }), now);
const snaps = out => out.filter(([, m]) => m.t === 's');

test('room: hi joins, replies ok with peers, tells the others, counts', () => {
  const r = room(); hi(r, 'a', 'Ben');
  const { out } = hi(r, 'b', 'Aveli', 10);
  const ok = to(out, 'b').find(m => m.t === 'ok');
  assert.equal(ok.id, 'b'); assert.equal(ok.name, 'Aveli'); assert.equal(ok.now, 10);
  assert.equal(ok.peers.length, 1); assert.equal(ok.peers[0].name, 'Driver 01'); assert.equal(ok.peers[0].id, 'a');
  assert.deepEqual(to(out, 'a').map(m => m.t), ['join', 'n']);
  assert.equal(to(out, 'a')[1].online, 2); assert.equal(r.online(), 2);
  assert.deepEqual(r.attachment('b'), { id: 'b', name: 'Aveli', colour: ok.colour, ipKey: 'kb', since: 10 });
});

test('room: owner token lets Ben be Ben; colours differ for the first eight', () => {
  const r = room(); const { out } = hi(r, 'a', 'Ben', 0, { owner: 'own' });
  assert.equal(to(out, 'a')[0].name, 'Ben');
  assert.equal(to(hi(r, 'z', 'Ben', 0, { owner: 'wrong' }).out, 'z')[0].name, 'Driver 01');
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
  assert.equal(to(r.onMessage('a', JSON.stringify({ t: 'name', name: 'Shan' }), 11000).out, 'a')[0].name, 'Driver 01');
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
  assert.equal(isReserved('Вen'), true); // Cyrillic В
  assert.equal(isReserved('Ѕhan'), true); // Cyrillic Ѕ
  assert.equal(isReserved('Βеn'), true); // Greek Β + Cyrillic е
  assert.equal(isReserved('Benny'), false);
  assert.equal(pickName('Вen').name, 'Driver 01');
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
  assert.equal(to(r.onMessage('a', JSON.stringify({ t: 'name', name: 'Ben', owner: 'own' }), 1000).out, 'a')[0].name, 'Ben');
  assert.equal(to(r.onMessage('a', JSON.stringify({ t: 'name', name: 'Shan', owner: 'nope' }), 20000).out, 'a')[0].name, 'Driver 01');
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
