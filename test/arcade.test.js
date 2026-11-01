import test from 'node:test'; import assert from 'node:assert/strict';
import { handleArcadeApi, parseScore, ARCADE_GAMES, ARCADE_PTS_PER_SEC, ARCADE_LEVEL_MS, ARCADE_LEVEL_PTS, ARCADE_RATE_SEC, ARCADE_KEEP, ARCADE_SHOW } from '../src/arcade.js';
import { RACE_ORIGINS, RACE_ADMIN_HEADER } from '../src/race.js';
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
  assert.equal(ARCADE_RATE_SEC, 10); assert.equal(ARCADE_KEEP, 100); assert.equal(ARCADE_SHOW, 10);
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

test('ordering: score desc, then earlier first; the public board shows ten, the worker keeps a hundred', async () => {
  const e = env();
  for (let i = 0; i < ARCADE_KEEP + 5; i++) await post(e, good({ name: `P${i}`, score: 100 + (i % 7) * 10, level: 2, ms: 20_000 }), { now: NOW + i });
  const t = await top(e); assert.equal(t.length, ARCADE_SHOW);
  for (let i = 1; i < t.length; i++) assert.ok(t[i - 1].score > t[i].score || (t[i - 1].score === t[i].score && t[i - 1].at <= t[i].at));
  const all = (await (await handleArcadeApi(req('GET', `/arcade/top?game=${GAME}`, { headers: { [RACE_ADMIN_HEADER]: ADMIN } }), env({ KV: e.KV, RACE_ADMIN_TOKEN: ADMIN }))).json()).all;
  assert.equal(all.length, ARCADE_KEEP); assert.ok(all[0].id && all[0].ms);
});

test('rate limit: one post per address per 10 s, valid or not', async () => {
  const e = env(); const ip = '5.5.5.5';
  assert.equal((await post(e, good({ score: 0 }), { ip, now: NOW })).status, 400);
  const r = await post(e, good(), { ip, now: NOW + 1000 });
  assert.equal(r.status, 429); assert.equal(await err(r), 'rate'); assert.ok(Number(r.headers.get('retry-after')) <= ARCADE_RATE_SEC);
  assert.equal((await post(e, good(), { ip, now: NOW + ARCADE_RATE_SEC * 1000 + 1 })).status, 200);
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
