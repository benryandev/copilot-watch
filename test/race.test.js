import test from 'node:test'; import assert from 'node:assert/strict';
import { handleRaceApi, parseTime, isRude, cleanName, RACE_ORIGINS, RACE_KEEP, RACE_SHOW, RACE_ADMIN_HEADER } from '../src/race.js';
import { RACE_TRACKS, RACE_MAX_SPEED, RACE_MAX_MS } from '../src/race-tracks.js';
import handler from '../src/worker.js';
import { memKV } from './kv-mem.js';

// Every expected time below comes from the track constant, so swapping in the real track numbers needs no test changes.
const TRACK = 'realfi-v1', T = RACE_TRACKS[TRACK], O = RACE_ORIGINS[0], NOW = Date.UTC(2026, 9, 30), ADMIN = 'test-admin-token-1234';
const minMs = m => (m * 1000) / RACE_MAX_SPEED;
/** A clean lap at `speed` m/s (well under RACE_MAX_SPEED). */
const lap = (speed = 20) => ({ splits: T.checkpoints.map(d => Math.round((d * 1000) / speed)), ms: Math.round((T.length * 1000) / speed) });
const good = (over = {}) => ({ track: TRACK, name: 'Ben', ...lap(), ...over });
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
  const fast0 = Math.ceil(minMs(cps[0])) - 1;
  const s0 = [fast0, ...L.splits.slice(1)];
  assert.deepEqual([parseTime(good({ splits: s0 })).error, parseTime(good({ splits: s0 })).segment], ['segment_too_fast', 0]);
  // a middle segment too fast
  if (cps.length > 1) {
    const s = [...L.splits]; s[1] = s[0] + Math.ceil(minMs(cps[1] - cps[0])) - 1;
    assert.equal(parseTime(good({ splits: s })).segment, 1);
  }
  // the final segment (last checkpoint to the line) too fast
  const finalMin = minMs(T.length - cps.at(-1));
  assert.equal(parseTime(good({ ms: L.splits.at(-1) + Math.ceil(finalMin) - 1 })).segment, cps.length);
  // exactly at the minimum is allowed
  const exact = cps.map(d => Math.ceil(minMs(d)));
  const seg = cps.map((d, i) => minMs(d - (i ? cps[i - 1] : 0)));
  if (exact.every((x, i) => x - (i ? exact[i - 1] : 0) >= seg[i])) assert.ok(parseTime(good({ splits: exact, ms: exact.at(-1) + Math.ceil(finalMin) + 1 })).ok);
  // whole lap below the minimum lap time
  const lapMin = minMs(T.length);
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

test('rate limit: one post per IP per 60 s, counted even when invalid; another IP is fine', async () => {
  const e = env(); const ip = '9.9.9.9';
  assert.equal((await post(e, good({ name: 'x'.repeat(30) }), { ip })).status, 400); // invalid, still counts
  const r = await post(e, good(), { ip, now: NOW + 20_000 });
  assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '40'); assert.equal(await err(r), 'rate');
  assert.equal((await post(e, good(), { ip: '8.8.8.8' })).status, 200);
  e.KV.now = 61_000; // memKV clock: the 60 s key has expired
  assert.equal((await post(e, good({ name: 'Other' }), { ip, now: NOW + 61_000 })).status, 200);
  // unparseable JSON and oversized bodies are refused before the limit and don't count
  const e2 = env();
  assert.equal((await post(e2, '{nope', { ip })).status, 400);
  assert.equal((await post(e2, 'x'.repeat(5000), { ip })).status, 413);
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
