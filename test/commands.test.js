import test from 'node:test'; import assert from 'node:assert/strict';
import { handleCommand } from '../src/commands.js'; import { createStore } from '../src/store.js';
import { memKV } from './kv-mem.js'; import { fakeStrike, ADDR } from './helpers.js';

const setup = (over) => { const store = createStore(memKV()); return { store, strike: fakeStrike(over) }; };
const tg = (name, args = [], chatId = '1') => ({ platform: 'tg', chatId, userId: chatId, name, args });

test('watch lists copies; no-copy account says the list can lag', async () => {
  const d = setup(); const r = await handleCommand(tg('watch', [ADDR]), d);
  assert.match(r.text, /Tester \/ Sub1: copying 0xlead…0001 \(fixed margin \$10\), 1 open copy\./);
  assert.match(r.text, /Tester \(main\): no active copies yet; the copy list can lag up to 10 minutes\./);
  assert.equal((await d.store.getChat('chat:tg:1')).accounts.length, 3);
});
test('the 6th account is refused', async () => {
  const d = setup(); await handleCommand(tg('watch', [ADDR]), d);
  const many = fakeStrike({ accountByAddress: async () => ({ accountId: 'z', nickname: 'Z', subs: [{ id: 'z1', name: 'a' }, { id: 'z2', name: 'b' }] }) });
  const r = await handleCommand(tg('watch', [ADDR]), { ...d, strike: many });
  assert.equal(r.text, 'This chat already watches 5 accounts. Use /unwatch <account> first.');
});
test('status shows liquidation distance', async () => {
  const d = setup(); await handleCommand(tg('watch', [ADDR, 'Sub1']), d);
  assert.match((await handleCommand(tg('status'), d)).text, /BTC long 3x: P&L −\$1, 30\.0% from liquidation/);
});
test('settings bounds', async () => {
  const d = setup(); await handleCommand(tg('watch', [ADDR, 'Sub1']), d);
  assert.match((await handleCommand(tg('settings', ['liq=20']), d)).text, /within 20%/);
  assert.match((await handleCommand(tg('settings', ['liq=50']), d)).text, /1 to 20/);
  assert.equal((await d.store.getChat('chat:tg:1')).settings.liq, 20);
});
test('stop removes the chat and its account links', async () => {
  const d = setup(); await handleCommand(tg('watch', [ADDR]), d);
  await handleCommand(tg('stop'), d);
  assert.equal(await d.store.getChat('chat:tg:1'), null); assert.equal(await d.store.getAcct('acc-sub1'), null);
});
test('unwatch by sub name', async () => {
  const d = setup(); await handleCommand(tg('watch', [ADDR]), d);
  assert.match((await handleCommand(tg('unwatch', ['Sub1']), d)).text, /Stopped watching Tester \/ Sub1/);
  assert.equal((await d.store.getChat('chat:tg:1')).accounts.length, 2);
});
test('Discord: non-owner non-admin cannot unwatch; admin can', async () => {
  const d = setup(); const dc = (userId, isAdmin, name, args = []) => ({ platform: 'dc', chatId: 'ch1', guildId: 'g1', userId, isAdmin, name, args });
  await handleCommand(dc('owner', false, 'watch', [ADDR]), d);
  assert.match((await handleCommand(dc('other', false, 'unwatch', ['Sub1']), d)).text, /Only the person who set up/);
  assert.match((await handleCommand(dc('mod', true, 'unwatch', ['Sub1']), d)).text, /Stopped watching/);
});
test('Discord: 4th channel in a server is refused', async () => {
  const d = setup();
  for (const ch of ['a', 'b', 'c']) await handleCommand({ platform: 'dc', chatId: ch, guildId: 'g1', userId: 'u', name: 'watch', args: [ADDR, 'Sub1'] }, d);
  assert.match((await handleCommand({ platform: 'dc', chatId: 'd', guildId: 'g1', userId: 'u', name: 'watch', args: [ADDR, 'Sub1'] }, d)).text, /3 channels/);
});
test('rate limit after 10 commands a minute', async () => {
  const d = setup(); for (let i = 0; i < 10; i++) await handleCommand(tg('help'), d);
  assert.equal((await handleCommand(tg('help'), d)).text, 'Too many commands, try again in a minute.');
});

test('global chat cap', async () => {
  const d = setup(); d.store.countChats = async () => 300;
  assert.match((await handleCommand(tg('watch', [ADDR], '77'), d)).text, /at its limit/);
});
test('Discord: one user can hold at most 3 channels across servers', async () => {
  const d = setup();
  for (const [ch, g] of [['a', 'g1'], ['b', 'g2'], ['c', 'g3']]) await handleCommand({ platform: 'dc', chatId: ch, guildId: g, userId: 'u', name: 'watch', args: [ADDR, 'Sub1'] }, d);
  assert.match((await handleCommand({ platform: 'dc', chatId: 'd', guildId: 'g4', userId: 'u', name: 'watch', args: [ADDR, 'Sub1'] }, d)).text, /You already have Copilot Watch in 3 channels/);
});
test('global distinct-account cap', async () => {
  const d = setup(); d.store.countAccts = async () => 300;
  assert.match((await handleCommand(tg('watch', [ADDR], '55'), d)).text, /at its limit/);
});
