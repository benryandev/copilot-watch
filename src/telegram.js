// Telegram transport: webhook with a secret header, private chats only, plain-text replies.
import { handleCommand } from './commands.js';
import { T } from './text.js';
import { makeDeps } from './deps.js';

const enc = new TextEncoder();
/** Constant-time string compare (lengths leak, contents don't). */
export function safeEqual(a, b) {
  const x = enc.encode(String(a || '')), y = enc.encode(String(b || ''));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0 && x.length > 0;
}

/** Update → command, or {decline: chatId} for groups, or null to ignore. */
export function telegramUpdateToCommand(update) {
  const m = update?.message;
  if (!m || typeof m.text !== 'string' || !m.chat) return null;
  const text = m.text.trim().slice(0, 600);
  if (!text.startsWith('/')) return m.chat.type === 'private' ? { chatId: String(m.chat.id), plain: true } : null;
  if (m.chat.type !== 'private') return { decline: String(m.chat.id) };
  const [head, ...rest] = text.split(/\s+/);
  const name = head.slice(1).split('@')[0].toLowerCase();
  return { platform: 'tg', chatId: String(m.chat.id), userId: String(m.from?.id ?? m.chat.id), isAdmin: true, name, args: rest };
}

/** Split on line breaks into chunks of at most `max` characters. */
export function chunk(text, max = 4000) {
  const out = []; let cur = '';
  for (const line of text.split('\n')) {
    let l = line;
    while (l.length > max) { if (cur) { out.push(cur); cur = ''; } out.push(l.slice(0, max)); l = l.slice(max); }
    const next = cur ? `${cur}\n${l}` : l;
    if (next.length > max) { out.push(cur); cur = l; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

export async function sendTelegram(env, chatId, text, { fetch = globalThis.fetch } = {}) {
  let ok = true;
  for (const part of chunk(text)) {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: part, disable_web_page_preview: true }) });
    if (r.status === 403 || (r.status === 400 && /chat not found/i.test(await r.text().catch(() => '')))) return 'gone'; // blocked or deleted
    ok = ok && r.ok;
  }
  return ok;
}

export async function handleTelegram(req, env, ctx, deps = null) {
  if (!safeEqual(req.headers.get('x-telegram-bot-api-secret-token'), env.TELEGRAM_WEBHOOK_SECRET)) return new Response('unauthorized', { status: 401 });
  let update; try { update = await req.json(); } catch { return new Response('ok'); }
  const cmd = telegramUpdateToCommand(update);
  if (!cmd) return new Response('ok');
  const send = deps?.send || ((id, t) => sendTelegram(env, id, t));
  const work = (async () => {
    if (cmd.decline) return send(cmd.decline, T.dmOnly);
    if (cmd.plain) return send(cmd.chatId, T.help);
    const reply = await handleCommand(cmd, deps || makeDeps(env));
    await send(cmd.chatId, reply.text);
  })().catch(e => console.log({ telegramError: e?.name || 'error' }));
  ctx.waitUntil(work);
  return new Response('ok');
}
