import test from 'node:test'; import assert from 'node:assert/strict';
import { T, A } from '../src/text.js'; import { TZ, AZ } from '../src/text-zh.js'; import { TH, AH } from '../src/text-zh-hant.js';
import { autoLang, parseLang } from '../src/i18n.js';
import { handleCommand } from '../src/commands.js'; import { createStore } from '../src/store.js';
import { telegramUpdateToCommand } from '../src/telegram.js';
import { detectAlerts } from '../src/alerts.js';
import { trialLine } from '../src/paper-daily.js';
import { memKV } from './kv-mem.js'; import { fakeStrike, ADDR } from './helpers.js';

const setup = () => ({ store: createStore(memKV()), strike: fakeStrike() });
const tg = (name, args = [], lang) => ({ platform: 'tg', chatId: '1', userId: '1', name, args, lang });
const hasHan = s => /[一-鿿]/.test(s);

test('Chinese wording has every key the English has, with the same kind of value', () => {
  assert.deepEqual(Object.keys(TZ).sort(), Object.keys(T).sort());
  assert.deepEqual(Object.keys(AZ).sort(), Object.keys(A).sort());
  assert.deepEqual(Object.keys(TH).sort(), Object.keys(T).sort());
  assert.deepEqual(Object.keys(AH).sort(), Object.keys(A).sort());
  for (const k of Object.keys(T)) assert.equal(typeof TH[k], typeof T[k], k);
  for (const k of Object.keys(T)) assert.equal(typeof TZ[k], typeof T[k], k);
});
test('Telegram language_code: traditional variants → zh-Hant, other zh → zh, everything else English', () => {
  for (const c of ['zh', 'zh-hans', 'zh-CN', 'zh-SG']) assert.equal(autoLang(c), 'zh', c);
  for (const c of ['zh-hant', 'zh-TW', 'zh-HK', 'zh_tw']) assert.equal(autoLang(c), 'zh-Hant', c);
  for (const c of ['en', 'en-AU', 'ja', '', undefined]) assert.equal(autoLang(c), 'en', String(c));
  const u = { message: { text: '/start', chat: { id: 42, type: 'private' }, from: { id: 7, language_code: 'zh-hans' } } };
  assert.equal(telegramUpdateToCommand(u).lang, 'zh');
});
test('/lang accepts en, zh and 中文; anything else gets the usage line', () => {
  assert.equal(parseLang('中文'), 'zh'); assert.equal(parseLang('EN'), 'en'); assert.equal(parseLang('fr'), null);
});
test('a Chinese Telegram user gets Chinese replies, and the chat keeps zh for alerts', async () => {
  const d = setup();
  assert.ok(hasHan((await handleCommand(tg('start', [], 'zh'), d)).text));
  const r = await handleCommand(tg('watch', [ADDR], 'zh'), d);
  assert.match(r.text, /正在关注：/);
  assert.match(r.text, /跟单 0xlead…0001（固定保证金 \$10），1 个跟单仓位。/);
  assert.equal((await d.store.getChat('chat:tg:1')).settings.lang, 'zh');
  assert.match((await handleCommand(tg('status', [], 'en'), d)).text, /BTC 多单 3 倍：盈亏 −\$1，距离强平 30\.0%/); // saved choice beats the app language
});
test('/lang switches a chat, and a choice made before /watch is kept until the chat exists', async () => {
  const d = setup();
  assert.match((await handleCommand(tg('lang', ['zh']), d)).text, /语言已切换为简体中文/);
  await handleCommand(tg('watch', [ADDR]), d);
  assert.equal((await d.store.getChat('chat:tg:1')).settings.lang, 'zh');
  assert.match((await handleCommand(tg('lang', ['en']), d)).text, /Language set to English/);
  assert.equal((await d.store.getChat('chat:tg:1')).settings.lang, 'en');
  assert.match((await handleCommand(tg('lang', ['fr']), d)).text, /Use \/lang en/);
});
test('/stop deletes a saved language choice too', async () => {
  const d = setup();
  await handleCommand(tg('lang', ['zh']), d);
  await handleCommand(tg('stop'), d);
  assert.equal(await d.store.getLang('chat:tg:1'), null);
  assert.doesNotMatch((await handleCommand(tg('help'), d)).text, /命令/);
});
test('Discord stays English even with /lang zh', async () => {
  const d = setup();
  const r = await handleCommand({ platform: 'dc', chatId: '9', guildId: 'g', userId: 'u', isAdmin: true, name: 'lang', args: ['zh'], lang: 'zh' }, d);
  assert.match(r.text, /Use \/lang en/);
});
test('alerts follow the chat language', () => {
  const L = '0xlead000000000000000000000000000000000001', NOW = Date.UTC(2026, 9, 22, 3, 0);
  const mk = { 'BTC-USD': { hl: 'BTC', tiers: [[1e18, 10, 0.025, 0]] } };
  const snap = (o = {}) => ({ accountId: 'acc', label: 'Sub1', at: NOW, since: NOW - 3600_000, copies: [], subs: { [L]: { status: 'active' } }, fills: [], orphans: [], ...o });
  const cur = snap({ copies: [{ subId: 's1', leadId: L, market: 'BTC-USD', side: 'long', mark: 100, liq: 96 }] });
  const zh = detectAlerts(snap(), cur, { liq: 5, lang: 'zh' }, { mk, now: NOW }).find(a => a.kind === 'A1');
  assert.match(zh.text, /⚠️ Sub1：你的 BTC 多单跟单仓位距离强平 4\.0%（标记价格 100，强平价格 96）/);
  const en = detectAlerts(snap(), cur, { liq: 5 }, { mk, now: NOW }).find(a => a.kind === 'A1');
  assert.match(en.text, /the BTC long copy is 4\.0% from liquidation/);
});
test('A2 wording in both languages (lead flipped, lead gone)', () => {
  const c = { market: 'ETH-USD', side: 'long', leadId: '0xlead000000000000000000000000000000000001' };
  assert.match(A.A2('S', c, { flip: 'short' }), /is now short instead/);
  assert.match(A.A2('S', c, { gone: true }), /no longer holds ETH\./);
  assert.match(AZ.A2('S', c, { flip: 'short' }), /现在持有的是空单/);
  assert.match(AZ.A2('S', c, { gone: true }), /已不再持有 ETH。带单员平仓后，Strike 不一定会同步平掉你的跟单仓位/);
});
test('daily paper line in Chinese', () => {
  const t = { id: 'abc', lead: '0x1234567890abcdef1234567890abcdef12345678', from: Date.UTC(2026, 9, 12), settings: { mode: 'fm', amount: 50, lev: 5, marginMode: 'isolated' } };
  const line = trialLine(t, { net: 123.4, dd: 40, liquidations: 1, taken: 9 }, 'zh');
  assert.match(line, /0x1234…5678 的模拟跟单（固定保证金 \$50，5 倍逐仓）：自 10月1[23]日 起 \+\$123，最大回撤 \$40，强平 1 次，已跟单 9 笔开仓。/);
});
test('/lang tw sets traditional; a zh-TW Telegram user gets traditional replies and alerts', async () => {
  assert.equal(parseLang('繁體'), 'zh-Hant'); assert.equal(parseLang('tw'), 'zh-Hant'); assert.equal(parseLang('hk'), 'zh-Hant');
  const d = setup();
  assert.match((await handleCommand(tg('lang', ['tw']), d)).text, /語言已切換為繁體中文/);
  const r = await handleCommand(tg('watch', [ADDR]), d);
  assert.match(r.text, /正在關注：/); assert.equal((await d.store.getChat('chat:tg:1')).settings.lang, 'zh-Hant');
  const d2 = setup();
  assert.match((await handleCommand(tg('help', [], 'zh-Hant'), d2)).text, /子帳戶 ID：在 Strike App 的子帳戶頁面/);
  const L = '0xlead000000000000000000000000000000000001', NOW = Date.UTC(2026, 9, 22, 3, 0);
  const mk = { 'BTC-USD': { hl: 'BTC', tiers: [[1e18, 10, 0.025, 0]] } };
  const snap = (o = {}) => ({ accountId: 'acc', label: 'Sub1', at: NOW, since: NOW - 3600_000, copies: [], subs: { [L]: { status: 'active' } }, fills: [], orphans: [], ...o });
  const cur = snap({ copies: [{ subId: 's1', leadId: L, market: 'BTC-USD', side: 'short', mark: 100, liq: 104 }] });
  const a = detectAlerts(snap(), cur, { liq: 5, lang: 'zh-Hant' }, { mk, now: NOW }).find(x => x.kind === 'A1');
  assert.match(a.text, /⚠️ Sub1：你的 BTC 空單跟單倉位距離強平 4\.0%（標記價格 100，強平價格 104）。你可以在 Strike 中為該倉位追加保證金/);
});
test('traditional text uses Taiwan/Hong Kong terms, not simplified ones', () => {
  const all = [...Object.values(TH).map(v => typeof v === 'function' ? '' : v), TH.help, TH.start].join('');
  for (const w of ['账', '设置', '默认', '服务器', '信息', '布里斯班']) assert.ok(!all.includes(w), w);
  for (const w of ['帳戶', '設定', '預設', '伺服器', '布里斯本']) assert.ok(all.includes(w) || TH.paperMade({ lead: '0x1', settings: { amount: 1, lev: 1, start: 1 } }, '').includes(w) || TH.paperHelp.includes(w), w);
});
