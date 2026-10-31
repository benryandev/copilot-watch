import test from 'node:test'; import assert from 'node:assert/strict';
import handler from '../src/world-worker.js';
import { RACE_ORIGINS, RACE_ADMIN_HEADER } from '../src/race.js';
import { memKV } from './kv-mem.js';

const O = RACE_ORIGINS[0];
// A stand-in room object: echoes the path it was asked for, so the tests see what the worker forwards.
const stubWorld = () => ({ idFromName: n => 'id:' + n, get: id => ({ fetch: async req => new Response(JSON.stringify({ forwarded: new URL(req.url).pathname, id }), { headers: { 'content-type': 'application/json' } }) }) });
const env = (o = {}) => ({ KV: memKV(), WORLD: stubWorld(), RACE_ADMIN_TOKEN: 'admin-1', ...o });
const req = (path, { origin = O, headers = {}, method = 'GET', body } = {}) => new Request(`https://w${path}`, { method, headers: { ...(origin ? { origin } : {}), ...headers }, body });
const ws = (path, o = {}) => req(path, { ...o, headers: { upgrade: 'websocket', ...(o.headers || {}) } });

test('ws upgrade: wrong origin 403, kill switch 503, otherwise forwarded to the one room', async () => {
  const e = env();
  assert.equal((await handler.fetch(ws('/ws', { origin: 'https://evil.example' }), e)).status, 403);
  assert.equal((await handler.fetch(ws('/ws', { origin: null }), e)).status, 403);
  assert.equal((await handler.fetch(req('/ws'), e)).status, 426); // not an upgrade
  await e.KV.put('world:off', '1');
  const off = await handler.fetch(ws('/ws'), e);
  assert.equal(off.status, 503); assert.equal((await off.json()).error, 'off');
  await e.KV.delete('world:off');
  const r = await handler.fetch(ws('/ws', { origin: RACE_ORIGINS[1] }), e);
  assert.deepEqual(await r.json(), { forwarded: '/ws', id: 'id:main' });
});

test('presence is public with CORS for race origins; who and kick need the admin header', async () => {
  const e = env();
  const p = await handler.fetch(req('/presence'), e);
  assert.equal(p.status, 200); assert.equal(p.headers.get('access-control-allow-origin'), O);
  assert.equal((await p.json()).forwarded, '/presence');
  const px = await handler.fetch(req('/presence', { origin: 'https://evil.example' }), e);
  assert.equal(px.status, 200); assert.equal(px.headers.get('access-control-allow-origin'), null);
  assert.equal((await handler.fetch(req('/who'), e)).status, 403);
  assert.equal((await handler.fetch(req('/who', { headers: { [RACE_ADMIN_HEADER]: 'wrong' } }), e)).status, 403);
  assert.equal((await (await handler.fetch(req('/who', { headers: { [RACE_ADMIN_HEADER]: 'admin-1' } }), e)).json()).forwarded, '/who');
  assert.equal((await handler.fetch(req('/kick', { method: 'POST', body: '{}' }), e)).status, 403);
  assert.equal((await (await handler.fetch(req('/kick', { method: 'POST', body: '{"name":"x"}', headers: { [RACE_ADMIN_HEADER]: 'admin-1' } }), e)).json()).forwarded, '/kick');
  assert.equal((await handler.fetch(req('/who', { headers: { [RACE_ADMIN_HEADER]: 'admin-1' } }), env({ RACE_ADMIN_TOKEN: undefined }))).status, 403);
});

test('health ok; unknown 404', async () => {
  const e = env();
  assert.equal(await (await handler.fetch(req('/health'), e)).text(), 'ok');
  assert.equal((await handler.fetch(req('/nope'), e)).status, 404);
  assert.equal((await handler.fetch(req('/presence', { method: 'OPTIONS' }), e)).status, 204);
});

import { World } from '../src/world-worker.js';
// A fake Durable Object context and socket: enough to drive the message path without WebSocketPair
const fakeCtx = (sockets = []) => { const store = new Map(); return { storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v) }, getWebSockets: () => sockets, acceptWebSocket: () => {}, blockConcurrencyWhile: f => f() }; };
const fakeWs = (att) => { let a = att; const sent = []; return { serializeAttachment: v => { a = v; }, deserializeAttachment: () => a, send: m => sent.push(JSON.parse(m)), close: () => {}, sent }; };

test('World re-serialises the socket attachment when a player renames, so a wake-up restores the new name', async () => {
  const w = new World(fakeCtx(), { KV: memKV(), RACE_ADMIN_TOKEN: 'x' });
  await w.ready;
  const ws = fakeWs({ id: 'a', ipKey: 'k', since: 0 });
  w.room.open('a', { ipKey: 'k' }, 0); w.sockets.set('a', ws);
  await w.webSocketMessage(ws, JSON.stringify({ t: 'hi', v: 1, name: 'Aveli' }));
  assert.equal(ws.deserializeAttachment().name, 'Aveli');
  await w.webSocketMessage(ws, JSON.stringify({ t: 'name', name: 'Nova' }));
  assert.equal(ws.deserializeAttachment().name, 'Nova');
  const w2 = new World(fakeCtx([ws]), { KV: memKV(), RACE_ADMIN_TOKEN: 'x' });
  await w2.ready;
  assert.deepEqual(w2.room.who().map(p => p.name), ['Nova']);
});
