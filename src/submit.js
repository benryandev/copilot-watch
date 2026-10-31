// Project submissions for Builders' Row in the Strike ecosystem world (strike.benryan.com.au/ecosystem/submit/).
// A submission is checked, stored privately and sent to Ben on Telegram; nothing goes live until he approves it and
// the site is redeployed with the project added (copilot-check ecosystem/js/projects.js).
//   sub:item:<at>-<id>  the submission (no IP); expires after SUBMIT_KEEP_DAYS
//   sub:ip:<hash>       posts from one IP this hour (SUBMIT_PER_HOUR at most); the IP is hashed, never stored
//   sub:day:<YYYY-MM-DD> submissions accepted that UTC day (SUBMIT_PER_DAY at most, so a flood can't swamp Telegram)

import { RACE_ORIGINS, RACE_ADMIN_HEADER } from './race.js';
import { sendTelegram, safeEqual } from './telegram.js';
import { newId } from './paper.js';

export const SUBMIT_CATEGORIES = ['Trading tool', 'Bot', 'Analytics', 'Wallet or app', 'Vault', 'Education', 'Other'];
export const SUBMIT_USES = ['API', 'Builder code', 'Vault', 'Copy trading', 'Referral link', 'Other'];
export const SUBMIT_PER_HOUR = 3, SUBMIT_PER_DAY = 30, SUBMIT_KEEP_DAYS = 180, SUBMIT_MAX_BODY = 8192, SUBMIT_MIN_MS = 3000;
// [field, min, max] for the free-text fields; min 0 means optional
const TEXT = [['name', 2, 40], ['tagline', 10, 100], ['description', 30, 800], ['contact', 3, 100], ['notes', 0, 400], ['listing', 0, 40]];

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f­​-‏‪-‮⁠-⁯﻿]/g;
/** Strip control and invisible characters, trim, collapse runs of spaces (newlines kept in long text, at most two in a row). */
const clean = (s, multiline) => {
  const t = String(s).normalize('NFC').replace(CONTROL, '').replace(/\r\n?/g, '\n');
  return (multiline ? t.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n') : t.replace(/\s+/g, ' ')).trim();
};

/** An https URL with a real host and no credentials, at most 200 characters; returns the normalised string or null. */
export function cleanUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let s = raw.trim();
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u; try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.') || u.href.length > 200) return null;
  return u.href;
}

/** An X handle from "@name", "name" or an x.com / twitter.com link; null if it isn't one. */
export function cleanX(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/i) || s.match(/^@?([A-Za-z0-9_]{1,15})$/);
  return m ? m[1] : null;
}

/** Validate a submission. Returns {ok, item} or {ok: false, error, field}. */
export function parseSubmission(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'bad_json' };
  const item = { type: body.type === 'update' ? 'update' : 'new' };
  for (const [k, min, max] of TEXT) {
    const v = body[k] == null ? '' : typeof body[k] === 'string' ? clean(body[k], k === 'description' || k === 'notes') : null;
    if (v === null || [...v].length > max || (min && [...v].length < min)) return { ok: false, error: 'bad_field', field: k };
    if (v) item[k] = v;
  }
  if (item.type === 'update' && !item.listing) return { ok: false, error: 'bad_field', field: 'listing' };
  if (!SUBMIT_CATEGORIES.includes(body.category)) return { ok: false, error: 'bad_field', field: 'category' };
  item.category = body.category;
  const uses = Array.isArray(body.uses) ? [...new Set(body.uses)] : [];
  if (!uses.length || !uses.every(u => SUBMIT_USES.includes(u))) return { ok: false, error: 'bad_field', field: 'uses' };
  item.uses = uses;
  item.site = cleanUrl(body.site);
  if (!item.site) return { ok: false, error: 'bad_field', field: 'site' };
  for (const k of ['github', 'logo']) {
    if (body[k] == null || body[k] === '') continue;
    const u = cleanUrl(body[k]);
    if (!u || (k === 'github' && new URL(u).hostname !== 'github.com')) return { ok: false, error: 'bad_field', field: k };
    item[k] = u;
  }
  if (body.x != null && body.x !== '') {
    const x = cleanX(body.x);
    if (!x) return { ok: false, error: 'bad_field', field: 'x' };
    item.x = x;
  }
  if (body.permission !== true) return { ok: false, error: 'bad_field', field: 'permission' };
  return { ok: true, item };
}

/** The Telegram alert, plain text (no parse mode, so nothing in a submission can format or inject). */
export function alertText(item, id) {
  const lines = [
    `${item.type === 'update' ? 'Listing update' : 'New project'} for Builders' Row`,
    '',
    `${item.name}: ${item.tagline}`,
    ...(item.type === 'update' ? [`Updating: ${item.listing}`] : []),
    `${item.category} · uses ${item.uses.join(', ')}`,
    `Site: ${item.site}`,
    ...(item.x ? [`X: https://x.com/${item.x}`] : []),
    ...(item.github ? [`GitHub: ${item.github}`] : []),
    ...(item.logo ? [`Logo: ${item.logo}`] : []),
    `Contact: ${item.contact}`,
    '',
    item.description,
    ...(item.notes ? ['', `Notes: ${item.notes}`] : []),
    '',
    `Ref ${id}. Nothing is live until you approve it.`,
  ];
  return lines.join('\n');
}

async function hashHex(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...h.slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const cors = origin => (RACE_ORIGINS.includes(origin)
  ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' }
  : { vary: 'Origin' });
const json = (v, status, origin) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(origin) } });

/** Routes under /submit. `send` is injectable for tests. */
export async function handleSubmitApi(req, env, { now = Date.now(), send = (id, t) => sendTelegram(env, id, t) } = {}) {
  const origin = req.headers.get('origin') || '';
  const url = new URL(req.url), kv = env.KV;
  if (req.method === 'OPTIONS') return new Response(null, { status: RACE_ORIGINS.includes(origin) ? 204 : 403, headers: cors(origin) });

  if (req.method === 'POST' && url.pathname === '/submit') {
    if (!RACE_ORIGINS.includes(origin)) return json({ error: 'origin' }, 403, origin);
    if (Number(req.headers.get('content-length') || 0) > SUBMIT_MAX_BODY) return json({ error: 'too_large' }, 413, origin);
    const buf = await req.arrayBuffer();
    if (buf.byteLength > SUBMIT_MAX_BODY) return json({ error: 'too_large' }, 413, origin);
    let body; try { body = JSON.parse(new TextDecoder().decode(buf)); } catch { return json({ error: 'bad_json' }, 400, origin); }
    // Bots: a filled honeypot or a form sent within seconds of loading looks accepted but is dropped
    if (body?.company || !(Number(body?.elapsed) >= SUBMIT_MIN_MS)) return json({ ok: true }, 200, origin);
    const ipk = 'sub:ip:' + await hashHex(`submit:${req.headers.get('cf-connecting-ip') || '?'}`);
    const n = Number(await kv.get(ipk)) || 0;
    if (n >= SUBMIT_PER_HOUR) return json({ error: 'rate' }, 429, origin);
    await kv.put(ipk, String(n + 1), { expirationTtl: 3600 });
    const p = parseSubmission(body);
    if (!p.ok) return json({ error: p.error, field: p.field }, 400, origin);
    const dayKey = `sub:day:${new Date(now).toISOString().slice(0, 10)}`;
    const today = Number(await kv.get(dayKey)) || 0;
    if (today >= SUBMIT_PER_DAY) return json({ error: 'busy' }, 503, origin);
    await kv.put(dayKey, String(today + 1), { expirationTtl: 2 * 86400 });
    const id = newId().slice(0, 10);
    const item = { id, at: now, ...p.item };
    await kv.put(`sub:item:${now}-${id}`, JSON.stringify(item), { expirationTtl: SUBMIT_KEEP_DAYS * 86400 });
    let alerted = false;
    if (env.SUBMIT_TG_CHAT && env.TELEGRAM_TOKEN) { try { alerted = (await send(env.SUBMIT_TG_CHAT, alertText(item, id))) === true; } catch {} }
    if (!alerted) console.warn('submit: telegram alert failed', id);
    return json({ ok: true, id }, 200, origin);
  }

  // Admin: every stored submission, newest first
  if (req.method === 'GET' && url.pathname === '/submit/list') {
    if (!env.RACE_ADMIN_TOKEN || !safeEqual(req.headers.get(RACE_ADMIN_HEADER), env.RACE_ADMIN_TOKEN)) return json({ error: 'forbidden' }, 403, origin);
    const items = [];
    let cursor;
    do {
      const page = await kv.list({ prefix: 'sub:item:', cursor });
      for (const k of page.keys) { const v = await kv.get(k.name, 'json'); if (v) items.push(v); }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return json({ items: items.sort((a, b) => b.at - a.at) }, 200, origin);
  }

  return json({ error: 'not_found' }, 404, origin);
}
