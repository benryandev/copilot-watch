import test from 'node:test'; import assert from 'node:assert/strict';
import { handlePaperApi, parseTrial, getTrial, MAX_TRIALS } from '../src/paper.js';
import { handleCommand } from '../src/commands.js'; import { createStore } from '../src/store.js';
import { dailyPaper, trialLine } from '../src/paper-daily.js';
import { memKV } from './kv-mem.js'; import { fakeStrike } from './helpers.js';

const W = '0x' + 'ab'.repeat(20), O = 'https://strike.benryan.com.au', NOW = Date.UTC(2026, 9, 22);
const env = () => ({ KV: memKV() });
const post = (body, origin = O) => new Request('https://w/api/paper', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const ok = { lead: W.toUpperCase().replace('0X', '0x'), settings: { mode: 'fm', amount: 50, lev: 5, marginMode: 'isolated', cap: 0, tcap: 400, excluded: ['PUMP-USD'], start: 1000 } };

test('create then read a trial; chat link stays private; CORS only for the site', async () => {
  const e = env(); const r = await handlePaperApi(post(ok), e, { now: NOW });
  assert.equal(r.status, 201); assert.equal(r.headers.get('access-control-allow-origin'), O);
  const { id, url } = await r.json(); assert.match(id, /^[A-Za-z0-9_-]{22}$/); assert.equal(url, `https://strike.benryan.com.au/paper/${id}`);
  const g = await handlePaperApi(new Request(`https://w/api/paper/${id}`, { headers: { origin: O } }), e);
  const t = await g.json(); assert.equal(t.lead, W); assert.equal(t.from, NOW - 14 * 86400000); assert.ok(!('chat' in t));
  const evil = await handlePaperApi(new Request(`https://w/api/paper/${id}`, { headers: { origin: 'https://evil.example' } }), e);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});
test('refusals: origin, bad JSON, bad wallet, settings out of range, unknown id, too large, limit', async () => {
  const e = env();
  assert.equal((await handlePaperApi(post(ok, 'https://evil.example'), e)).status, 403);
  assert.equal((await handlePaperApi(post('{nope'), e)).status, 400);
  assert.equal((await (await handlePaperApi(post({ ...ok, lead: '0x123' }), e)).json()).error, 'bad_wallet');
  for (const bad of [{ lev: 50 }, { lev: 2.5 }, { amount: 0 }, { mode: 'x' }, { excluded: ['<b>'] }, { marginMode: 'both' }, { start: 5 }])
    assert.equal((await handlePaperApi(post({ ...ok, settings: { ...ok.settings, ...bad } }), e)).status, 400, JSON.stringify(bad));
  assert.equal((await handlePaperApi(new Request('https://w/api/paper/nope', {}), e)).status, 404);
  assert.equal((await handlePaperApi(post('x'.repeat(5000)), e)).status, 413);
  const limited = await handlePaperApi(post(ok), e, { limiter: { limit: async () => ({ success: false }) } });
  assert.equal(limited.status, 429);
});
test('global trial cap', async () => {
  const e = env(); for (let i = 0; i < MAX_TRIALS; i++) await e.KV.put(`paper:x${i}`, '{}');
  assert.equal((await handlePaperApi(post(ok), e)).status, 503);
});
test('/paper creates, lists and caps at 3; /stop deletes trials', async () => {
  const kv = memKV(); const d = { store: createStore(kv), strike: fakeStrike(), kv, now: () => NOW };
  const tg = (name, args = []) => ({ platform: 'tg', chatId: '9', userId: '9', name, args });
  assert.match((await handleCommand(tg('paper'), d)).text, /^Paper copy a Hyperliquid wallet/);
  assert.match((await handleCommand(tg('paper', ['addr1qxyz']), d)).text, /0x followed by 40/);
  const r = await handleCommand(tg('paper', [W, '2000']), d);
  assert.match(r.text, /fixed margin \$100 per entry, 5x isolated, on a \$2,000 paper account/);
  await handleCommand(tg('paper', [W]), d); await handleCommand(tg('paper', [W]), d);
  assert.match((await handleCommand(tg('paper', [W]), d)).text, /already has 3/);
  assert.equal((await handleCommand(tg('paper'), d)).text.split('\n').length, 4);
  const ids = (await d.store.getChat('chat:tg:9')).trials;
  await handleCommand(tg('stop'), d);
  for (const id of ids) assert.equal(await getTrial(kv, id), null);
});
test('daily summary: one message per chat with trials', async () => {
  const kv = memKV(); const store = createStore(kv); const sent = [];
  const d = { store, strike: fakeStrike(), kv, now: () => NOW, send: async (c, t) => sent.push(t) };
  await handleCommand({ platform: 'tg', chatId: '9', userId: '9', name: 'paper', args: [W] }, d);
  const r = await dailyPaper({}, { ...d, hl: { meta: async () => ({ core: new Set(['BTC']), xyz: new Set() }) }, strike: { markets: async () => ({}) },
    runTrial: async () => ({ net: 12.4, dd: -30, liquidations: 0, taken: 7 }) });
  assert.equal(r.trials, 1); assert.match(sent[0], /Paper copy of 0xabab…abab \(fixed margin \$50, 5x isolated\): \+\$12 since 8 Oct, biggest drop −\$30, 0 liquidations, 7 entries copied/);
});
test('parseTrial defaults', () => {
  const p = parseTrial({ lead: W, settings: { mode: 'fr', amount: 500, lev: 3 } }, NOW);
  assert.deepEqual(p.trial.settings, { mode: 'fr', amount: 500, lev: 3, marginMode: 'isolated', cap: 0, tcap: 0, excluded: [], start: 1000 });
});
