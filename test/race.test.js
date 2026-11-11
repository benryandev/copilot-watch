import test from 'node:test'; import assert from 'node:assert/strict';
import { handleRaceApi, uaClass, parseTime, parseTrace, isRude, cleanName, hashHex, RACE_ORIGINS, RACE_KEEP, RACE_SHOW, RACE_ADMIN_HEADER, RACE_TRACE_MAX, RACE_MAX_BODY, RACE_RATE_SEC, RACE_RATE_BURST, RACE_ADDR_ROWS } from '../src/race.js';
import { RACE_TRACKS, RACE_MAX_MS, raceTrack } from '../src/race-tracks.js';
import handler from '../src/worker.js';
import { memKV } from './kv-mem.js';

// Every expected time below comes from the track constant, so swapping in the real track numbers needs no test changes.
const TRACK = 'realfi-v1', T = RACE_TRACKS[TRACK], O = RACE_ORIGINS[0], NOW = Date.UTC(2026, 9, 30), ADMIN = 'test-admin-token-1234';
const minMs = m => (m * 1000) / T.maxSpeed;
const segMs = m => (m * 1000) / T.segMaxSpeed; // a single segment's floor (looser than the lap's)
/** A clean lap at `speed` m/s (well under T.maxSpeed). */
const lap = (speed = 20) => ({ splits: T.checkpoints.map(d => Math.round((d * 1000) / speed)), ms: Math.round((T.length * 1000) / speed) });
// Every real client sends a trace; a post without a valid one is refused (1 Nov 2026), so the default body carries one
const good = (over = {}) => { const b = { track: TRACK, name: 'Ben', ...lap(), ...over }; if (!('trace' in over)) b.trace = traceFor({ ms: b.ms }, Math.max(100, Math.ceil(b.ms / 399 / 100) * 100)); return b; }; // thinned like the page for long laps
const env = (o = {}) => ({ KV: memKV(), ...o });
const req = (method, path, { body, origin = O, ip = '1.1.1.1', headers = {} } = {}) => new Request(`https://w${path}`, {
  method, headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers },
  ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
let ipN = 0; const freshIp = () => `10.0.${Math.floor(++ipN / 250)}.${ipN % 250}`;
const post = (e, body, o = {}) => handleRaceApi(req('POST', '/race/time', { ip: freshIp(), body, ...o }), e, { now: o.now ?? NOW });
const top = async e => (await (await handleRaceApi(req('GET', `/race/top?track=${TRACK}`), e)).json()).top;
const err = async r => (await r.json()).error;

test('track constant is consistent (cumulative, increasing, inside the lap)', () => {
  for (const [name, t] of Object.entries(RACE_TRACKS)) {
    assert.ok(t.checkpoints.length > 0, name);
    t.checkpoints.forEach((d, i) => assert.ok(d > (i ? t.checkpoints[i - 1] : 0), `${name} cp ${i}`));
    assert.ok(t.length > t.checkpoints.at(-1), name);
  }
});

test('a clean lap is accepted', async () => {
  const e = env(); const r = await post(e, good());
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.ok, true); assert.equal(b.rank, 1); assert.equal(b.best, true);
  assert.deepEqual(b.top, [{ name: 'Ben', ms: lap().ms, at: NOW }]);
});

test('validation: track, name, splits, ms', () => {
  const L = lap(), n = T.checkpoints.length;
  const cases = [
    [{ track: 'nope' }, 'unknown_track'],
    [{ track: '__proto__' }, 'unknown_track'],
    [{ name: '' }, 'bad_name'], [{ name: '   ' }, 'bad_name'], [{ name: 'x'.repeat(21) }, 'bad_name'], [{ name: 42 }, 'bad_name'],
    [{ name: '​‏' }, 'bad_name'], [{ name: 'Ben\u0007' }, 'bad_name'], [{ name: 'a\nb' }, 'bad_name'], [{ name: 'a b' }, 'bad_name'],
    [{ name: 'fuck' }, 'rude_name'], [{ name: 'FuCkEr99' }, 'rude_name'], [{ name: 'f.u.c.k' }, 'rude_name'], [{ name: 'f u c k' }, 'rude_name'],
    [{ name: 'sh1t' }, 'rude_name'], [{ name: '$h!7' }, 'rude_name'], [{ name: 'c.u.n.7' }, 'rude_name'],
    [{ name: 'fu​ck' }, 'rude_name'], [{ name: 'fuuuuck' }, 'rude_name'], [{ name: 'big c0ck' }, 'rude_name'], [{ name: '4$$' }, 'rude_name'],
    [{ splits: L.splits.slice(1) }, 'bad_splits'], [{ splits: [...L.splits, L.ms - 1] }, 'bad_splits'], [{ splits: 'x' }, 'bad_splits'],
    [{ splits: L.splits.map((x, i) => (i === 1 ? L.splits[0] : x)) }, n > 1 ? 'bad_splits' : null], // equal, not increasing
    [{ splits: [...L.splits].reverse() }, n > 1 ? 'bad_splits' : null],
    [{ splits: L.splits.map(x => x + 0.5) }, 'bad_splits'],
    [{ ms: L.splits.at(-1) }, 'bad_ms'], [{ ms: L.splits.at(-1) - 1 }, 'bad_ms'], [{ ms: L.ms + 0.5 }, 'bad_ms'], [{ ms: '50000' }, 'bad_ms'],
    [{ ms: RACE_MAX_MS }, 'bad_ms'],
  ].filter(c => c[1]);
  for (const [over, want] of cases) assert.equal(parseTime(good(over)).error, want, JSON.stringify(over));
  assert.equal(parseTime(null).error, 'bad_json'); assert.equal(parseTime([]).error, 'bad_json');
});

test('too-fast segment, too-fast final segment and too-fast lap', () => {
  const L = lap(), cps = T.checkpoints;
  // first segment just under its minimum; later ones shifted so the lap total is still fine
  const fast0 = Math.ceil(segMs(cps[0])) - 1;
  const s0 = [fast0, ...L.splits.slice(1)];
  assert.deepEqual([parseTime(good({ splits: s0 })).error, parseTime(good({ splits: s0 })).segment], ['segment_too_fast', 0]);
  // a middle segment too fast
  if (cps.length > 1) {
    const s = [...L.splits]; s[1] = s[0] + Math.ceil(segMs(cps[1] - cps[0])) - 1;
    assert.equal(parseTime(good({ splits: s })).segment, 1);
  }
  // the final segment (last checkpoint to the line) too fast
  const finalMin = segMs(T.length - cps.at(-1));
  assert.equal(parseTime(good({ ms: L.splits.at(-1) + Math.ceil(finalMin) - 1 })).segment, cps.length);
  // exactly at the minimum is allowed
  const exact = cps.map(d => Math.ceil(segMs(d)));
  const seg = cps.map((d, i) => segMs(d - (i ? cps[i - 1] : 0)));
  if (exact.every((x, i) => x - (i ? exact[i - 1] : 0) >= seg[i])) assert.ok(parseTime(good({ splits: exact, ms: exact.at(-1) + Math.ceil(finalMin) + 1 })).ok);
  // whole lap below the minimum lap time
  const lapMin = segMs(T.length);
  const tiny = cps.map((_, i) => i + 1);
  assert.equal(parseTime(good({ splits: tiny, ms: Math.ceil(lapMin) - 1 })).error, 'lap_too_fast');
});

test('names: cleaned, invisible characters stripped, Scunthorpe-style names pass', () => {
  assert.deepEqual(cleanName('  Ben​  Ryan ‮ '), { ok: true, name: 'Ben Ryan' });
  assert.equal(cleanName('x'.repeat(20)).ok, true);
  assert.equal(cleanName('🏎️'.repeat(5)).ok, true);
  for (const fine of ['Scunthorpe', 'Dickens', 'Hitchcock', 'grape', 'saltwater', 'therapist', 'torpedo', 'Cockburn', 'Fast as heck', 'push it', 'Assassin', 'Sussex', 'Ben R', 'Classic 911', 'Pass'])
    assert.equal(isRude(fine), false, fine);
  for (const bad of ['fuck', 'F*U*C*K', 'motherfucker', 'shit happens', 'b1tch', 'n1gg3r', 'cunt', 'C U N T', 'dick', 'tw4t', 'Fuk', 'a55', 'p3n1s'])
    assert.equal(isRude(bad), true, bad);
});

test('one row per player: a new name from the same address replaces that player\'s row; slower under a new name changes nothing', async () => {
  const e = env(); const ip = '7.7.7.7';
  const dunk = lap(20), dunkSlow = lap(18), dunkFast = lap(22), ben = lap(21), benFast = lap(23);
  let r = await post(e, good({ name: 'Dunk', ...dunk }), { ip, now: NOW });
  assert.equal(r.status, 200); assert.equal((await r.json()).rank, 1);
  // Slower lap, new name, same address: no new row; the reply ranks the row they already hold
  r = await post(e, good({ name: 'Dunk 2', ...dunkSlow }), { ip, now: NOW + 20_000 });
  let b = await r.json(); assert.equal(r.status, 200); assert.equal(b.best, false); assert.equal(b.rank, 1);
  assert.deepEqual(b.top.map(x => x.name), ['Dunk']);
  // Faster lap, new name, same address: the one row is replaced, name and all
  r = await post(e, good({ name: 'XXX Dunk XXX', ...dunkFast }), { ip, now: NOW + 40_000 });
  b = await r.json(); assert.equal(b.best, true); assert.deepEqual(b.top.map(x => [x.name, x.ms]), [['XXX Dunk XXX', dunkFast.ms]]);
  // Another address with its own name is a second player
  r = await post(e, good({ name: 'Ben', ...ben }), { ip: '6.6.6.6', now: NOW + 60_000 });
  b = await r.json(); assert.equal(b.rank, 2); assert.deepEqual(b.top.map(x => x.name), ['XXX Dunk XXX', 'Ben']);
  // The same name from another address still replaces by name (one row per name holds too)
  r = await post(e, good({ name: 'Ben', ...benFast }), { ip: '5.5.5.5', now: NOW + 80_000 });
  b = await r.json(); assert.deepEqual(b.top.map(x => [x.name, x.ms]), [['Ben', benFast.ms], ['XXX Dunk XXX', dunkFast.ms]]);
  // The address hash never leaves the worker
  for (const row of b.top) assert.deepEqual(Object.keys(row).sort(), ['at', 'ms', 'name']);
  const g = await (await handleRaceApi(req('GET', `/race/ghost?track=${TRACK}`), e, { now: NOW })).json();
  assert.ok(!('ipk' in g.ghost) && !('key' in g.ghost));
});

// ---- devices: people who share one public address (a colleague on Tynus's office wifi, 4 Nov 2026) ----

// A device token is 16 random bytes as hex, made once by the page and kept in its storage
const dev = i => i.toString(16).padStart(32, '0');

test('devices: two devices on one address each get a row; the same device slower keeps its row, faster under a new name replaces it', async () => {
  const e = env(); const ip = '7.7.7.7';
  const a = lap(20), b = lap(19), aSlow = lap(18), aFast = lap(22);
  let r = await (await post(e, good({ name: 'Tynus', ...a, device: dev(1) }), { ip, now: NOW })).json();
  assert.equal(r.rank, 1); assert.equal(r.best, true);
  // a colleague on the same wifi, another device: their own row
  r = await (await post(e, good({ name: 'Mara', ...b, device: dev(2) }), { ip, now: NOW + 20_000 })).json();
  assert.equal(r.best, true); assert.equal(r.rank, 2);
  assert.deepEqual(r.top.map(x => x.name), ['Tynus', 'Mara']);
  // the first device again, slower, a new name: nothing changes; the reply ranks the row it holds
  r = await (await post(e, good({ name: 'Tynus 2', ...aSlow, device: dev(1) }), { ip, now: NOW + 40_000 })).json();
  assert.equal(r.best, false); assert.equal(r.rank, 1);
  assert.deepEqual(r.top.map(x => x.name), ['Tynus', 'Mara']);
  // the first device, faster, a new name: its one row is replaced, name and all (the name-variant hole stays closed)
  r = await (await post(e, good({ name: 'TYNUS!!', ...aFast, device: dev(1) }), { ip, now: NOW + 60_000 })).json();
  assert.equal(r.best, true);
  assert.deepEqual(r.top.map(x => [x.name, x.ms]), [['TYNUS!!', aFast.ms], ['Mara', b.ms]]);
  // the hashes never leave the worker, and neither the token nor the address lands in KV as given
  for (const row of r.top) assert.deepEqual(Object.keys(row).sort(), ['at', 'ms', 'name']);
  const g = await (await handleRaceApi(req('GET', `/race/ghost?track=${TRACK}`), e, { now: NOW })).json();
  assert.ok(!('ipk' in g.ghost) && !('ak' in g.ghost) && !('key' in g.ghost));
  const stored = [...e.KV.m.keys(), ...e.KV.m.values()].map(x => JSON.stringify(x)).join('\n');
  assert.ok(!stored.includes(dev(1)) && !stored.includes(dev(2)) && !stored.includes(ip));
});

test('devices: one name stays one row, whether the same device or two devices on one address post it', async () => {
  const e = env(); const ip = '7.7.7.8';
  const slow = lap(18), fast = lap(21);
  await post(e, good({ name: 'Office', ...slow, device: dev(1) }), { ip, now: NOW });
  const r = await (await post(e, good({ name: 'office', ...fast, device: dev(2) }), { ip, now: NOW + 20_000 })).json();
  assert.equal(r.best, true); assert.equal(r.rank, 1);
  assert.deepEqual(r.top.map(x => [x.name, x.ms]), [['office', fast.ms]]);
  // slower under the same name from a third device: no second row
  const s = await (await post(e, good({ name: 'OFFICE', ...slow, device: dev(3) }), { ip, now: NOW + 40_000 })).json();
  assert.equal(s.best, false); assert.equal(s.rank, 1);
  assert.equal((await top(e)).length, 1);
});

test('devices: five devices fill an address, a sixth is refused with address_full; a device on the board can still improve its row', async () => {
  const e = env(); const ip = '7.7.7.9';
  assert.equal(RACE_ADDR_ROWS, 5);
  for (let i = 1; i <= RACE_ADDR_ROWS; i++) {
    const r = await post(e, good({ name: `Desk ${i}`, ...lap(15 + i), device: dev(i) }), { ip, now: NOW + i * 20_000 });
    assert.equal(r.status, 200, `device ${i}`); assert.equal((await r.json()).best, true, `device ${i}`);
  }
  const sixth = await post(e, good({ name: 'Desk 6', ...lap(23), device: dev(6) }), { ip, now: NOW + 6 * 20_000 });
  assert.equal(sixth.status, 409); assert.equal(await err(sixth), 'address_full');
  assert.deepEqual((await top(e)).map(x => x.name), Array.from({ length: RACE_ADDR_ROWS }, (_, i) => `Desk ${RACE_ADDR_ROWS - i}`));
  // a device already on the board improves its own row while the address is full
  const again = await (await post(e, good({ name: 'Desk 1', ...lap(24), device: dev(1) }), { ip, now: NOW + 7 * 20_000 })).json();
  assert.equal(again.best, true); assert.equal(again.rank, 1);
  // a slower lap from a device on the board is "already on the board", not a refusal
  const slower = await post(e, good({ name: 'Desk 2', ...lap(14), device: dev(2) }), { ip, now: NOW + 8 * 20_000 });
  assert.equal(slower.status, 200); assert.equal((await slower.json()).best, false);
  // another address is not affected
  assert.equal((await post(e, good({ name: 'Home', device: dev(7) }), { ip: '6.6.6.7', now: NOW + 9 * 20_000 })).status, 200);
  assert.equal((await top(e)).length, RACE_ADDR_ROWS + 1);
});

test('devices: a post without a token, or with a malformed one, is keyed by the address alone as before', async () => {
  const e = env(); const ip = '7.7.8.1';
  const a = lap(20), b = lap(21);
  let r = await (await post(e, good({ name: 'Old page', ...a }), { ip, now: NOW })).json();
  assert.equal(r.best, true);
  // a malformed token counts as none: the same player as the token-less post, so its row is replaced, not joined
  r = await (await post(e, good({ name: 'Old page 2', ...b, device: 'not-a-token' }), { ip, now: NOW + 20_000 })).json();
  assert.equal(r.best, true); assert.deepEqual(r.top.map(x => x.name), ['Old page 2']);
  for (const bad of [42, '', 'g'.repeat(32), dev(1).slice(1), dev(1) + '0', null, {}, [dev(1)]]) assert.equal(parseTime(good({ device: bad })).entry.device, null, JSON.stringify(bad));
  assert.equal(parseTime(good({ device: dev(255) })).entry.device, dev(255));
  assert.equal(parseTime(good({ device: dev(255).toUpperCase() })).entry.device, dev(255), 'upper case is the same token');
});

test('devices: rows from before tokens count toward the address cap; a player with an old row and a new token gets one more row at most', async () => {
  const e = env(); const ip = '7.7.8.2';
  // the address already holds all but one of its rows from before tokens (ipk = the address hash, no ak)
  const ak = await hashHex(`race:board:${ip}`), L = lap(16);
  const old = Array.from({ length: RACE_ADDR_ROWS - 1 }, (_, i) => i + 1).map(i => ({ id: `old${i}`, name: `Old ${i}`, key: `old ${i}`, ipk: ak, ms: L.ms + i * 10, splits: L.splits, trace: null, at: NOW - i }));
  await e.KV.put(`race:top:${TRACK}`, JSON.stringify(old));
  // this player's first post from the new page (a token, another name): the address's last free row
  let r = await post(e, good({ name: 'Me', ...lap(20), device: dev(1) }), { ip, now: NOW });
  assert.equal(r.status, 200); assert.equal((await r.json()).best, true);
  assert.equal((await top(e)).length, RACE_ADDR_ROWS);
  // storage cleared, a new token, another name: the address is full
  r = await post(e, good({ name: 'Me again', ...lap(21), device: dev(2) }), { ip, now: NOW + 20_000 });
  assert.equal(r.status, 409); assert.equal(await err(r), 'address_full');
  // the old page (no token) from this address still replaces the old rows as one player
  r = await (await post(e, good({ name: 'Old 9', ...lap(22) }), { ip, now: NOW + 40_000 })).json();
  assert.equal(r.best, true);
  assert.deepEqual((await top(e)).map(x => x.name), ['Old 9', 'Me']);
});

test(`rate limit: ${RACE_RATE_BURST} posts per address per ${RACE_RATE_SEC} s (an office), counted even when invalid; another address is fine`, async () => {
  assert.equal(RACE_RATE_SEC, 10); // two laps can finish 25 s apart; 30 s swallowed a best lap (1 Nov 2026)
  assert.equal(RACE_RATE_BURST, 5); // an office's worth, the same five as the rows one address may hold
  const e = env(); const ip = '9.9.9.9';
  assert.equal((await post(e, good({ name: 'x'.repeat(30) }), { ip })).status, 400); // invalid, still counts
  // colleagues on one wifi finishing within seconds of each other (4 Nov 2026): the budget takes them
  for (let i = 1; i < RACE_RATE_BURST; i++) assert.equal((await post(e, good(), { ip, now: NOW + i * 500 })).status, 200, `post ${i + 1} of ${RACE_RATE_BURST}`);
  const r = await post(e, good(), { ip, now: NOW + 4_000 });
  assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), String(RACE_RATE_SEC - 4)); assert.equal(await err(r), 'rate');
  assert.equal((await post(e, good(), { ip: '8.8.8.8' })).status, 200);
  // the window has passed but the key (60 s, KV's minimum TTL) is still there: a new window starts on the stored time
  assert.equal((await post(e, good({ name: 'Other' }), { ip, now: NOW + RACE_RATE_SEC * 1000 + 1000 })).status, 200);
  for (let i = 1; i < RACE_RATE_BURST; i++) assert.equal((await post(e, good({ name: 'Again' }), { ip, now: NOW + RACE_RATE_SEC * 1000 + 1000 + i })).status, 200);
  assert.equal((await post(e, good({ name: 'Again' }), { ip, now: NOW + RACE_RATE_SEC * 1000 + 2000 })).status, 429);
  e.KV.now = 61_000; // memKV clock: the key has expired
  assert.equal((await post(e, good({ name: 'Third' }), { ip, now: NOW + 61_000 })).status, 200);
  // a key written before the budget existed (a bare timestamp) reads as one post in its window
  const e3 = env(); await e3.KV.put('race:ip:' + await hashHex(`race:${ip}`), String(NOW));
  for (let i = 1; i < RACE_RATE_BURST; i++) assert.equal((await post(e3, good(), { ip, now: NOW + i })).status, 200, `old key, post ${i + 1}`);
  assert.equal((await post(e3, good(), { ip, now: NOW + RACE_RATE_BURST })).status, 429);
  // unparseable JSON and oversized bodies are refused before the limit and don't count
  const e2 = env();
  assert.equal((await post(e2, '{nope', { ip })).status, 400);
  assert.equal((await post(e2, 'x'.repeat(RACE_MAX_BODY + 1), { ip })).status, 413);
  assert.equal((await post(e2, good(), { ip })).status, 200);
  // the IP itself is never stored, only a hash
  assert.ok(![...e.KV.m.keys(), ...e.KV.m.values()].some(x => JSON.stringify(x).includes(ip)));
});

test('best per name: slower does not replace, faster does, names compare case-insensitively', async () => {
  const e = env(); const base = lap(20), slow = lap(15), fast = lap(25);
  assert.equal((await (await post(e, good({ name: 'Ben', ...base }))).json()).best, true);
  const s = await (await post(e, good({ name: 'BEN', ...slow }), { now: NOW + 1 })).json();
  assert.equal(s.best, false); assert.equal(s.rank, 1);
  assert.deepEqual(await top(e), [{ name: 'Ben', ms: base.ms, at: NOW }]);
  const f = await (await post(e, good({ name: 'bEn', ...fast }), { now: NOW + 2 })).json();
  assert.equal(f.best, true); assert.equal(f.rank, 1);
  assert.deepEqual(await top(e), [{ name: 'bEn', ms: fast.ms, at: NOW + 2 }]);
  // an equal time is not an improvement
  assert.equal((await (await post(e, good({ name: 'BEN', ...fast }), { now: NOW + 3 })).json()).best, false);
});

test('ordering, ties by earlier time, cap of 100, top 10 only and no ids or splits leaked', async () => {
  const e = env(); const L = lap(20);
  // seed the board directly (the rate limit would otherwise make this slow)
  const rows = [];
  for (let i = 0; i < RACE_KEEP; i++) rows.push({ id: `id${i}`, name: `P${i}`, key: `p${i}`, ms: L.ms + (RACE_KEEP - i) * 10, splits: L.splits, at: NOW - i });
  await e.KV.put(`race:top:${TRACK}`, JSON.stringify(rows.sort((a, b) => a.ms - b.ms)));
  // a new best goes to the top; the slowest drops off
  const r = await (await post(e, good({ name: 'New', ...L }))).json();
  assert.equal(r.rank, 1); assert.equal(r.best, true);
  let board = await e.KV.get(`race:top:${TRACK}`, 'json');
  assert.equal(board.length, RACE_KEEP); assert.ok(!board.some(x => x.name === 'P0'));
  // slower than all 100: not kept
  const slowest = await (await post(e, good({ name: 'Slow', ...lap(2) }))).json();
  assert.deepEqual([slowest.rank, slowest.best], [null, false]);
  // a tie goes after the earlier entry
  const tie = await (await post(e, good({ name: 'Tie', ...L }), { now: NOW + 5 })).json();
  assert.equal(tie.rank, 2);
  board = await e.KV.get(`race:top:${TRACK}`, 'json');
  for (let i = 1; i < board.length; i++) assert.ok(board[i - 1].ms < board[i].ms || (board[i - 1].ms === board[i].ms && board[i - 1].at <= board[i].at));
  // public GET
  const g = await handleRaceApi(req('GET', `/race/top?track=${TRACK}`), e);
  const body = await g.json();
  assert.equal(g.status, 200); assert.equal(body.top.length, RACE_SHOW);
  for (const row of body.top) assert.deepEqual(Object.keys(row).sort(), ['at', 'ms', 'name']);
  assert.deepEqual(body.top.slice(0, 2).map(x => x.name), ['New', 'Tie']);
  assert.equal(r.top.length, RACE_SHOW); for (const row of r.top) assert.deepEqual(Object.keys(row).sort(), ['at', 'ms', 'name']);
  assert.equal((await handleRaceApi(req('GET', '/race/top?track=nope'), e)).status, 404);
  assert.deepEqual(await top(env()), []);
});

test('CORS: allowed origins echoed with Vary, others get none; preflight; POST needs an allowed origin', async () => {
  const e = env();
  for (const o of RACE_ORIGINS) {
    const g = await handleRaceApi(req('GET', `/race/top?track=${TRACK}`, { origin: o }), e);
    assert.equal(g.headers.get('access-control-allow-origin'), o); assert.match(g.headers.get('vary'), /Origin/);
  }
  const evil = await handleRaceApi(req('GET', `/race/top?track=${TRACK}`, { origin: 'https://evil.example' }), e);
  assert.equal(evil.status, 200); assert.equal(evil.headers.get('access-control-allow-origin'), null); assert.match(evil.headers.get('vary'), /Origin/);
  const pre = await handleRaceApi(req('OPTIONS', '/race/time', { headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } }), e);
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), O);
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/); assert.match(pre.headers.get('access-control-allow-headers'), /content-type/i);
  const badPre = await handleRaceApi(req('OPTIONS', '/race/time', { origin: 'https://evil.example' }), e);
  assert.equal(badPre.status, 403); assert.equal(badPre.headers.get('access-control-allow-origin'), null);
  const p = await post(e, good(), { origin: 'https://evil.example' });
  assert.equal(p.status, 403); assert.equal(p.headers.get('access-control-allow-origin'), null);
  assert.equal((await post(e, good(), { origin: '' })).status, 403);
  assert.ok(RACE_ORIGINS.includes('https://strikedrive.xyz'));
  const sd = await post(e, good({ name: 'Drive' }), { origin: 'https://strikedrive.xyz' });
  assert.equal(sd.status, 200); assert.equal(sd.headers.get('access-control-allow-origin'), 'https://strikedrive.xyz');
  assert.equal((await post(e, good({ name: 'Wwwdrive' }), { origin: 'https://www.strikedrive.xyz' })).status, 403);
  // routed through the worker
  const w = await handler.fetch(req('GET', `/race/top?track=${TRACK}`), e, {});
  assert.equal(w.status, 200); assert.equal(w.headers.get('access-control-allow-origin'), O);
});

test('admin delete: token required and checked, unset env denies, deletes by id and by name', async () => {
  const e = env({ RACE_ADMIN_TOKEN: ADMIN });
  for (const name of ['Alpha', 'Bravo', 'Charlie']) await post(e, good({ name }));
  const del = (body, headers = {}, query = '', en = e) => handleRaceApi(req('DELETE', `/race/time${query}`, { body, headers, origin: '' }), en, { now: NOW });
  const H = { [RACE_ADMIN_HEADER]: ADMIN };
  assert.equal((await del({ track: TRACK, name: 'Alpha' })).status, 401);
  assert.equal((await del({ track: TRACK, name: 'Alpha' }, { [RACE_ADMIN_HEADER]: 'wrong' })).status, 403);
  assert.equal((await del({ track: TRACK, name: 'Alpha' }, { [RACE_ADMIN_HEADER]: ADMIN + 'x' })).status, 403);
  const unset = env();
  assert.equal((await del({ track: TRACK, name: 'Alpha' }, H, '', unset)).status, 403);
  assert.equal((await del({ track: TRACK, name: 'Alpha' }, H, '', { KV: unset.KV, RACE_ADMIN_TOKEN: '' })).status, 403);
  assert.equal((await top(e)).length, 3);
  // ids are visible only to the admin
  const all = (await (await handleRaceApi(req('GET', `/race/top?track=${TRACK}`, { headers: H }), e)).json()).all;
  assert.equal(all.length, 3); assert.ok(all.every(x => typeof x.id === 'string' && x.id.length > 10));
  const pubGet = await (await handleRaceApi(req('GET', `/race/top?track=${TRACK}`, { headers: { [RACE_ADMIN_HEADER]: 'wrong' } }), e)).json();
  assert.ok(!('all' in pubGet));
  const bravo = all.find(x => x.name === 'Bravo').id;
  assert.deepEqual(await (await del({ track: TRACK, id: bravo }, H)).json(), { ok: true, removed: 1 });
  assert.equal((await del(undefined, H, `?track=${TRACK}&name=ALPHA`)).status, 200); // by name, query string, any case
  assert.deepEqual((await top(e)).map(x => x.name), ['Charlie']);
  assert.equal((await del({ track: TRACK, name: 'Alpha' }, H)).status, 404);
  assert.equal((await del({ track: 'nope', name: 'Charlie' }, H)).status, 400);
  assert.equal((await del({ track: TRACK }, H)).status, 400);
});

test('funnel: a counted open logs one broad line (country, network, browser kind, referrer host), never the address', async () => {
  const e = env({ RACE_ADMIN_TOKEN: ADMIN });
  const lines = [], was = console.log;
  console.log = (...a) => lines.push(a);
  try {
    const open = (ip, o = {}) => {
      const r = req('POST', '/race/event', { ip, body: { track: TRACK, kind: o.kind ?? 'open', ...(o.ref !== undefined ? { ref: o.ref } : {}) }, headers: { 'content-type': 'text/plain', ...(o.ua ? { 'user-agent': o.ua } : {}) } });
      if (o.cf) Object.defineProperty(r, 'cf', { value: o.cf });
      return handleRaceApi(r, e, { now: NOW });
    };
    await open('7.7.7.1', { ref: 'x.com', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) Mobile/15E148', cf: { country: 'AU', asOrganization: 'Telstra', verifiedBotCategory: '' } });
    await open('7.7.7.1', { ref: 'x.com' }); // the same visitor again: counted once, logged once
    await open('7.7.7.2', { ref: 'https://evil.example/?q=1', ua: 'Mozilla/5.0 HeadlessChrome/140.0', cf: { country: 'US', asOrganization: 'A'.repeat(90), verifiedBotCategory: 'Search Engine Crawler' } });
    await open('7.7.7.3'); // no cf, no user agent, no ref
    await open('7.7.7.4', { kind: 'found' }); // only opens are logged
  } finally { console.log = was; }
  const opens = lines.filter(a => a[0] === 'race open').map(a => JSON.parse(a[1]));
  assert.deepEqual(opens, [
    { track: TRACK, country: 'AU', net: 'Telstra', bot: null, ua: 'mobile', ref: 'x.com' },
    { track: TRACK, country: 'US', net: 'A'.repeat(60), bot: 'Search Engine Crawler', ua: 'headless', ref: null },
    { track: TRACK, country: null, net: null, bot: null, ua: 'none', ref: null },
  ]);
  assert.ok(!JSON.stringify(lines).includes('7.7.7.'));
  assert.deepEqual(['Googlebot/2.1', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 'Mozilla/5.0 (Linux; Android 16) Mobile'].map(uaClass), ['bot', 'desktop', 'mobile']);
});

test('funnel: page events count once per IP per stage per day; posts count on acceptance; stats are admin only', async () => {
  const e = env({ RACE_ADMIN_TOKEN: ADMIN });
  const ev = (kind, ip = '9.9.9.9', o = {}) => handleRaceApi(req('POST', '/race/event', { ip, body: { track: TRACK, kind }, headers: { 'content-type': 'text/plain' }, ...o }), e, { now: o.now ?? NOW });
  assert.equal((await ev('open')).status, 204);
  assert.equal((await ev('open')).status, 204); // same visitor, same day: not counted again
  await ev('open', '9.9.9.8'); await ev('found'); await ev('start'); await ev('finish');
  assert.equal(await err(await ev('post')), 'bad_kind'); // only the worker counts posts
  assert.equal(await err(await ev('nope')), 'bad_kind');
  assert.equal((await ev('open', '9.9.9.7', { origin: 'https://evil.example' })).status, 403);
  assert.equal(await err(await handleRaceApi(req('POST', '/race/event', { body: { track: 'x', kind: 'open' } }), e, { now: NOW })), 'unknown_track');
  await post(e, good());
  await ev('open', '9.9.9.9', { now: NOW + 86400000 }); // next day counts again
  const stats = o => handleRaceApi(req('GET', `/race/stats?track=${TRACK}&days=2`, o), e, { now: NOW + 86400000 });
  assert.equal((await stats()).status, 403);
  assert.equal((await stats({ headers: { [RACE_ADMIN_HEADER]: 'wrong' } })).status, 403);
  const { days } = await (await stats({ headers: { [RACE_ADMIN_HEADER]: ADMIN } })).json();
  assert.deepEqual(days, [
    { day: '2026-10-31', open: 1, found: 0, start: 0, finish: 0, post: 0 },
    { day: '2026-10-30', open: 2, found: 1, start: 1, finish: 1, post: 1 },
  ]);
});

// ---- ghost traces ----

/** A believable trace for lap L: a straight line at the lap's average speed, ten samples a second, ending on the lap time. */
const traceFor = (L, step = 100) => {
  const v = T.length / (L.ms / 1000), out = [];
  for (let t = 0; t <= L.ms; t += step) out.push([t, (v * t) / 1000, 0, 0]);
  if (out.at(-1)[0] !== L.ms) out.push([L.ms, T.length, 0, 0]);
  return out;
};

test('ghost trace: accepted, rounded, stored, served by /race/ghost, never in /race/top', async () => {
  const e = env(); const L = lap(20); const tr = traceFor(L);
  tr[1][1] += 0.04; tr[1][3] = 0.123456; // rounding: 0.1 m, 0.01 rad
  const r = await (await post(e, good({ trace: tr }))).json();
  assert.equal(r.ok, true);
  for (const row of r.top) assert.deepEqual(Object.keys(row).sort(), ['at', 'ms', 'name']);
  const g = await (await handleRaceApi(req('GET', `/race/ghost?track=${TRACK}`), e)).json();
  assert.equal(g.ghost.name, 'Ben'); assert.equal(g.ghost.ms, L.ms); assert.deepEqual(g.ghost.splits, L.splits);
  assert.equal(g.ghost.trace.length, tr.length);
  assert.deepEqual(g.ghost.trace[1], [100, Math.round((tr[1][1]) * 10) / 10, 0, 0.12]);
  // the admin view says how long the trace is rather than dumping it
  const a = await (await handleRaceApi(req('GET', `/race/top?track=${TRACK}`, { headers: { [RACE_ADMIN_HEADER]: ADMIN } }), env({ KV: e.KV, RACE_ADMIN_TOKEN: ADMIN }))).json();
  assert.equal(a.all[0].trace, tr.length);
  // no trace: refused (since 1 Nov 2026 the trace is the anti-cheat; every real client sends one)
  const e2 = env();
  const noTrace = await post(e2, good({ trace: null }));
  assert.equal(noTrace.status, 400); assert.equal(await err(noTrace), 'bad_trace');
  assert.equal((await (await handleRaceApi(req('GET', `/race/ghost?track=${TRACK}`), env())).json()).ghost, null);
  assert.equal((await handleRaceApi(req('GET', '/race/ghost?track=nope'), env())).status, 404);
});

test('ghost trace: the ghost is the fastest lap, and a slower lap with a trace does not replace it', async () => {
  const e = env(); const fast = lap(25), slow = lap(15);
  assert.equal((await post(e, good({ name: 'A', ...fast }))).status, 200);
  assert.equal((await post(e, good({ name: 'B', ...slow, trace: traceFor(slow, 200) }), { now: NOW + 1 })).status, 200); // a 43 s lap, thinned like the page does
  const g = await (await handleRaceApi(req('GET', `/race/ghost?track=${TRACK}`), e)).json();
  assert.equal(g.ghost.name, 'A'); assert.ok(Array.isArray(g.ghost.trace), 'the leader\'s own trace');
});

test('ghost trace: bad traces are refused', () => {
  const L = lap(20), tr = traceFor(L);
  const cases = {
    'not an array': 'x',
    'one sample': [tr[0]],
    'too many samples': traceFor(L, Math.floor(L.ms / (RACE_TRACE_MAX + 5))),
    'short sample': [...tr.slice(0, -1), [L.ms, 1, 2]],
    'time not increasing': tr.map((s, i) => (i === 2 ? [tr[1][0], ...s.slice(1)] : s)),
    'time past the lap': [...tr.slice(0, -1), [L.ms + 1, T.length, 0, 0]],
    'non-finite': tr.map((s, i) => (i === 3 ? [s[0], NaN, s[2], s[3]] : s)),
    'off the map': tr.map((s, i) => (i === 3 ? [s[0], 5000, s[2], s[3]] : s)),
    'too fast between samples': tr.map((s, i) => (i === 3 ? [s[0], s[1] + 5, s[2], s[3]] : s)), // +5 m in 100 ms = 50 m/s
    'starts late': tr.filter(s => s[0] > 1200),
    'ends early': tr.filter(s => s[0] < L.ms - 2000),
    'path too short': tr.map(s => [s[0], s[1] * 0.5, 0, 0]),
  };
  const why = {};
  for (const [what, trace] of Object.entries(cases)) { const r = parseTrace(trace, L.ms, T); assert.equal(r.error, 'bad_trace', what); why[what] = r.why; }
  assert.deepEqual(why, { 'not an array': 'shape', 'one sample': 'shape', 'too many samples': 'shape', 'short sample': 'shape', 'time not increasing': 'order',
    'time past the lap': 'range', 'non-finite': 'range', 'off the map': 'range', 'too fast between samples': 'speed', 'starts late': 'ends', 'ends early': 'ends', 'path too short': 'path' });
  // A bad or missing trace refuses the lap: the trace is the check that sees every tenth of a second
  const dropped = parseTime(good({ trace: 'x' }));
  assert.equal(dropped.ok, false); assert.equal(dropped.error, 'bad_trace'); assert.equal(dropped.why, 'shape');
  const kept = parseTime(good({ trace: tr }));
  assert.ok(kept.ok); assert.ok(Array.isArray(kept.entry.trace));
  assert.equal(parseTime(good({ trace: null })).error, 'bad_trace');
  // A lap driven at 34 m/s the whole way (the 1 Nov console cheat) is refused on its trace even when the splits fit
  const fast = { splits: T.checkpoints.map(d => Math.round((d * 1000) / 28.5)), ms: Math.round((T.length * 1000) / 28.5) };
  const cheat = parseTime(good({ ...fast, trace: traceFor(fast).map(([t, x, z, h]) => [t, x * 34 / 28.5, z, h]) }));
  assert.equal(cheat.ok, false); assert.equal(cheat.error, 'bad_trace'); assert.equal(cheat.why, 'speed');
  // 31 m/s the whole way slips the sample-to-sample check (0.3 m rounding slack per 100 ms) but not the one-second window
  const f31 = { splits: T.checkpoints.map(d => Math.round((d * 1000) / 28.5)), ms: Math.round((T.length * 1000) / 28.5) };
  const slow31 = parseTime(good({ ...f31, trace: traceFor(f31).map(([t, x, z, h]) => [t, x * 31 / 28.5, z, h]) }));
  assert.equal(slow31.ok, false); assert.equal(slow31.why, 'speed');
  // A real boost: 24 m/s with a 1.6 s burst at 28 m/s after the first jump, inside a lap whose average fits
  const L24 = lap(23), boosted = [];
  let x = 0; for (let t = 0; t <= L24.ms; t += 100) { boosted.push([t, Math.round(x * 10) / 10, 0, 0]); x += (t >= 3000 && t < 4600 ? 28 : 23) * 0.1; }
  const ok = parseTime(good({ ...L24, trace: boosted }));
  assert.equal(ok.ok, true, `a boosted lap must pass: ${ok.error} ${ok.why}`);
  // a real-looking body with 400 samples fits under the size limit
  assert.ok(JSON.stringify(good({ trace: traceFor(L, Math.ceil(L.ms / (RACE_TRACE_MAX - 1))) })).length < RACE_MAX_BODY);
});


// A short segment between close checkpoints reads faster than the car's real top speed when the line cuts the corner
// (the checkpoint distances run along the centreline), so segments get more headroom than the whole lap does.
test('segments allow corner-cutting headroom; the whole lap still cannot beat the top speed', async () => {
  const L = lap(24);
  const quick = [...L.splits]; // checkpoint 5 (550 m) reached early: the 50 m segment before it at ~34 m/s
  quick[4] = quick[3] + Math.round((50 * 1000) / 34);
  const r = await post(env(), good({ splits: quick, ms: L.ms }));
  assert.equal(r.status, 200, 'a 50 m segment at 34 m/s is a racing line, not a cheat');
  const tooQuick = [...L.splits];
  tooQuick[4] = tooQuick[3] + Math.round((50 * 1000) / (T.segMaxSpeed + 1));
  assert.equal(await err(await post(env(), good({ splits: tooQuick, ms: L.ms }))), 'segment_too_fast');
  assert.equal(await err(await post(env(), good(lap(T.maxSpeed + 0.5)))), 'lap_too_fast');
  assert.ok(T.segMaxSpeed > T.maxSpeed);
});

// The last sample lands on the line a few ms after the previous one; positions are rounded to 0.1 m, so a 0.2 m step in
// 5 ms reads as 40+ m/s. The speed check allows for the rounding (Ben's 25.252 lost its ghost to this on 31 Oct).
test('trace speed check allows for position rounding over a tiny interval', () => {
  const L = lap(), tr = traceFor(L);
  const last = tr[tr.length - 1];
  const nudged = [...tr.slice(0, -1), [last[0] - 5, last[1] - 0.1, last[2] - 0.2, last[3]], last];
  assert.ok(parseTrace(nudged, L.ms, T).ok, 'a 0.22 m step in 5 ms is rounding, not speed');
  // Mid-lap the rounding is all the slack there is
  const mid = Math.floor(tr.length / 2), m = tr[mid];
  const midLeap = [...tr.slice(0, mid), [m[0] - 5, m[1] - 1, m[2] - 0.5, m[3]], ...tr.slice(mid)];
  assert.equal(parseTrace(midLeap, L.ms, T).why, 'speed', 'a 1.1 m step in 5 ms mid-lap is impossible');
});

// The last sample is stamped with the moment the car crossed the line but carries where the car was at the end of that
// frame (ecosystem/js/race.js finish), up to one 1/30 s frame further on. A previous sample on the frame before made a
// clean lap read as a burst of speed: a third of 60 fps Lagoon laps, seven in ten at 30 fps (SellOuT's 30.594 and
// CryptoNinja's 30.372, 6 Nov 2026). The last step gets one frame of travel at the track's ceiling on top.
test('the last sample may overshoot the line by one 30 fps frame of travel, no more', () => {
  const L = lap(), tr = traceFor(L);
  const last = tr[tr.length - 1], frame = T.segMaxSpeed / 30;
  const over = (d) => [...tr.slice(0, -1), [last[0] - 5, last[1], last[2], last[3]], [last[0], last[1] + d, last[2], last[3]]];
  assert.ok(parseTrace(over(0.5), L.ms, T).ok, 'a 60 fps finish frame');
  assert.ok(parseTrace(over(frame), L.ms, T).ok, 'a 30 fps finish frame at the ceiling');
  assert.equal(parseTrace(over(frame + 0.5), L.ms, T).why, 'speed', 'more than a frame is still impossible');
  // On the Lagoon, a 30 m/s finish at 30 fps (1 m in the frame) after a sample 5 ms earlier
  const LG = raceTrack('lagoon-v2'), lg = { splits: LG.checkpoints.map(d => Math.round((d * 1000) / 29)), ms: Math.round((LG.length * 1000) / 29) };
  const ltr = [];
  for (let t = 0; t < lg.ms - 5; t += 100) ltr.push([t, Math.round((t / 1000) * 29 * 10) / 10, 0, 0]);
  const xEnd = (lg.ms / 1000) * 29;
  ltr.push([lg.ms - 5, Math.round((xEnd - 0.15) * 10) / 10, 0, 0], [lg.ms, Math.round((xEnd + 1) * 10) / 10, 0, 0]);
  assert.ok(parseTrace(ltr, lg.ms, LG).ok, 'the Lagoon finish that was refused');
});

test('a new #1 is announced to the world room through the WORLD binding; other posts are not; no binding is fine', async () => {
  const calls = [], waits = [];
  const WORLD = { fetch: async (url, init) => { calls.push({ url: String(url), init }); return new Response('{"ok":true}'); } };
  const e = env({ WORLD, RACE_ADMIN_TOKEN: ADMIN });
  const opts = { waitUntil: p => waits.push(p) };
  let r = await handleRaceApi(req('POST', '/race/time', { ip: freshIp(), body: good({ name: 'Aveli', ...lap(20) }) }), e, { now: NOW, ...opts });
  assert.equal((await r.json()).rank, 1);
  await Promise.all(waits);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/announce');
  assert.equal(calls[0].init.headers[RACE_ADMIN_HEADER], ADMIN);
  assert.deepEqual(JSON.parse(calls[0].init.body), { t: 'record', track: TRACK, trackName: T.name, name: 'Aveli', ms: lap(20).ms });
  r = await handleRaceApi(req('POST', '/race/time', { ip: freshIp(), body: good({ name: 'Rook', ...lap(19) }) }), e, { now: NOW + 20_000, ...opts });
  assert.equal((await r.json()).rank, 2);
  await Promise.all(waits);
  assert.equal(calls.length, 1, 'second place is not announced');
  r = await handleRaceApi(req('POST', '/race/time', { ip: freshIp(), body: good({ name: 'Juno', ...lap(22) }) }), env(), { now: NOW + 40_000 });
  assert.equal((await r.json()).rank, 1, 'a post without the binding still succeeds');
});

test('limits come from the entry: a lap under minMs is refused, one at minMs accepted', async () => {
  const at = ms => ({ ms, splits: T.checkpoints.map(d => Math.round((d / T.length) * ms)) });
  assert.equal(await err(await post(env(), good(at(T.minMs - 1)))), 'lap_too_fast');
  assert.equal((await post(env(), good(at(T.minMs)))).status, 200);
});

test('a track that is not open is unknown_track on post, top and ghost', async () => {
  assert.equal(await err(await post(env(), good({ track: 'x-v1' }))), 'unknown_track');
  for (const path of ['top', 'ghost']) {
    const r = await handleRaceApi(req('GET', `/race/${path}?track=x-v1`), env());
    assert.equal(r.status, 404); assert.equal(await err(r), 'unknown_track');
  }
});

// The Lagoon (5 Nov 2026): open with limits from its floor. Splits are the floor line's per-gate crossing ms, lap last, from
// tools/lapsim/results/lagoon.json on the site (copilot-check, `splits`); the trace is the lap's average speed, as above.
const LAG = 'lagoon-v2', LT = RACE_TRACKS[LAG];
const LAG_FLOOR_SPLITS = [5120, 6330, 7653, 11985, 14386, 16633, 19154, 21939, 23456, 25124, 26286, 29694];
const lagLap = (splits = LAG_FLOOR_SPLITS) => {
  const ms = splits.at(-1), cps = splits.slice(0, -1);
  const step = Math.max(100, Math.ceil(ms / 399 / 100) * 100), v = LT.length / (ms / 1000), trace = [];
  for (let t = 0; t <= ms; t += step) trace.push([t, (v * t) / 1000, 0, 0]);
  if (trace.at(-1)[0] !== ms) trace.push([ms, LT.length, 0, 0]);
  return { track: LAG, name: 'Ben', splits: cps, ms, trace };
};

test('the Lagoon is open with limits from its floor: minMs is 0.97 of 29694', () => {
  assert.ok(LT, 'lagoon-v2 is open'); assert.equal(raceTrack('lagoon-v1'), null); assert.equal(LT.checkpoints.length, 11);
  assert.equal(LT.minMs, Math.round(0.97 * 29694)); assert.equal(LT.minMs, 28803);
  assert.deepEqual([LT.maxSpeed, LT.segMaxSpeed], [30.8, 38]);
});

test('the Lagoon: a lap at minMs − 1000 is lap_too_fast', async () => {
  const ms = LT.minMs - 1000, f = ms / 29694;
  const splits = LAG_FLOOR_SPLITS.map(x => Math.round(x * f)); splits[splits.length - 1] = ms;
  assert.equal(await err(await post(env(), lagLap(splits))), 'lap_too_fast');
});

test('the Lagoon: a lap at the floor with the optimiser splits is accepted', async () => {
  const r = await post(env(), lagLap());
  assert.equal(r.status, 200); assert.equal((await r.json()).rank, 1);
});

test('the Lagoon: a lap that wades (inlet sector, gate 2 to gate 3, 4 s slower) is accepted', async () => {
  const s = LAG_FLOOR_SPLITS.map((x, i) => (i >= 2 ? x + 4000 : x)); // everything else keeps the floor's segments
  const r = await post(env(), lagLap(s));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).top[0].ms, 29694 + 4000);
});

test('the Lagoon: /race/top is 200 with an empty board', async () => {
  const r = await handleRaceApi(req('GET', `/race/top?track=${LAG}`), env());
  assert.equal(r.status, 200); assert.deepEqual((await r.json()).top, []);
});

test('ghost trace: up to 600 samples (a 60 s lap at ten a second), 601 refused', () => {
  assert.equal(RACE_TRACE_MAX, 600);
  const at = n => { const L = { ms: (n - 1) * 100 }; return traceFor(L); }; // n samples, 100 ms apart, the lap's whole length
  assert.equal(at(600).length, 600); assert.equal(at(601).length, 601);
  assert.equal(parseTrace(at(600), 59_900, T).ok, true);
  const over = parseTrace(at(601), 60_000, T);
  assert.equal(over.error, 'bad_trace'); assert.equal(over.why, 'shape');
  // and a post carrying 600 samples with the widest numbers a trace can hold fits under the body limit
  const wide = Array.from({ length: RACE_TRACE_MAX }, (_, i) => [100_000 + i, -604.9, -604.9, -3.14]);
  assert.ok(JSON.stringify(good({ name: 'n'.repeat(20), trace: wide, device: 'f'.repeat(32) })).length < RACE_MAX_BODY);
});
