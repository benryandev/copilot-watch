import test from 'node:test'; import assert from 'node:assert/strict';
import { poll } from '../src/poll.js'; import { createStore } from '../src/store.js'; import { HlBusyError } from '../core/http.js';
import { memKV } from './kv-mem.js'; import { fakeStrike } from './helpers.js';

const L = '0x1ead000000000000000000000000000000000001';
const NOW = Date.UTC(2026, 9, 22, 3, 0);
const strikeMarkets = { 'BTC-USD': { status: 'trading', base_asset: 'BTC', margin_tiers: [] } };
const hlOk = (over = {}) => ({
  meta: async () => ({ core: new Set(['BTC']), xyz: new Set() }),
  clearinghouse: async () => ({ main: { accountValue: 1000, marginUsed: 10, positions: [{ coin: 'BTC', szi: 1 }] }, xyz: { accountValue: 0, marginUsed: 0, positions: [] } }),
  fillsByTime: async () => [], ledger: async () => [], ...over });

async function setup({ fills = [], hl = hlOk(), leads = 1 } = {}) {
  const kv = memKV(); const store = createStore(kv, { now: () => NOW });
  for (const id of ['1', '2']) await store.putChat({ platform: 'tg', chatId: id, ownerUserId: id, accounts: [{ accountId: 'acc-sub1', label: 'Sub1' }], settings: { liq: 5 }, createdAt: 0 });
  const state = { fills };
  const leadIds = Array.from({ length: leads }, (_, i) => `0x1ead${String(i + 1).padStart(36, '0')}`);
  const strike = fakeStrike({
    markets: async () => strikeMarkets,
    leaderboard: async () => leadIds.map(l => ({ followerId: 'acc-sub1', leadId: l, mode: 'fixed margin', amount: 10, status: 'active', createdAt: 0 })),
    copyPositions: async () => [{ subId: 's1', leadId: L, market: 'BTC-USD', side: 'long', leverage: 3, mark: 100, liq: 50, pnl: 0 }],
    fills: async () => state.fills });
  const sent = [];
  const deps = { store, strike, hl, gap: 0, now: () => NOW, send: async (chat, text) => { sent.push([chat.chatId, text]); return true; } };
  return { deps, sent, state, store };
}

test('first poll stores baseline and sends nothing', async () => {
  const { deps, sent, store } = await setup({ fills: [{ id: 'old', symbol: 'BTC-USD', ts: NOW - 86400_000, autoClose: 'liquidation' }] });
  const r = await poll({}, deps);
  assert.equal(r.sent, 0); assert.equal(sent.length, 0); assert.equal(r.accounts, 1);
  assert.equal((await store.getAcct('acc-sub1')).base.since, NOW);
});
test('new liquidation fill → one send per watching chat, then cool-down', async () => {
  const { deps, sent, state } = await setup();
  await poll({}, deps);
  state.fills = [{ id: 'n1', symbol: 'BTC-USD', ts: NOW + 1, autoClose: 'liquidation', pnl: -5 }];
  deps.now = () => NOW + 120_000;
  await poll({}, deps);
  assert.deepEqual(sent.map(s => s[0]).sort(), ['1', '2']); assert.match(sent[0][1], /closed by liquidation/);
  deps.now = () => NOW + 240_000;
  await poll({}, deps);
  assert.equal(sent.length, 2);
});
test('HlBusyError for a lead → skipped, no A2', async () => {
  const { deps, sent } = await setup({ hl: hlOk({ clearinghouse: async () => { throw new HlBusyError('clearinghouseState'); } }) });
  await poll({}, deps); deps.now = () => NOW + 120_000;
  const r = await poll({}, deps); deps.now = () => NOW + 240_000;
  const r2 = await poll({}, deps);
  assert.equal(r.skippedLeads, 1); assert.equal(r2.skippedLeads, 1); assert.equal(sent.length, 0);
});
test('lead flat for two rounds → A2 once', async () => {
  const { deps, sent } = await setup({ hl: hlOk({ clearinghouse: async () => ({ main: { accountValue: 1000, marginUsed: 0, positions: [] }, xyz: { accountValue: 0, marginUsed: 0, positions: [] } }) }) });
  await poll({}, deps);                         // baseline (orphan seen once)
  deps.now = () => NOW + 120_000; await poll({}, deps); // seen twice → alert
  assert.equal(sent.length, 2); assert.match(sent[0][1], /no longer holds BTC/);
});
test('subrequest budget defers leads beyond it', async () => {
  const { deps } = await setup({ leads: 5 }); deps.budget = 4 + 3 + 2 * 4;
  const r = await poll({}, deps);
  assert.equal(r.leads, 2); assert.equal(r.deferredLeads, 3); // 5 unique leads (the copy's lead is one of them)
});
test('no chats → no API calls', async () => {
  const store = createStore(memKV()); let calls = 0;
  const r = await poll({}, { store, strike: new Proxy({}, { get: () => () => { calls++; } }), hl: {}, send: async () => true });
  assert.equal(r.accounts, 0); assert.equal(calls, 0);
});

test('a failed send is retried on the next poll', async () => {
  const { deps, sent, state } = await setup();
  await poll({}, deps);
  state.fills = [{ id: 'n1', symbol: 'BTC-USD', ts: NOW + 1, autoClose: 'liquidation', pnl: -5 }];
  let fail = true; const ok = deps.send; deps.send = async (c, t) => (fail ? false : ok(c, t));
  deps.now = () => NOW + 120_000; const r = await poll({}, deps);
  assert.equal(r.sent, 0); assert.equal(r.failed, 2);
  fail = false; deps.now = () => NOW + 240_000; await poll({}, deps);
  assert.equal(sent.length, 2);
});

test('a chat that blocked the bot is removed', async () => {
  const { deps, state, store } = await setup();
  await poll({}, deps);
  state.fills = [{ id: 'n1', symbol: 'BTC-USD', ts: NOW + 1, autoClose: 'liquidation', pnl: -5 }];
  deps.send = async c => (c.chatId === '1' ? 'gone' : true);
  deps.now = () => NOW + 120_000; const r = await poll({}, deps);
  assert.equal(r.removed, 1); assert.equal(await store.getChat('chat:tg:1'), null); assert.ok(await store.getChat('chat:tg:2'));
});

test('accounts beyond the budget wait for the next run', async () => {
  const { deps, store } = await setup();
  await store.putChat({ platform: 'tg', chatId: '3', ownerUserId: '3', accounts: [{ accountId: 'acc-x', label: 'X' }], settings: { liq: 5 }, createdAt: 0 });
  deps.budget = 4 + 3 + 4; // room for one account and one lead
  const r = await poll({}, deps);
  assert.equal(r.accounts, 1); assert.equal(r.deferredAccounts, 1);
});
