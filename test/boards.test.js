// copilot-watch's side of the leaderboard writer (plan 2026-11-06-board-writer, Task 1): with BOARD_WRITER = "do" every
// board read and change goes over the WORLD binding to the Boards objects; without it, KV as before.
import test from 'node:test'; import assert from 'node:assert/strict';
import { handleRaceApi, RACE_ORIGINS, RACE_ADMIN_HEADER } from '../src/race.js';
import { handleArcadeApi } from '../src/arcade.js';
import { RACE_TRACKS } from '../src/race-tracks.js';
import { Boards } from '../src/boards-do.js';
import worldWorker from '../src/world-worker.js';
import { memKV } from './kv-mem.js';

const TRACK = 'realfi-v1', T = RACE_TRACKS[TRACK], O = RACE_ORIGINS[0], NOW = Date.UTC(2026, 10, 6), ADMIN = 'test-admin-token-1234';
const lap = (speed = 20) => ({ splits: T.checkpoints.map(d => Math.round((d * 1000) / speed)), ms: Math.round((T.length * 1000) / speed) });
const traceFor = L => { const v = T.length / (L.ms / 1000), out = []; for (let t = 0; t <= L.ms; t += 100) out.push([t, (v * t) / 1000, 0, 0]); if (out.at(-1)[0] !== L.ms) out.push([L.ms, T.length, 0, 0]); return out; };
const goodLap = (name = 'Ben', speed = 20) => { const L = lap(speed); return { track: TRACK, name, ...L, trace: traceFor(L) }; };
const goodRun = (name = 'Ben') => ({ game: 'flappy-coin', name, score: 300, level: 4, won: false, ms: 50_000 });
let ipN = 0; const freshIp = () => `10.7.${Math.floor(++ipN / 250)}.${ipN % 250}`;
const req = (method, path, body) => new Request(`https://w${path}`, { method, headers: { origin: O, 'content-type': 'application/json', 'cf-connecting-ip': freshIp() }, ...(body ? { body: JSON.stringify(body) } : {}) });

function fakeCtx() {
  const m = new Map(); let chain = Promise.resolve();
  return { storage: { get: async k => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async k => m.delete(k), deleteAll: async () => m.clear() }, blockConcurrencyWhile: fn => (chain = chain.then(fn, fn)) };
}
// The WORLD binding: /board/* through the real copilot-world worker and real Boards objects; anything else (the record
// announcement) answers ok. `fail` makes the board routes answer 500.
function fakeWorld(kv, { fail = false } = {}) {
  const objects = new Map(), calls = [];
  const BOARDS = { idFromName: n => n, get: id => { if (!objects.has(id)) objects.set(id, new Boards(fakeCtx(), { KV: kv })); return objects.get(id); } };
  const worldEnv = { KV: kv, BOARDS, RACE_ADMIN_TOKEN: ADMIN };
  return { calls, fetch: async (url, init) => {
    const r = url instanceof Request ? url : new Request(url, init);
    const path = new URL(r.url).pathname; calls.push(path);
    if (!path.startsWith('/board/')) return new Response('{"ok":true}');
    if (fail) return new Response('{"error":"down"}', { status: 500 });
    return worldWorker.fetch(r, worldEnv);
  } };
}
const envDO = (o = {}) => { const KV = memKV(); return { KV, WORLD: fakeWorld(KV, o), RACE_ADMIN_TOKEN: ADMIN, BOARD_WRITER: 'do' }; };
const boardCalls = e => e.WORLD.calls.filter(p => p.startsWith('/board/')).length;

test('DO mode: a posted lap is in the next /race/top and /race/ghost, and KV holds the mirror', async () => {
  const e = envDO();
  const r = await handleRaceApi(req('POST', '/race/time', goodLap('Tynus')), e, { now: NOW });
  assert.equal(r.status, 200); assert.equal((await r.json()).rank, 1);
  const top = (await (await handleRaceApi(req('GET', `/race/top?track=${TRACK}`), e)).json()).top;
  assert.deepEqual(top.map(x => x.name), ['Tynus']);
  assert.equal((await (await handleRaceApi(req('GET', `/race/ghost?track=${TRACK}`), e)).json()).ghost.name, 'Tynus');
  assert.deepEqual((await e.KV.get(`race:top:${TRACK}`, 'json')).map(x => x.name), ['Tynus']);
  assert.ok(boardCalls(e) >= 3);
});

test('KV mode (no BOARD_WRITER): no board work reaches the WORLD binding', async () => {
  const KV = memKV(), e = { KV, WORLD: fakeWorld(KV), RACE_ADMIN_TOKEN: ADMIN };
  assert.equal((await handleRaceApi(req('POST', '/race/time', goodLap()), e, { now: NOW })).status, 200);
  await handleRaceApi(req('GET', `/race/top?track=${TRACK}`), e);
  assert.equal((await handleArcadeApi(req('POST', '/arcade/score', goodRun()), e, { now: NOW })).status, 200);
  assert.equal(boardCalls(e), 0);
});

test('the writer down: posts and reads answer 503 board_busy and KV is untouched', async () => {
  const e = envDO({ fail: true });
  const p = await handleRaceApi(req('POST', '/race/time', goodLap()), e, { now: NOW });
  assert.equal(p.status, 503); assert.equal((await p.json()).error, 'board_busy');
  assert.equal((await handleRaceApi(req('GET', `/race/top?track=${TRACK}`), e)).status, 503);
  assert.equal(await e.KV.get(`race:top:${TRACK}`), null);
  const a = await handleArcadeApi(req('POST', '/arcade/score', goodRun()), e, { now: NOW });
  assert.equal(a.status, 503); assert.equal((await a.json()).error, 'board_busy');
});

test('DO mode arcade: a run shows in the next /arcade/top; an admin delete goes through the writer', async () => {
  const e = envDO();
  assert.equal((await handleArcadeApi(req('POST', '/arcade/score', goodRun('Juno')), e, { now: NOW })).status, 200);
  assert.deepEqual((await (await handleArcadeApi(req('GET', '/arcade/top?game=flappy-coin'), e)).json()).top.map(x => x.name), ['Juno']);
  const del = new Request('https://w/arcade/score', { method: 'DELETE', headers: { origin: O, 'content-type': 'application/json', [RACE_ADMIN_HEADER]: ADMIN }, body: JSON.stringify({ game: 'flappy-coin', name: 'Juno' }) });
  assert.equal((await handleArcadeApi(del, e)).status, 200);
  assert.deepEqual((await (await handleArcadeApi(req('GET', '/arcade/top?game=flappy-coin'), e)).json()).top, []);
  assert.ok(boardCalls(e) >= 4, 'every step went through the writer');
});

test('a successful post logs one race post line with name, ms, rank and best, and nothing about the poster', async () => {
  const e = envDO(), logs = [], orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try { await handleRaceApi(req('POST', '/race/time', goodLap('Tynus')), e, { now: NOW }); } finally { console.log = orig; }
  const lines = logs.filter(l => l.startsWith('race post'));
  assert.equal(lines.length, 1);
  const o = JSON.parse(lines[0].slice('race post '.length));
  assert.deepEqual(Object.keys(o).sort(), ['best', 'ms', 'name', 'rank']);
  assert.equal(o.name, 'Tynus'); assert.equal(o.rank, 1); assert.equal(o.best, true);
});
