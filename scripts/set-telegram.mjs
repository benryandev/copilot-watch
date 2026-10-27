// Points the Telegram bot at the Worker and sets its command list. Reads tokens from .secrets/; never prints them or the URLs that hold them.
import { readFileSync } from 'node:fs';
const token = readFileSync(new URL('../.secrets/telegram_token', import.meta.url), 'utf8').trim();
const secret = readFileSync(new URL('../.secrets/telegram_webhook_secret', import.meta.url), 'utf8').trim();
const url = process.env.WORKER_URL || 'https://copilot-watch.benryan.workers.dev/telegram';
const call = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); console.log(method, j.ok ? 'ok' : 'failed', j.description || '');
};
await call('setWebhook', { url, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true });
await call('setMyCommands', { commands: [
  { command: 'watch', description: 'Watch a Strike account (addr1, nickname or sub-account ID)' },
  { command: 'status', description: 'Open copies and distance to liquidation' },
  { command: 'settings', description: 'Liquidation alert threshold, e.g. liq=5' },
  { command: 'unwatch', description: 'Stop watching one account' },
  { command: 'paper', description: 'Paper copy a Hyperliquid wallet (no money)' },
  { command: 'lang', description: 'Language: /lang en, /lang zh (简体) or /lang tw (繁體)' },
  { command: 'stop', description: 'Stop everything and delete this chat\'s data' },
  { command: 'help', description: 'How it works' } ] });
// Chinese menu and descriptions for Telegram users whose app is set to Chinese (language_code zh*).
await call('setMyCommands', { language_code: 'zh', commands: [
  { command: 'watch', description: '关注一个 Strike 账户（addr1、昵称或子账户 ID）' },
  { command: 'status', description: '当前跟单仓位，以及距离强平还有多远' },
  { command: 'settings', description: '强平提醒的阈值，例如 liq=5' },
  { command: 'unwatch', description: '停止关注某个账户' },
  { command: 'paper', description: '模拟跟单一个 Hyperliquid 钱包（不用真钱）' },
  { command: 'lang', description: '切换语言：/lang en、/lang zh（简体）或 /lang tw（繁體）' },
  { command: 'stop', description: '停止全部提醒，并删除本聊天的数据' },
  { command: 'help', description: '使用说明' } ] });
await call('setMyDescription', { language_code: 'zh', description: '为 Strike 跟单用户发送提醒：跟单仓位接近强平、带单员已平仓但跟单仍持有、漏跟的交易、带单员的保证金压力和资金转出。只读取公开数据，绝不索要密钥。不构成投资建议。与 Strike Finance 无关联。' });
await call('setMyShortDescription', { language_code: 'zh', short_description: '为 Strike 跟单用户发送提醒。只读公开数据，不需要密钥。' });
await call('setMyDescription', { description: 'Alerts for Strike copy traders: a copy near liquidation, a copy the lead already closed, a missed copy, lead stress and withdrawals. Public data only; never asks for a key. Not financial advice. Not affiliated with Strike Finance.' });
await call('setMyShortDescription', { short_description: 'Alerts for Strike copy traders. Public data only, no keys.' });
