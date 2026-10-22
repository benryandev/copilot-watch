// Usage counts from KV: what's live now, plus the daily stat:* totals (last 7 days and all time). Prints counts only, never ids.
// Run: node scripts/stats.mjs   (needs `wrangler login`)
import { execFileSync } from 'node:child_process';

const keys = JSON.parse(execFileSync('pnpm', ['dlx', 'wrangler@4', 'kv', 'key', 'list', '--binding', 'KV', '--remote'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
const count = prefix => keys.filter(k => k.name.startsWith(prefix)).length;
console.log('Live now');
console.log(`  Telegram chats      ${count('chat:tg:')}`);
console.log(`  Discord channels    ${count('chat:dc:')}`);
console.log(`  accounts watched    ${count('acct:')}`);
console.log(`  paper copies        ${count('paper:')}  (expire after 30 days)`);

const LABEL = { chat_tg: 'new Telegram chats', chat_dc: 'new Discord channels', stop: '/stop', paper_check: 'paper copies from Check', paper_bot: 'paper copies from the bot', from_check: '/start from Check link', from_copilot: '/start from Strike Copilot link' };
const week = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
const tot = {};
for (const k of keys) {
  const m = /^stat:([a-z_]+):(\d{4}-\d{2}-\d{2})$/.exec(k.name); if (!m) continue;
  const n = Number(k.metadata?.n) || 0, t = (tot[m[1]] ||= { week: 0, all: 0, since: m[2] });
  t.all += n; if (m[2] >= week) t.week += n; if (m[2] < t.since) t.since = m[2];
}
console.log('\nCounts (UTC days)              7 days   all time');
for (const [name, label] of Object.entries(LABEL)) {
  const t = tot[name] || { week: 0, all: 0 };
  console.log(`  ${label.padEnd(32)}${String(t.week).padStart(5)}${String(t.all).padStart(11)}${t.since ? `   since ${t.since}` : ''}`);
}
