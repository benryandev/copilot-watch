import test from 'node:test'; import assert from 'node:assert/strict';
import { handleDiscord, postDiscord, dcSafe, interactionToCommand } from '../src/discord.js';
import { createStore } from '../src/store.js'; import { memKV } from './kv-mem.js'; import { fakeStrike, ADDR } from './helpers.js';

const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const pub = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('hex');
const env = { DISCORD_PUBLIC_KEY: pub, DISCORD_APP_ID: 'app', DISCORD_TOKEN: 'never-used' };
async function signed(body, { ts = Math.floor(Date.now() / 1000), key = kp.privateKey } = {}) {
  const b = JSON.stringify(body);
  const sig = Buffer.from(await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(ts + b))).toString('hex');
  return new Request('https://w/discord', { method: 'POST', headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': String(ts) }, body: b });
}
const ctx = () => { const p = []; return { p, waitUntil: x => p.push(x) }; };

test('PING → 200 {type: 1}', async () => {
  const r = await handleDiscord(await signed({ type: 1 }), env, ctx());
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { type: 1 });
});
test('bad signature → 401; old timestamp → 401', async () => {
  const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  assert.equal((await handleDiscord(await signed({ type: 1 }, { key: other.privateKey }), env, ctx())).status, 401);
  assert.equal((await handleDiscord(await signed({ type: 1 }, { ts: Math.floor(Date.now() / 1000) - 600 }), env, ctx())).status, 401);
  assert.equal((await handleDiscord(new Request('https://w/discord', { method: 'POST', body: '{}' }), env, ctx())).status, 401);
});
test('/watch → deferred, then one PATCH with mentions off', async () => {
  const calls = []; const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  const deps = { store: createStore(memKV()), strike: fakeStrike(), fetch };
  const i = { type: 2, token: 'tok', channel_id: 'c1', guild_id: 'g1', member: { user: { id: 'u1' }, permissions: '0' }, data: { name: 'watch', options: [{ name: 'account', value: ADDR }, { name: 'sub', value: 'Sub1' }] } };
  const c = ctx(); const r = await handleDiscord(await signed(i), env, c, deps);
  assert.deepEqual(await r.json(), { type: 5 }); await Promise.all(c.p);
  assert.equal(calls.length, 1); assert.match(calls[0].url, /webhooks\/app\/tok\/messages\/@original$/);
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] }); assert.match(calls[0].body.content, /Watching:/);
});
test('channel posts disable mentions and escape markdown', async () => {
  const bodies = []; await postDiscord(env, 'c1', '@everyone **bold** `x`', { fetch: async (u, init) => { bodies.push(JSON.parse(init.body)); return { ok: true }; } });
  assert.deepEqual(bodies[0].allowed_mentions, { parse: [] }); assert.equal(bodies[0].content, '@everyone \\*\\*bold\\*\\* \\`x\\`');
  assert.equal(dcSafe('a_b'), 'a\\_b');
});
test('Manage Server bit makes isAdmin', () => {
  assert.equal(interactionToCommand({ member: { permissions: String(0x20), user: { id: '1' } }, data: { name: 'stop' }, channel_id: 'c', guild_id: 'g' }).isAdmin, true);
  assert.equal(interactionToCommand({ member: { permissions: '2048', user: { id: '1' } }, data: { name: 'stop' }, channel_id: 'c', guild_id: 'g' }).isAdmin, false);
});
