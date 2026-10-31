import test from 'node:test'; import assert from 'node:assert/strict';
import { handleSubmitApi, parseSubmission, cleanUrl, cleanX, alertText, SUBMIT_PER_HOUR } from '../src/submit.js';
import { RACE_ORIGINS, RACE_ADMIN_HEADER } from '../src/race.js';
import handler from '../src/worker.js';
import { memKV } from './kv-mem.js';

const O = RACE_ORIGINS[0], NOW = Date.UTC(2026, 9, 31), ADMIN = 'test-admin-token-1234';
const good = (over = {}) => ({
  type: 'new', name: 'Argus', tagline: 'Alerts for Strike traders on Telegram', description: 'Watches your Strike positions through the public API and sends alerts.',
  category: 'Bot', uses: ['API'], site: 'https://argus.example.com', x: '@argus', github: 'https://github.com/argus/argus', logo: '', contact: '@argus_dev on Telegram',
  permission: true, company: '', elapsed: 20000, ...over });
let ipN = 0;
const req = (method, path, { body, origin = O, ip = `10.1.0.${++ipN}`, headers = {} } = {}) => new Request(`https://w${path}`, {
  method, headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers },
  ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
const env = (o = {}) => ({ KV: memKV(), TELEGRAM_TOKEN: 't', SUBMIT_TG_CHAT: '42', RACE_ADMIN_TOKEN: ADMIN, ...o });

test('urls and handles', () => {
  assert.equal(cleanUrl('argus.example.com'), 'https://argus.example.com/');
  for (const bad of ['http://a.com', 'javascript:alert(1)', 'https://user:pw@a.com', 'https://localhost', 'ftp://a.com', `https://a.com/${'x'.repeat(200)}`]) assert.equal(cleanUrl(bad), null, bad);
  assert.equal(cleanX('@Argus_1'), 'Argus_1'); assert.equal(cleanX('https://x.com/argus'), 'argus'); assert.equal(cleanX('twitter.com/argus/'), 'argus');
  assert.equal(cleanX('https://x.com/argus/status/1'), null); assert.equal(cleanX('not a handle'), null);
});

test('validation', () => {
  assert.ok(parseSubmission(good()).ok);
  const cases = [
    [{ name: 'A' }, 'name'], [{ name: 'x'.repeat(41) }, 'name'], [{ tagline: 'short' }, 'tagline'], [{ description: 'too short' }, 'description'],
    [{ category: 'Casino' }, 'category'], [{ uses: [] }, 'uses'], [{ uses: ['Mining'] }, 'uses'], [{ site: 'http://a.com' }, 'site'],
    [{ github: 'https://gitlab.com/a' }, 'github'], [{ x: 'https://x.com/a/status/1' }, 'x'], [{ permission: 'yes' }, 'permission'],
    [{ contact: '' }, 'contact'], [{ type: 'update' }, 'listing'], [{ name: 42 }, 'name'],
  ];
  for (const [over, field] of cases) assert.equal(parseSubmission(good(over)).field, field, JSON.stringify(over));
  const p = parseSubmission(good({ name: '  Ar​gus\u0007  ', description: 'Line one\r\n\r\n\r\n\r\nLine two is long enough to pass the check.' }));
  assert.equal(p.item.name, 'Argus'); assert.equal(p.item.description, 'Line one\n\nLine two is long enough to pass the check.');
  assert.equal(p.item.x, 'argus'); assert.equal(p.item.logo, undefined);
});

test('a good submission is stored and sent to Telegram as plain text', async () => {
  const e = env(), sent = [];
  const r = await handleSubmitApi(req('POST', '/submit', { body: good() }), e, { now: NOW, send: async (id, t) => { sent.push([id, t]); return true; } });
  assert.equal(r.status, 200); const b = await r.json(); assert.equal(b.ok, true); assert.ok(b.id);
  assert.equal(sent.length, 1); assert.equal(sent[0][0], '42');
  assert.match(sent[0][1], /^New project for Builders' Row\n\nArgus: Alerts for Strike traders/); assert.match(sent[0][1], /X: https:\/\/x\.com\/argus/);
  const keys = [...e.KV.m.keys()].filter(k => k.startsWith('sub:item:'));
  assert.equal(keys.length, 1);
  const stored = JSON.parse(e.KV.m.get(keys[0]).v);
  assert.equal(stored.name, 'Argus'); assert.ok(!JSON.stringify(stored).includes('10.1.0.'), 'no IP stored');
  assert.equal(stored.company, undefined); assert.equal(stored.elapsed, undefined);
  // Admin list
  assert.equal((await handleSubmitApi(req('GET', '/submit/list'), e)).status, 403);
  const list = await (await handleSubmitApi(req('GET', '/submit/list', { headers: { [RACE_ADMIN_HEADER]: ADMIN } }), e)).json();
  assert.equal(list.items.length, 1); assert.equal(list.items[0].id, b.id);
});

test('honeypot and too-fast posts look accepted but are dropped', async () => {
  for (const over of [{ company: 'Acme' }, { elapsed: 500 }, { elapsed: undefined }]) {
    const e = env(), sent = [];
    const r = await handleSubmitApi(req('POST', '/submit', { body: good(over) }), e, { now: NOW, send: async () => { sent.push(1); return true; } });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
    assert.equal(sent.length, 0); assert.equal([...e.KV.m.keys()].filter(k => k.startsWith('sub:item:')).length, 0);
  }
});

test('origin, size, per-IP and per-day limits', async () => {
  const e = env(), send = async () => true;
  const call = (o = {}) => handleSubmitApi(req('POST', '/submit', { body: good(), ...o }), e, { now: NOW, send });
  assert.equal((await call({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await call({ body: 'x'.repeat(9000) })).status, 413);
  assert.equal((await call({ body: '{nope' })).status, 400);
  for (let i = 0; i < SUBMIT_PER_HOUR; i++) assert.equal((await call({ ip: '9.9.9.9' })).status, 200);
  assert.equal((await call({ ip: '9.9.9.9' })).status, 429);
  const e2 = env(); e2.KV.m.set('sub:day:2026-10-31', { v: '30', exp: 0 });
  assert.equal((await handleSubmitApi(req('POST', '/submit', { body: good() }), e2, { now: NOW, send })).status, 503);
  const pre = await handleSubmitApi(req('OPTIONS', '/submit'), e);
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), O);
});

test('a failed Telegram send still stores the submission', async () => {
  const e = env();
  const r = await handleSubmitApi(req('POST', '/submit', { body: good() }), e, { now: NOW, send: async () => { throw new Error('down'); } });
  assert.equal(r.status, 200);
  assert.equal([...e.KV.m.keys()].filter(k => k.startsWith('sub:item:')).length, 1);
});

test('alert text for an update names the listing', () => {
  const p = parseSubmission(good({ type: 'update', listing: 'Argus', notes: 'New logo' }));
  const t = alertText({ id: 'abc', ...p.item }, 'abc');
  assert.match(t, /^Listing update/); assert.match(t, /Updating: Argus/); assert.match(t, /Notes: New logo/);
});

test('the worker routes /submit', async () => {
  const r = await handler.fetch(req('OPTIONS', '/submit'), env(), {});
  assert.equal(r.status, 204);
});
