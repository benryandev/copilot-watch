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
  { command: 'stop', description: 'Stop everything and delete this chat\'s data' },
  { command: 'help', description: 'How it works' } ] });
await call('setMyDescription', { description: 'Alerts for Strike copy traders: a copy near liquidation, a copy the lead already closed, a missed copy, lead stress and withdrawals. Public data only; never asks for a key. Not financial advice. Not affiliated with Strike Finance.' });
await call('setMyShortDescription', { short_description: 'Alerts for Strike copy traders. Public data only, no keys.' });
