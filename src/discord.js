// Discord transport: signed HTTP interactions (no gateway), deferred replies, channel posts. Mentions are always off.
import { handleCommand } from './commands.js';
import { chunk } from './telegram.js';
import { makeDeps } from './deps.js';

const API = 'https://discord.com/api/v10';
const hex = h => new Uint8Array((h.match(/../g) || []).map(b => parseInt(b, 16)));
const enc = new TextEncoder();
const NO_MENTIONS = { parse: [] };
const SUPPRESS_EMBEDS = 1 << 2, EPHEMERAL = 1 << 6;
const MANAGE_GUILD = 0x20n;

/** Escape Discord markdown so names taken from Strike can't format or break a message. */
export const dcSafe = t => String(t).replace(/([\\*_~`|>#[\]()])/g, '\\$1');

/** Ed25519 check of X-Signature-Ed25519 over timestamp + body; rejects timestamps older than 5 minutes. */
export async function verifyDiscord(req, publicKeyHex, { now = Date.now() } = {}) {
  const sig = req.headers.get('x-signature-ed25519'), ts = req.headers.get('x-signature-timestamp');
  const body = await req.text();
  if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig) || !/^\d{1,12}$/.test(ts)) return { ok: false };
  if (Math.abs(now / 1000 - Number(ts)) > 300) return { ok: false };
  try {
    const key = await crypto.subtle.importKey('raw', hex(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, hex(sig), enc.encode(ts + body));
    return ok ? { ok: true, body } : { ok: false };
  } catch { return { ok: false }; }
}

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

/** Interaction → platform-neutral command. */
export function interactionToCommand(i) {
  const opt = Object.fromEntries((i.data?.options || []).map(o => [o.name, o.value]));
  const name = i.data?.name;
  const args = name === 'watch' ? [opt.account, opt.sub] : name === 'unwatch' ? [opt.account] : name === 'settings' ? [`liq=${opt.liq}`] : [];
  const perms = BigInt(i.member?.permissions || '0');
  return { platform: 'dc', chatId: String(i.channel_id || i.channel?.id), guildId: i.guild_id ? String(i.guild_id) : null,
    userId: String(i.member?.user?.id || i.user?.id || ''), isAdmin: (perms & MANAGE_GUILD) !== 0n, name, args: args.filter(a => a != null).map(String) };
}

async function editOriginal(env, token, text, ephemeral, fetch) {
  const parts = chunk(dcSafe(text), 1900);
  const base = `${API}/webhooks/${env.DISCORD_APP_ID}/${token}`;
  const h = { 'content-type': 'application/json' };
  await fetch(`${base}/messages/@original`, { method: 'PATCH', headers: h, body: JSON.stringify({ content: parts[0], allowed_mentions: NO_MENTIONS, flags: SUPPRESS_EMBEDS }) });
  for (const p of parts.slice(1)) await fetch(base, { method: 'POST', headers: h, body: JSON.stringify({ content: p, allowed_mentions: NO_MENTIONS, flags: SUPPRESS_EMBEDS | (ephemeral ? EPHEMERAL : 0) }) });
}

export async function handleDiscord(req, env, ctx, deps = null) {
  const v = await verifyDiscord(req, env.DISCORD_PUBLIC_KEY, { now: deps?.now?.() ?? Date.now() });
  if (!v.ok) return new Response('invalid request signature', { status: 401 });
  let i; try { i = JSON.parse(v.body); } catch { return new Response('bad request', { status: 400 }); }
  if (i.type === 1) return json({ type: 1 });
  if (i.type !== 2) return json({ type: 4, data: { content: 'Not supported.', flags: EPHEMERAL } });
  const cmd = interactionToCommand(i);
  if (!cmd.guildId) return json({ type: 4, data: { content: 'Copilot Watch posts alerts in a server channel. Add it to a server and run /watch in the channel you want.', flags: EPHEMERAL, allowed_mentions: NO_MENTIONS } });
  const fetch = deps?.fetch || globalThis.fetch;
  ctx.waitUntil((async () => {
    let reply;
    try { reply = await handleCommand(cmd, deps || makeDeps(env)); } catch { reply = { text: 'Something went wrong reading Strike. Try again in a minute.' }; }
    await editOriginal(env, i.token, reply.text, reply.ephemeral, fetch);
  })().catch(e => console.log({ discordError: e?.name || 'error' })));
  return json({ type: 5 });
}

/** Post an alert to a channel. Returns true when Discord accepted every part. */
export async function postDiscord(env, channelId, text, { fetch = globalThis.fetch } = {}) {
  let ok = true;
  for (const p of chunk(dcSafe(text), 1900)) {
    const r = await fetch(`${API}/channels/${channelId}/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bot ${env.DISCORD_TOKEN}` },
      body: JSON.stringify({ content: p, allowed_mentions: NO_MENTIONS, flags: SUPPRESS_EMBEDS }) });
    if (r.status === 403 || r.status === 404) return 'gone'; // bot removed or channel deleted
    ok = ok && r.ok;
  }
  return ok;
}
