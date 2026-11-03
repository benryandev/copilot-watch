import test from 'node:test'; import assert from 'node:assert/strict';
import { handleArcadeApi, parseScore, ARCADE_GAMES, ARCADE_PTS_PER_SEC, ARCADE_LEVEL_MS, ARCADE_LEVEL_PTS, ARCADE_RATE_SEC, ARCADE_RATE_BURST, ARCADE_ADDR_ROWS, ARCADE_KEEP, ARCADE_SHOW } from '../src/arcade.js';
import { RACE_ORIGINS, RACE_ADMIN_HEADER, hashHex } from '../src/race.js';
import handler from '../src/worker.js';
import { memKV } from './kv-mem.js';

const GAME = 'flappy-coin', G = ARCADE_GAMES[GAME], O = RACE_ORIGINS[0], NOW = Date.UTC(2026, 10, 1), ADMIN = 'test-admin-token-1234';
// A believable run: level 4 after 50 s with 300 points (80 × 3 = 240 is the floor for level 4; 40 pts/s allows 2000)
const good = (over = {}) => ({ game: GAME, name: 'Ben', score: 300, level: 4, won: false, ms: 50_000, ...over });
const env = (o = {}) => ({ KV: memKV(), ...o });
const req = (method, path, { body, origin = O, ip = '1.1.1.1', headers = {} } = {}) => new Request(`https://w${path}`, {
  method, headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers },
  ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
let ipN = 0; const freshIp = () => `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}`;
const post = (e, body, o = {}) => handleArcadeApi(req('POST', '/arcade/score', { ip: freshIp(), body, ...o }), e, { now: o.now ?? NOW });
const top = async e => (await (await handleArcadeApi(req('GET', `/arcade/top?game=${GAME}`), e)).json()).top;
const err = async r => (await r.json()).error;

test('constants are what the plan says', () => {
  assert.equal(ARCADE_PTS_PER_SEC, 40); assert.equal(ARCADE_LEVEL_MS, 6000); assert.equal(ARCADE_LEVEL_PTS, 80);
  assert.equal(ARCADE_RATE_SEC, 10); assert.equal(ARCADE_RATE_BURST, 5); assert.equal(ARCADE_ADDR_ROWS, 5);
  assert.equal(ARCADE_KEEP, 100); assert.equal(ARCADE_SHOW, 10);
  assert.equal(G.scoreMax, 2600); assert.equal(G.levelMax, 10); assert.equal(G.maxMs, 30 * 60_000);
});

test('a believable run is accepted and shown', async () => {
  const e = env(); const r = await post(e, good());
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.ok, true); assert.equal(b.rank, 1); assert.equal(b.best, true);
  assert.deepEqual(b.top, [{ name: 'Ben', score: 300, level: 4, won: false, at: NOW }]);
  assert.deepEqual(await top(e), b.top);
});

test('validation: game, name, score, level, won, ms and the pacing rules', () => {
  const cases = [
    [{ game: 'pong' }, 'unknown_game'], [{ game: '__proto__' }, 'unknown_game'], [{ game: 7 }, 'unknown_game'],
    [{ name: '' }, 'bad_name'], [{ name: 'x'.repeat(21) }, 'bad_name'], [{ name: 'fuck' }, 'rude_name'],
    [{ score: 0 }, 'bad_score'], [{ score: -5 }, 'bad_score'], [{ score: 10.5 }, 'bad_score'], [{ score: '300' }, 'bad_score'], [{ score: G.scoreMax + 1, ms: G.maxMs - 1 }, 'bad_score'],
    [{ level: 0 }, 'bad_level'], [{ level: 11 }, 'bad_level'], [{ level: 2.5 }, 'bad_level'], [{ level: '4' }, 'bad_level'],
    [{ won: 'yes' }, 'bad_won'], [{ won: true }, 'bad_won'], // won needs level 10
    [{ ms: 0 }, 'bad_ms'], [{ ms: 1.5 }, 'bad_ms'], [{ ms: G.maxMs }, 'bad_ms'], [{ ms: '50000' }, 'bad_ms'],
    [{ score: 2000, ms: 20_000 }, 'too_fast'], // 100 pts/s
    [{ level: 4, ms: 17_000 }, 'level_too_fast'], // three levels need 18 s
    [{ level: 4, score: 239 }, 'level_score'], // level 4 means 24 candles passed = 240 points at least
  ];
  for (const [over, want] of cases) assert.equal(parseScore(good(over)).error, want, JSON.stringify(over));
  assert.equal(parseScore(null).error, 'bad_json'); assert.equal(parseScore([]).error, 'bad_json');
  // The edges pass
  assert.equal(parseScore(good({ score: 2000, ms: 50_000 })).ok, true);
  assert.equal(parseScore(good({ level: 4, ms: 18_000 })).ok, true);
  assert.equal(parseScore(good({ level: 4, score: 240 })).ok, true);
  assert.equal(parseScore(good({ level: 10, won: true, score: 1000, ms: 120_000 })).ok, true);
  assert.equal(parseScore(good({ level: 1, score: 10, ms: 2000 })).ok, true);
  const e = parseScore(good({ name: '  Ben  Ryan ' })); assert.equal(e.entry.name, 'Ben Ryan'); assert.equal(e.entry.key, 'ben ryan');
});

test('one row per name: a higher score replaces, a lower one is kept out', async () => {
  const e = env();
  await post(e, good({ score: 300 }));
  let r = await (await post(e, good({ name: 'ben', score: 200, level: 3, ms: 30_000 }))).json();
  assert.equal(r.best, false); assert.equal(r.rank, 1);
  assert.deepEqual((await top(e)).map(x => x.score), [300]);
  r = await (await post(e, good({ name: 'BEN', score: 400, level: 5, ms: 60_000 }))).json();
  assert.equal(r.best, true);
  const t = await top(e); assert.equal(t.length, 1); assert.equal(t[0].name, 'BEN'); assert.equal(t[0].score, 400);
});

test('one row per address: a better score under a new name replaces the old row', async () => {
  const e = env(); const ip = '7.7.7.7';
  await post(e, good({ name: 'Juno', score: 300 }), { ip, now: NOW });
  await post(e, good({ name: 'Rook', score: 500, level: 6, ms: 70_000 }), { ip, now: NOW + 20_000 });
  const t = await top(e); assert.deepEqual(t.map(x => [x.name, x.score]), [['Rook', 500]]);
  // a lower one under a third name changes nothing
  await post(e, good({ name: 'Pip', score: 100, level: 2, ms: 10_000 }), { ip, now: NOW + 40_000 });
  assert.equal((await top(e)).length, 1);
});

// ---- devices: people who share one public address (an office on one wifi, 4 Nov 2026) ----

// A device token is 16 random bytes as hex, made once by the page and kept in its storage
const dev = i => i.toString(16).padStart(32, '0');
const adminRows = async e => (await (await handleArcadeApi(req('GET', `/arcade/top?game=${GAME}`, { headers: { [RACE_ADMIN_HEADER]: ADMIN } }), env({ KV: e.KV, RACE_ADMIN_TOKEN: ADMIN }))).json()).all;

test('devices: two devices on one address each get a row; the same device lower keeps its row, higher under a new name replaces it', async () => {
  const e = env(); const ip = '7.7.7.7';
  let r = await (await post(e, good({ name: 'Tynus', score: 300, device: dev(1) }), { ip, now: NOW })).json();
  assert.equal(r.rank, 1); assert.equal(r.best, true);
  // a colleague on the same wifi, another device: their own row
  r = await (await post(e, good({ name: 'Mara', score: 280, device: dev(2) }), { ip, now: NOW + 20_000 })).json();
  assert.equal(r.best, true); assert.equal(r.rank, 2);
  assert.deepEqual(r.top.map(x => x.name), ['Tynus', 'Mara']);
  // the first device again, lower, a new name: nothing changes; the reply ranks the row it holds
  r = await (await post(e, good({ name: 'Tynus 2', score: 250, device: dev(1) }), { ip, now: NOW + 40_000 })).json();
  assert.equal(r.best, false); assert.equal(r.rank, 1);
  assert.deepEqual(r.top.map(x => x.name), ['Tynus', 'Mara']);
  // the first device, higher, a new name: its one row is replaced, name and all (the name-variant hole stays closed)
  r = await (await post(e, good({ name: 'TYNUS!!', score: 400, level: 5, ms: 60_000, device: dev(1) }), { ip, now: NOW + 60_000 })).json();
  assert.equal(r.best, true);
  assert.deepEqual(r.top.map(x => [x.name, x.score]), [['TYNUS!!', 400], ['Mara', 280]]);
  // the hashes never leave the worker, and neither the token nor the address lands in KV as given
  for (const row of r.top) assert.deepEqual(Object.keys(row).sort(), ['at', 'level', 'name', 'score', 'won']);
  for (const row of await adminRows(e)) assert.ok(!('ipk' in row) && !('ak' in row) && !('key' in row));
  const stored = [...e.KV.m.keys(), ...e.KV.m.values()].map(x => JSON.stringify(x)).join('\n');
  assert.ok(!stored.includes(dev(1)) && !stored.includes(dev(2)) && !stored.includes(ip));
});

test('devices: one name stays one row, whether the same device or two devices on one address post it', async () => {
  const e = env(); const ip = '7.7.7.8';
  await post(e, good({ name: 'Office', score: 300, device: dev(1) }), { ip, now: NOW });
  const r = await (await post(e, good({ name: 'office', score: 500, level: 6, ms: 70_000, device: dev(2) }), { ip, now: NOW + 20_000 })).json();
  assert.equal(r.best, true); assert.equal(r.rank, 1);
  assert.deepEqual(r.top.map(x => [x.name, x.score]), [['office', 500]]);
  // lower under the same name from a third device: no second row
  const s = await (await post(e, good({ name: 'OFFICE', score: 300, device: dev(3) }), { ip, now: NOW + 40_000 })).json();
  assert.equal(s.best, false); assert.equal(s.rank, 1);
  assert.equal((await top(e)).length, 1);
});

test('devices: five devices fill an address, a sixth is refused with address_full; a device on the board can still improve its row', async () => {
  const e = env(); const ip = '7.7.7.9';
  for (let i = 1; i <= ARCADE_ADDR_ROWS; i++) {
    const r = await post(e, good({ name: `Desk ${i}`, score: 300 + i * 10, device: dev(i) }), { ip, now: NOW + i * 20_000 });
    assert.equal(r.status, 200, `device ${i}`); assert.equal((await r.json()).best, true, `device ${i}`);
  }
  const sixth = await post(e, good({ name: 'Desk 6', score: 400, device: dev(6) }), { ip, now: NOW + 6 * 20_000 });
  assert.equal(sixth.status, 409); assert.equal(await err(sixth), 'address_full');
  assert.deepEqual((await top(e)).map(x => x.name), ['Desk 5', 'Desk 4', 'Desk 3', 'Desk 2', 'Desk 1']);
  // a device already on the board improves its own row while the address is full
  const again = await (await post(e, good({ name: 'Desk 1', score: 500, level: 6, ms: 70_000, device: dev(1) }), { ip, now: NOW + 7 * 20_000 })).json();
  assert.equal(again.best, true); assert.equal(again.rank, 1);
  // a lower score from a device on the board is "already on the board", not a refusal
  const lower = await post(e, good({ name: 'Desk 2', score: 250, device: dev(2) }), { ip, now: NOW + 8 * 20_000 });
  assert.equal(lower.status, 200); assert.equal((await lower.json()).best, false);
  // another address is not affected
  assert.equal((await post(e, good({ name: 'Home', device: dev(7) }), { ip: '6.6.6.7', now: NOW + 9 * 20_000 })).status, 200);
  assert.equal((await top(e)).length, ARCADE_ADDR_ROWS + 1);
});

test('devices: a post without a token, or with a malformed one, is keyed by the address alone as before', async () => {
  const e = env(); const ip = '7.7.8.1';
  let r = await (await post(e, good({ name: 'Old page', score: 300 }), { ip, now: NOW })).json();
  assert.equal(r.best, true);
  // a malformed token counts as none: the same player as the token-less post, so its row is replaced, not joined
  r = await (await post(e, good({ name: 'Old page 2', score: 400, level: 5, ms: 60_000, device: 'not-a-token' }), { ip, now: NOW + 20_000 })).json();
  assert.equal(r.best, true); assert.deepEqual(r.top.map(x => x.name), ['Old page 2']);
  for (const bad of [42, '', 'g'.repeat(32), dev(1).slice(1), dev(1) + '0', null, {}, [dev(1)]]) assert.equal(parseScore(good({ device: bad })).entry.device, null, JSON.stringify(bad));
  assert.equal(parseScore(good({ device: dev(255) })).entry.device, dev(255));
  assert.equal(parseScore(good({ device: dev(255).toUpperCase() })).entry.device, dev(255), 'upper case is the same token');
});

test('devices: a row from before tokens counts toward the address cap, and a post without a token still replaces it', async () => {
  const e = env(); const ip = '7.7.8.2';
  // the board holds this address's one row from before tokens (ipk = the address hash, no ak)
  const ak = await hashHex(`arcade:board:${ip}`);
  await e.KV.put(`arcade:top:${GAME}`, JSON.stringify([{ id: 'old1', name: 'Old', key: 'old', ipk: ak, score: 260, level: 3, won: false, ms: 40_000, at: NOW - 1 }]));
  // four devices on the address take rows two to five
  for (let i = 1; i < ARCADE_ADDR_ROWS; i++) {
    const r = await post(e, good({ name: `Desk ${i}`, score: 300 + i * 10, device: dev(i) }), { ip, now: NOW + i * 20_000 });
    assert.equal(r.status, 200, `device ${i}`);
  }
  assert.equal((await top(e)).length, ARCADE_ADDR_ROWS);
  // a fifth device would be the sixth row: the address is full
  const full = await post(e, good({ name: 'Desk 5', score: 500, level: 6, ms: 70_000, device: dev(5) }), { ip, now: NOW + 6 * 20_000 });
  assert.equal(full.status, 409); assert.equal(await err(full), 'address_full');
  // the old page (no token) from this address still replaces the old row as one player
  const o = await (await post(e, good({ name: 'Old 2', score: 600, level: 7, ms: 80_000 }), { ip, now: NOW + 7 * 20_000 })).json();
  assert.equal(o.best, true);
  assert.deepEqual((await top(e)).map(x => x.name), ['Old 2', 'Desk 4', 'Desk 3', 'Desk 2', 'Desk 1']);
});

test('ordering: score desc, then earlier first; the public board shows ten, the worker keeps a hundred', async () => {
  const e = env();
  for (let i = 0; i < ARCADE_KEEP + 5; i++) await post(e, good({ name: `P${i}`, score: 100 + (i % 7) * 10, level: 2, ms: 20_000 }), { now: NOW + i });
  const t = await top(e); assert.equal(t.length, ARCADE_SHOW);
  for (let i = 1; i < t.length; i++) assert.ok(t[i - 1].score > t[i].score || (t[i - 1].score === t[i].score && t[i - 1].at <= t[i].at));
  const all = (await (await handleArcadeApi(req('GET', `/arcade/top?game=${GAME}`, { headers: { [RACE_ADMIN_HEADER]: ADMIN } }), env({ KV: e.KV, RACE_ADMIN_TOKEN: ADMIN }))).json()).all;
  assert.equal(all.length, ARCADE_KEEP); assert.ok(all[0].id && all[0].ms);
});

test(`rate limit: ${ARCADE_RATE_BURST} posts per address per ${ARCADE_RATE_SEC} s (an office), valid or not, however many devices; another address is fine`, async () => {
  const e = env(); const ip = '5.5.5.5';
  assert.equal((await post(e, good({ score: 0 }), { ip, now: NOW })).status, 400); // invalid, still counts
  // colleagues on one wifi finishing within seconds of each other: the budget takes them
  for (let i = 1; i < ARCADE_RATE_BURST; i++) assert.equal((await post(e, good({ name: `Desk ${i}`, device: dev(i) }), { ip, now: NOW + i * 500 })).status, 200, `post ${i + 1} of ${ARCADE_RATE_BURST}`);
  // a token is free to mint, so a new device does not buy another post: the budget is the address's
  const r = await post(e, good({ name: 'Desk 9', device: dev(9) }), { ip, now: NOW + 4_000 });
  assert.equal(r.status, 429); assert.equal(await err(r), 'rate'); assert.equal(r.headers.get('retry-after'), String(ARCADE_RATE_SEC - 4));
  assert.equal((await post(e, good(), { ip: '5.5.5.6', now: NOW + 4_000 })).status, 200);
  // the window has passed but the key (60 s, KV's minimum TTL) is still there: a new window starts on the stored time
  assert.equal((await post(e, good({ name: 'Other' }), { ip, now: NOW + ARCADE_RATE_SEC * 1000 + 1000 })).status, 200);
  for (let i = 1; i < ARCADE_RATE_BURST; i++) assert.equal((await post(e, good({ name: 'Again' }), { ip, now: NOW + ARCADE_RATE_SEC * 1000 + 1000 + i })).status, 200);
  assert.equal((await post(e, good({ name: 'Again' }), { ip, now: NOW + ARCADE_RATE_SEC * 1000 + 2000 })).status, 429);
  e.KV.now = 61_000; // memKV clock: the key has expired
  assert.equal((await post(e, good({ name: 'Third' }), { ip, now: NOW + 61_000 })).status, 200);
  // a key written before the budget existed (a bare timestamp) reads as one post in its window
  const e3 = env(); await e3.KV.put('arcade:ip:' + await hashHex(`arcade:${ip}`), String(NOW));
  for (let i = 1; i < ARCADE_RATE_BURST; i++) assert.equal((await post(e3, good(), { ip, now: NOW + i })).status, 200, `old key, post ${i + 1}`);
  assert.equal((await post(e3, good(), { ip, now: NOW + ARCADE_RATE_BURST })).status, 429);
  // the IP itself is never stored, only a hash
  assert.ok(![...e.KV.m.keys(), ...e.KV.m.values()].some(x => JSON.stringify(x).includes(ip)));
});

test('origin: posts from elsewhere are refused; reads are open; preflight answers', async () => {
  const e = env();
  assert.equal((await post(e, good(), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(e, good(), { origin: '' })).status, 403);
  assert.equal((await handleArcadeApi(req('GET', `/arcade/top?game=${GAME}`, { origin: 'https://evil.example' }), e)).status, 200);
  assert.equal((await handleArcadeApi(req('GET', `/arcade/top?game=pong`), e)).status, 404);
  assert.equal((await handleArcadeApi(req('OPTIONS', '/arcade/score'), e)).status, 204);
  assert.equal((await handleArcadeApi(req('OPTIONS', '/arcade/score', { origin: 'https://evil.example' }), e)).status, 403);
});

test('admin delete by id or name; no token, no delete', async () => {
  const e = env({ RACE_ADMIN_TOKEN: ADMIN });
  await post(e, good({ name: 'Juno' })); await post(e, good({ name: 'Rook', score: 250 }));
  const all = (await (await handleArcadeApi(req('GET', `/arcade/top?game=${GAME}`, { headers: { [RACE_ADMIN_HEADER]: ADMIN } }), e)).json()).all;
  const del = (body, headers) => handleArcadeApi(req('DELETE', '/arcade/score', { body, headers }), e);
  assert.equal((await del({ game: GAME, id: all[0].id })).status, 401);
  assert.equal((await del({ game: GAME, id: all[0].id }, { [RACE_ADMIN_HEADER]: 'wrong' })).status, 403);
  assert.equal((await del({ game: GAME, id: all[0].id }, { [RACE_ADMIN_HEADER]: ADMIN })).status, 200);
  assert.equal((await del({ game: GAME, name: 'rook' }, { [RACE_ADMIN_HEADER]: ADMIN })).status, 200);
  assert.deepEqual(await top(e), []);
  assert.equal((await del({ game: GAME, name: 'nobody' }, { [RACE_ADMIN_HEADER]: ADMIN })).status, 404);
  assert.equal((await handleArcadeApi(req('DELETE', '/arcade/score', { body: { game: GAME, id: 'x' }, headers: { [RACE_ADMIN_HEADER]: ADMIN } }), env())).status, 403, 'admin disabled without the secret');
});

test('the worker routes /arcade/', async () => {
  const e = env();
  const r = await handler.fetch(req('GET', `/arcade/top?game=${GAME}`), e, { waitUntil() {} });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { game: GAME, top: [] });
});
