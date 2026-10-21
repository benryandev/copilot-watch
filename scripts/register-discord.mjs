// Registers the slash commands (guild-scoped for testing, or global) and sets the Interactions Endpoint URL.
// Reads the bot token from .secrets/discord_token; never prints it.
//   node scripts/register-discord.mjs --guild <id>
//   node scripts/register-discord.mjs --global
//   node scripts/register-discord.mjs --set-endpoint https://copilot-watch.benryan.workers.dev/discord
import { readFileSync } from 'node:fs';
const token = readFileSync(new URL('../.secrets/discord_token', import.meta.url), 'utf8').trim();
const APP = '1561719393992319007';
const argv = process.argv.slice(2), arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const H = { authorization: `Bot ${token}`, 'content-type': 'application/json' };
const STR = 3, NUM = 4;
const commands = [
  { name: 'watch', description: 'Watch a Strike account in this channel', options: [
    { type: STR, name: 'account', description: 'Strike address (addr1…), nickname or sub-account ID', required: true, max_length: 120 },
    { type: STR, name: 'sub', description: 'Only this sub-account (its name)', required: false, max_length: 40 } ] },
  { name: 'unwatch', description: 'Stop watching one account', options: [{ type: STR, name: 'account', description: 'Its label from /status, or its ID', required: true, max_length: 120 }] },
  { name: 'status', description: 'Open copies and how close each is to liquidation' },
  { name: 'settings', description: 'Alert when a copy is within this % of liquidation', options: [{ type: NUM, name: 'liq', description: '1 to 20 (default 5)', required: true, min_value: 1, max_value: 20 }] },
  { name: 'paper', description: 'Paper copy a Hyperliquid wallet (no money); no wallet lists this channel\'s paper copies', options: [
    { type: STR, name: 'wallet', description: 'Hyperliquid wallet, 0x…', required: false, max_length: 60 },
    { type: NUM, name: 'size', description: 'Paper account size, US$ (default 1000)', required: false, min_value: 10, max_value: 1000000 } ] },
  { name: 'stop', description: 'Stop all watches in this channel and delete its data' },
  { name: 'help', description: 'How Copilot Watch works' },
].map(c => ({ ...c, contexts: [0], integration_types: [0],
  // Changing what a channel watches needs Manage Server by default; server admins can widen it in Server Settings → Integrations.
  ...(['watch', 'unwatch', 'settings', 'stop', 'paper'].includes(c.name) ? { default_member_permissions: '32' } : {}) }));

async function call(method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.log(method, path.replace(/\d{15,}/g, '<id>'), r.status, j.message || ''); process.exit(1); }
  return j;
}
if (arg('--guild')) console.log('guild commands:', (await call('PUT', `/applications/${APP}/guilds/${arg('--guild')}/commands`, commands)).map(c => c.name).join(', '));
if (argv.includes('--global')) console.log('global commands:', (await call('PUT', `/applications/${APP}/commands`, commands)).map(c => c.name).join(', '));
if (arg('--clear-guild')) { await call('PUT', `/applications/${APP}/guilds/${arg('--clear-guild')}/commands`, []); console.log('guild commands cleared'); }
if (arg('--set-endpoint')) { const j = await call('PATCH', '/applications/@me', { interactions_endpoint_url: arg('--set-endpoint') }); console.log('endpoint:', j.interactions_endpoint_url); }
