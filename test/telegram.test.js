import test from 'node:test'; import assert from 'node:assert/strict';
import { handleTelegram, telegramUpdateToCommand, chunk, safeEqual } from '../src/telegram.js';
import { createStore } from '../src/store.js'; import { memKV } from './kv-mem.js'; import { fakeStrike, ADDR } from './helpers.js';

const env = { TELEGRAM_WEBHOOK_SECRET: 's3cret', TELEGRAM_TOKEN: 'never-used' };
const ctx = () => { const p = []; return { p, waitUntil: x => p.push(x) }; };
const req = (body, secret) => new Request('https://w/telegram', { method: 'POST', headers: secret ? { 'x-telegram-bot-api-secret-token': secret } : {}, body: JSON.stringify(body) });
const msg = (text, type = 'private') => ({ message: { text, chat: { id: 42, type }, from: { id: 7 } } });

test('wrong or missing secret → 401', async () => {
  assert.equal((await handleTelegram(req(msg('/start')), env, ctx())).status, 401);
  assert.equal((await handleTelegram(req(msg('/start'), 'nope'), env, ctx())).status, 401);
  assert.equal(safeEqual('', ''), false);
});
test('/watch@CopilotWatchBot parses', () => {
  const c = telegramUpdateToCommand(msg(`/watch@CopilotWatchBot ${ADDR} Sub1`));
  assert.equal(c.name, 'watch'); assert.deepEqual(c.args, [ADDR, 'Sub1']); assert.equal(c.chatId, '42');
});
test('group chat gets the decline', async () => {
  const sent = []; const c = ctx();
  await handleTelegram(req(msg('/start', 'group'), 's3cret'), env, c, { send: async (id, t) => sent.push([id, t]) });
  await Promise.all(c.p); assert.match(sent[0][1], /direct messages only/);
});
test('9,000-char text → 3 chunks under 4,000', () => {
  const t = Array.from({ length: 300 }, () => 'x'.repeat(29)).join('\n');
  const parts = chunk(t); assert.equal(parts.length, 3); assert.ok(parts.every(p => p.length <= 4000));
  assert.equal(parts.join('\n'), t);
});
test('rate limit reply', async () => {
  const deps = { store: createStore(memKV()), strike: fakeStrike() }; const sent = [];
  deps.send = async (id, t) => sent.push(t);
  for (let i = 0; i < 11; i++) { const c = ctx(); await handleTelegram(req(msg('/help'), 's3cret'), env, c, deps); await Promise.all(c.p); }
  assert.equal(sent.at(-1), 'Too many commands, try again in a minute.');
});
