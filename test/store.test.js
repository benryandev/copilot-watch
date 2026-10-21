import test from 'node:test'; import assert from 'node:assert/strict';
import { createStore, chatKey } from '../src/store.js'; import { memKV } from './kv-mem.js';
const chat = (id, accts) => ({ platform: 'tg', chatId: id, ownerUserId: 'u', accounts: accts.map(a => ({ accountId: a, label: a })), settings: { liq: 5 }, createdAt: 0 });

test('coolOnce true then false, true again after expiry', async () => {
  const kv = memKV(); const s = createStore(kv);
  assert.equal(await s.coolOnce('chat:tg:1', 'A1:x', 3600), true);
  assert.equal(await s.coolOnce('chat:tg:1', 'A1:x', 3600), false);
  kv.now += 3601 * 1000; assert.equal(await s.coolOnce('chat:tg:1', 'A1:x', 3600), true);
});
test('putChat links accounts; deleteChat unlinks and drops empty acct', async () => {
  const kv = memKV(); const s = createStore(kv);
  await s.putChat(chat(1, ['a', 'b'])); await s.putChat(chat(2, ['b']));
  assert.deepEqual((await s.getAcct('b')).chats, ['chat:tg:1', 'chat:tg:2']);
  await s.deleteChat(chatKey('tg', 1));
  assert.equal(await s.getAcct('a'), null); assert.deepEqual((await s.getAcct('b')).chats, ['chat:tg:2']);
  assert.equal(await s.getChat('chat:tg:1'), null); assert.equal((await s.listChats()).length, 1);
});
test('removing an account from a chat unlinks it', async () => {
  const kv = memKV(); const s = createStore(kv);
  await s.putChat(chat(1, ['a', 'b'])); await s.putChat(chat(1, ['b']));
  assert.equal(await s.getAcct('a'), null);
});
test('rateOk refuses the 11th call in a minute', async () => {
  const kv = memKV(); let t = 0; const s = createStore(kv, { now: () => t });
  for (let i = 0; i < 10; i++) assert.equal(await s.rateOk('chat:tg:1'), true);
  assert.equal(await s.rateOk('chat:tg:1'), false);
  t = 60000; assert.equal(await s.rateOk('chat:tg:1'), true);
});
test('cachedLeaderboard reuses rows for 10 minutes and keeps old rows if a reload fails', async () => {
  const kv = memKV(); let t = 0, n = 0; const s = createStore(kv, { now: () => t });
  const load = async () => (n++ === 1 ? [] : [{ n }]);
  assert.deepEqual(await s.cachedLeaderboard(load), [{ n: 1 }]);
  t = 5 * 60000; assert.deepEqual(await s.cachedLeaderboard(load), [{ n: 1 }]); assert.equal(n, 1);
  t = 11 * 60000; assert.deepEqual(await s.cachedLeaderboard(load), [{ n: 1 }]);
});
