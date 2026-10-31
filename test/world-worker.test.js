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
const fakeCtx = (sockets = []) => { const store = new Map(); const ctx = { alarms: [], storage: { get: async k => store.get(k), put: async (k, v) => store.set(k, v), setAlarm: async t => ctx.alarms.push(t), getAlarm: async () => ctx.alarms.at(-1) ?? null }, getWebSockets: () => sockets, acceptWebSocket: () => {}, blockConcurrencyWhile: f => f() }; return ctx; };
const fakeWs = (att) => { let a = att; const sent = []; const ws = { closed: null, serializeAttachment: v => { a = v; }, deserializeAttachment: () => a, send: m => sent.push(JSON.parse(m)), close: (c, r) => { ws.closed = [c, r]; }, sent }; return ws; };

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

test('World arms a reaper alarm when sockets exist, and alarm() closes the silent ones', async () => {
  const ws = fakeWs({ id: 'z', name: 'Zombie', colour: '#fff', ipKey: 'k', since: Date.now() - 120_000 }); // joined two minutes ago, never heard
  const live = fakeWs({ id: 'l', name: 'Live', colour: '#fff', ipKey: 'k2', since: Date.now() - 120_000, heardAt: Date.now() - 5_000 });
  const ctx = fakeCtx([ws, live]);
  const w = new World(ctx, { KV: memKV(), RACE_ADMIN_TOKEN: 'x' });
  await w.ready;
  assert.equal(ctx.alarms.length, 1, 'an alarm is set on restore when sockets exist');
  assert.equal(w.room.online(), 2);
  await w.alarm();
  assert.equal(live.closed, null);
  w.sockets.delete('l'); w.room.close('l');
  assert.deepEqual(ws.closed, [1001, 'idle']);
  assert.equal(w.room.online(), 0);
  assert.equal(w.sockets.size, 0);
  assert.equal(ctx.alarms.length, 2, 'the alarm was re-armed while Live was still connected');
});

test('World refreshes the attachment\'s heardAt at most every 30 s of messages', async () => {
  const w = new World(fakeCtx(), { KV: memKV(), RACE_ADMIN_TOKEN: 'x' });
  await w.ready;
  const ws = fakeWs({ id: 'a', ipKey: 'k', since: 0 });
  w.room.open('a', { ipKey: 'k' }, 0); w.sockets.set('a', ws);
  await w.webSocketMessage(ws, JSON.stringify({ t: 'hi', v: 1, name: 'Aveli' }));
  const first = ws.deserializeAttachment().heardAt;
  assert.ok(Date.now() - first < 1000);
  await w.webSocketMessage(ws, JSON.stringify({ t: 'p', x: 1, z: 1, h: 0, s: 0 }));
  assert.equal(ws.deserializeAttachment().heardAt, first, 'not rewritten on every frame');
  w.room.players.get('a').lastMsg = first + 31_000; ws.serializeAttachment({ ...ws.deserializeAttachment(), heardAt: first - 31_000 });
  await w.webSocketMessage(ws, JSON.stringify({ t: 'p', x: 1, z: 1, h: 0, s: 0 }));
  assert.ok(ws.deserializeAttachment().heardAt >= first, 'rewritten once the stored time is over 30 s old');
});
