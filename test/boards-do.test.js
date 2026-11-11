// The Boards Durable Object: one writer per leaderboard, mirrored to KV (plan 2026-11-06-board-writer, Task 2)
import test from 'node:test'; import assert from 'node:assert/strict';
import { Boards, kvOver } from '../src/boards-do.js';
import handler from '../src/world-worker.js';
import { RACE_ADMIN_HEADER } from '../src/race.js';
import { memKV } from './kv-mem.js';

// A stand-in for a Durable Object's ctx: Map-backed storage, and blockConcurrencyWhile running callbacks one at a time
function fakeCtx() {
  const m = new Map(); let chain = Promise.resolve();
  const storage = { get: async k => m.has(k) ? m.get(k) : undefined, put: async (k, v) => { m.set(k, v); }, delete: async k => m.delete(k), deleteAll: async () => m.clear(), m };
  return { storage, blockConcurrencyWhile: fn => (chain = chain.then(fn, fn)) };
}
const KEY = 'race:top:lagoon-v2';
const call = (obj, op, args = {}, key = KEY) => obj.fetch(new Request('https://boards/op', { method: 'POST', body: JSON.stringify({ op, key, args }) }));
const entry = (name, ms, ipk = name) => ({ track: 'lagoon-v2', name, key: name.toLowerCase(), ms, splits: [1, 2], trace: null, ipk, ak: 'addr-' + name });
const rowsOf = async r => { assert.equal(r.status, 200); return r.json(); };

test('kvOver stores strings and parses json on the way out', async () => {
  const ctx = fakeCtx(), kv = kvOver(ctx.storage);
  await kv.put('k', JSON.stringify([1, 2]));
  assert.equal(await kv.get('k'), '[1,2]');
  assert.deepEqual(await kv.get('k', 'json'), [1, 2]);
  assert.equal(await kv.get('missing', 'json'), null);
});

test('first request seeds from KV once; a failed KV read stores nothing and the next request seeds', async () => {
  const kv = memKV(); await kv.put(KEY, JSON.stringify([{ name: 'A', ms: 30000 }, { name: 'B', ms: 30100 }, { name: 'C', ms: 30200 }]));
  const ctx = fakeCtx(), b = new Boards(ctx, { KV: kv });
  assert.equal((await rowsOf(await call(b, 'read'))).length, 3);
  assert.ok(ctx.storage.m.has(KEY));
  // a KV that fails while seeding
  const ctx2 = fakeCtx(); let fail = true;
  const flaky = { get: async (...a) => { if (fail) throw new Error('kv down'); return kv.get(...a); }, put: kv.put };
  const b2 = new Boards(ctx2, { KV: flaky });
  assert.equal((await call(b2, 'read')).status, 500);
  assert.equal(ctx2.storage.m.size, 0, 'nothing stored over a board it could not read');
  fail = false;
  assert.equal((await rowsOf(await call(b2, 'read'))).length, 3);
});

test('two posts at once on one board both survive, in storage and in the KV mirror', async () => {
  const kv = memKV(), b = new Boards(fakeCtx(), { KV: kv });
  const [ra, rb] = await Promise.all([call(b, 'raceAdd', { entry: entry('Tynus', 30313), now: 1 }), call(b, 'raceAdd', { entry: entry('Ninja1', 30372), now: 2 })]);
  assert.equal((await ra.json()).rank, 1); assert.equal((await rb.json()).best, true);
  const names = (await rowsOf(await call(b, 'read'))).map(r => r.name);
  assert.deepEqual(names, ['Tynus', 'Ninja1']);
  assert.deepEqual((await kv.get(KEY, 'json')).map(r => r.name), ['Tynus', 'Ninja1']);
});

test('a failed mirror write still answers ok, keeps the row and logs board mirror failed', async () => {
  const kv = memKV(), b = new Boards(fakeCtx(), { KV: { get: kv.get, put: async () => { throw new Error('kv down'); } } });
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  try {
    const r = await call(b, 'raceAdd', { entry: entry('Tynus', 30313), now: 1 });
    assert.equal(r.status, 200); assert.equal((await r.json()).rank, 1);
  } finally { console.log = orig; }
  assert.equal((await rowsOf(await call(b, 'read'))).length, 1);
  assert.equal(logs.filter(l => l.startsWith('board mirror failed')).length, 1);
});

test('reseed drops the stale copy so the next request reads KV', async () => {
  const kv = memKV(), ctx = fakeCtx(), b = new Boards(ctx, { KV: kv });
  await call(b, 'raceAdd', { entry: entry('Old', 31000), now: 1 });
  await kv.put(KEY, JSON.stringify([{ name: 'Newer', ms: 30000 }])); // posted to KV while the writer was off
  assert.equal((await rowsOf(await call(b, 'read')))[0].name, 'Old', 'stale until reseeded');
  assert.equal((await call(b, 'reseed')).status, 200);
  assert.equal((await rowsOf(await call(b, 'read')))[0].name, 'Newer');
});

test('removes and the arcade ops run the same rules', async () => {
  const kv = memKV(), b = new Boards(fakeCtx(), { KV: kv });
  await call(b, 'raceAdd', { entry: entry('Tynus', 30313), now: 1 });
  assert.deepEqual(await (await call(b, 'raceRemove', { track: 'lagoon-v2', name: 'tynus' })).json(), { removed: 1 });
  const AK = 'arcade:top:flappy-coin', ab = new Boards(fakeCtx(), { KV: kv });
  const e = { game: 'flappy-coin', name: 'Juno', key: 'juno', score: 640, level: 7, won: false, ms: 90000, ipk: 'j', ak: 'aj' };
  assert.equal((await (await call(ab, 'arcadeAdd', { entry: e, now: 1 }, AK)).json()).rank, 1);
  assert.equal((await rowsOf(await call(ab, 'read', {}, AK)))[0].score, 640);
  assert.deepEqual(await (await call(ab, 'arcadeRemove', { game: 'flappy-coin', name: 'Juno' }, AK)).json(), { removed: 1 });
  assert.equal((await call(ab, 'nope', {}, AK)).status, 400);
});

test('the worker routes: admin header required, keys checked, each key to its own instance; reseed fans out', async () => {
  const seen = [];
  const BOARDS = { idFromName: n => 'id:' + n, get: id => ({ fetch: async req => { seen.push([id, (await req.json()).op]); return new Response('[]'); } }) };
  const env = { KV: memKV(), BOARDS, RACE_ADMIN_TOKEN: 'admin-1', WORLD: {} };
  const post = (path, body, admin = true) => handler.fetch(new Request(`https://w${path}`, { method: 'POST', headers: admin ? { [RACE_ADMIN_HEADER]: 'admin-1' } : {}, body: JSON.stringify(body) }), env);
  assert.equal((await post('/board/op', { op: 'read', key: KEY }, false)).status, 403);
  assert.equal((await post('/board/op', { op: 'read', key: 'telegram:chat:1' })).status, 400);
  assert.equal((await post('/board/op', { op: 'read', key: KEY })).status, 200);
  assert.deepEqual(seen.pop(), ['id:' + KEY, 'read']);
  const r = await post('/board/reseed', { keys: [KEY, 'race:top:realfi-v1'] });
  assert.deepEqual(await r.json(), { ok: true, keys: [KEY, 'race:top:realfi-v1'] });
  assert.deepEqual(seen, [['id:' + KEY, 'reseed'], ['id:race:top:realfi-v1', 'reseed']]);
});

test('a full race board (100 rows, 400-sample traces) stays under the 2 MB value cap', () => {
  const trace = Array.from({ length: 400 }, (_, i) => [i * 100, 123.4, -456.7, 1.23]);
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: 'x'.repeat(22), name: 'n'.repeat(20), key: 'n'.repeat(20), ipk: 'h'.repeat(64), ak: 'h'.repeat(64), ms: 30000 + i, splits: Array(11).fill(12345), trace, at: 1793969189623 }));
  const len = JSON.stringify(rows).length;
  assert.ok(len < 2 * 1024 * 1024, `${len} bytes`);
});

test('a full race board with 600-sample traces at their widest numbers stays under the 2 MB value cap', () => {
  const trace = Array.from({ length: 600 }, (_, i) => [100_000 + i, -604.9, -604.9, -3.14]);
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: 'x'.repeat(22), name: 'n'.repeat(20), key: 'n'.repeat(20), ipk: 'h'.repeat(64), ak: 'h'.repeat(64), ms: 30000 + i, splits: Array(11).fill(12345), trace, at: 1793969189623 }));
  const len = JSON.stringify(rows).length;
  assert.ok(len < 2 * 1024 * 1024, `${len} bytes`);
});

test('mirror writes land in order: a slow first put never leaves KV behind the board', async () => {
  // KV whose first put is slow and whose second is fast: without ordering, A's older board lands last
  const kv = memKV(), realPut = kv.put; let n = 0;
  kv.put = async (k, v, o) => { const slow = ++n === 1; await new Promise(r => setTimeout(r, slow ? 30 : 0)); return realPut(k, v, o); };
  const b = new Boards(fakeCtx(), { KV: kv });
  await Promise.all([call(b, 'raceAdd', { entry: entry('Tynus', 30313), now: 1 }), call(b, 'raceAdd', { entry: entry('Ninja1', 30372), now: 2 })]);
  await b.mirrored; // the object's mirror chain, settled
  assert.deepEqual((await kv.get(KEY, 'json')).map(r => r.name), ['Tynus', 'Ninja1']);
});
