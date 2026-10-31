// Race time-trial leaderboard for the Copilot Check ecosystem game: best lap per name, top 100 per track in one KV key.
//   race:top:<track>   [{id, name, key, ms, splits, trace, at}] sorted by ms, then earlier at; at most 100, one per name (key = lower case)
//                      trace: the lap's path for the ghost car, [[t ms, x, z, heading], ...] ten times a second, or null for laps
//                      posted before ghosts existed (the page then rebuilds a ghost from the checkpoint times)
//   race:ip:<hash>     attempt time (one post per IP every 30 s; the key lives 60 s, KV's minimum TTL). The IP is hashed, never stored.
//   race:stats:<track>:<YYYY-MM-DD>  {open, found, start, finish, post}: visitors per UTC day who reached each stage
//   race:seen:<hash>   one per IP, track, day and stage, so a visitor counts once per stage per day; expires after 2 days
// Times are checked against the track (src/race-tracks.js): every checkpoint segment must take at least its length / RACE_MAX_SPEED.

import { RACE_TRACKS, RACE_MAX_SPEED, RACE_MAX_MS, RACE_SEG_MAX_SPEED } from './race-tracks.js';
import { safeEqual } from './telegram.js';
import { newId } from './paper.js';

export const RACE_ORIGINS = ['https://strike.benryan.com.au', 'http://localhost:8766'];
export const RACE_KEEP = 100, RACE_SHOW = 10, RACE_RATE_SEC = 10, RACE_MAX_BODY = 16384, RACE_NAME_MAX = 20;
/** Ghost trace: at least 2 and at most 400 samples (40 s at ten a second; the page thins longer laps). */
export const RACE_TRACE_MIN = 2, RACE_TRACE_MAX = 400;
/** A trace must cover at least this share of the lap length (an inside line is shorter than the centreline, a fake is far shorter). */
export const RACE_TRACE_MIN_PATH = 0.7;
/** Fastest believable speed between two trace samples. Looser than the segment check (RACE_MAX_SPEED): samples are 100 ms apart
 * with positions rounded to 0.1 m, and a landing or a nudge off a wall moves the car a little between frames. Ben's first real
 * lap (31 Oct 2026) peaked at 29.3 m/s between samples; the lap itself averaged 25 m/s. A teleport is hundreds of m/s. */
export const RACE_TRACE_MAX_SPEED = 40;
export const RACE_TRACE_ROUNDING = 0.3; // m: two positions each rounded to 0.1 m can differ by this much with no movement at all
export const RACE_ADMIN_HEADER = 'x-race-admin';
// Funnel stages, in order. "post" is counted here when a time is accepted; the page sends the rest.
export const RACE_EVENTS = ['open', 'found', 'start', 'finish', 'post'];
export const RACE_STATS_DAYS = 90;

// ---- names ----

// Zero-width, joiner, bidi-control and other invisible characters: stripped before any other check.
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/gu;
// Anything left in Unicode "other" (controls, format, surrogates, private use, unassigned) or a line/paragraph separator is refused.
const UNPRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/u;
const LEET = { 0: 'o', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };

// Rude words. ANYWHERE: refused even inside a longer word (rarely innocent). WHOLE: refused only as a whole word, a run of
// single letters ("c u n t") or the whole name with separators removed, so Scunthorpe, Dickens, Hitchcock, grape, therapist,
// torpedo and saltwater pass. Kept short on purpose; extend as needed.
const ANYWHERE = ['fuck', 'fck', 'shit', 'nigger', 'nigga', 'faggot', 'bitch', 'wanker', 'whore', 'motherf'];
const WHOLE = ['fuk', 'cunt', 'cunts', 'cock', 'cocks', 'dick', 'dicks', 'ass', 'arse', 'asshole', 'arsehole', 'twat', 'slut', 'fag', 'fags',
  'tit', 'tits', 'penis', 'vagina', 'pussy', 'rape', 'rapist', 'pedo', 'porn', 'cum', 'jizz', 'nazi', 'hitler', 'kys', 'piss', 'wank',
  'bollocks', 'prick', 'retard', 'retarded'];
const squeeze = s => s.replace(/(.)\1+/g, '$1'); // "fuuuck" -> "fuck"
const ANY_SQ = ANYWHERE.map(squeeze);
// Whole words match as spelled, or squeezed when the word has no doubled letter (so "as" never matches "ass").
const WHOLE_RAW = new Set(WHOLE), WHOLE_SQ = new Set(WHOLE.filter(w => squeeze(w) === w));
const letters = s => s.replace(/[^a-z]/g, '');

/** True when the name contains a rude word after lower-casing, removing accents, undoing l33t and dropping separators. */
export function isRude(name) {
  const base = String(name).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[03457@$!]/g, c => LEET[c]);
  for (const one of ['i', 'l']) { // 1 can stand for i or l
    const s = base.replace(/1/g, one);
    const words = s.split(/[^a-z]+/).filter(Boolean);
    const chunks = s.split(/\s+/).map(letters).filter(Boolean); // "fu.ck" -> "fuck", but "push it" stays two words
    const runs = s.split(/[^a-z]*[a-z]{2,}[^a-z]*/).map(letters).filter(Boolean); // single letters joined: "f u c k" -> "fuck"
    for (const v of [...chunks, ...runs]) if (ANY_SQ.some(w => squeeze(v).includes(w))) return true;
    for (const v of [...words, ...chunks, ...runs, letters(s)]) if (WHOLE_RAW.has(v) || WHOLE_SQ.has(squeeze(v))) return true;
  }
  return false;
}

/** Clean a name: strip invisible characters, trim, collapse spaces. Returns {ok, name} or {ok: false, error}. */
export function cleanName(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'bad_name' };
  const visible = raw.normalize('NFC').replace(INVISIBLE, '');
  if (UNPRINTABLE.test(visible)) return { ok: false, error: 'bad_name' }; // before spaces collapse, so tabs and newlines are refused
  const name = visible.replace(/\s+/gu, ' ').trim();
  const len = [...name].length;
  if (!len || len > RACE_NAME_MAX) return { ok: false, error: 'bad_name' };
  if (isRude(name)) return { ok: false, error: 'rude_name' };
  return { ok: true, name };
}

// ---- times ----

const minMs = metres => (metres * 1000) / RACE_MAX_SPEED;

/** Validate an optional ghost trace against the lap time and the track. Returns {ok, trace} (null when none given) or {ok: false, error}. */
export function parseTrace(trace, ms, t) {
  if (trace === undefined || trace === null) return { ok: true, trace: null };
  const bad = why => ({ ok: false, error: 'bad_trace', why }); // why: shape | range | order | speed | ends | path (for the log)
  if (!Array.isArray(trace) || trace.length < RACE_TRACE_MIN || trace.length > RACE_TRACE_MAX) return bad('shape');
  const out = []; let path = 0, prev = null;
  for (const s of trace) {
    if (!Array.isArray(s) || s.length !== 4) return bad('shape');
    const [tt, x, z, h] = s;
    if (!Number.isSafeInteger(tt) || tt < 0 || tt > ms) return bad('range');
    if (![x, z, h].every(v => typeof v === 'number' && Number.isFinite(v)) || Math.abs(x) > 2000 || Math.abs(z) > 2000 || Math.abs(h) > 100) return bad('range');
    if (prev) {
      const dt = tt - prev[0];
      if (dt <= 0) return bad('order');
      const d = Math.hypot(x - prev[1], z - prev[2]);
      if (d > (RACE_TRACE_MAX_SPEED * dt) / 1000 + RACE_TRACE_ROUNDING) return bad('speed'); // speed limit, plus what 0.1 m rounding can add
      path += d;
    }
    out.push([tt, Math.round(x * 10) / 10, Math.round(z * 10) / 10, Math.round(h * 100) / 100]);
    prev = s;
  }
  if (out[0][0] > 1000 || ms - out[out.length - 1][0] > 1500) return bad('ends'); // starts on the line, ends at the line
  if (path < RACE_TRACE_MIN_PATH * t.length) return bad('path');
  return { ok: true, trace: out };
}

/** Validate a posted time. Returns {ok, entry: {track, name, key, ms, splits}} or {ok: false, error}. */
export function parseTime(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'bad_json' };
  const t = typeof body.track === 'string' && Object.hasOwn(RACE_TRACKS, body.track) ? RACE_TRACKS[body.track] : null;
  if (!t) return { ok: false, error: 'unknown_track' };
  const n = cleanName(body.name);
  if (!n.ok) return n;
  const { splits, ms } = body, cps = t.checkpoints;
  if (!Array.isArray(splits) || splits.length !== cps.length || !splits.every(x => Number.isSafeInteger(x) && x > 0)
    || splits.some((x, i) => i > 0 && x <= splits[i - 1])) return { ok: false, error: 'bad_splits' };
  const last = splits.length ? splits[splits.length - 1] : 0;
  if (!Number.isSafeInteger(ms) || ms <= last || ms >= RACE_MAX_MS) return { ok: false, error: 'bad_ms' };
  if (ms < minMs(t.length)) return { ok: false, error: 'lap_too_fast' };
  const at = [...splits, ms], dist = [...cps, t.length];
  for (let i = 0; i < at.length; i++)
    if (at[i] - (i ? at[i - 1] : 0) < ((dist[i] - (i ? dist[i - 1] : 0)) * 1000) / RACE_SEG_MAX_SPEED) return { ok: false, error: 'segment_too_fast', segment: i };
  // The trace only feeds the ghost: a bad one is dropped, the lap stands (the splits and lap checks above are the anti-cheat)
  const tr = parseTrace(body.trace, ms, t);
  const entry = { track: body.track, name: n.name, key: n.name.toLowerCase(), ms, splits: [...splits], trace: tr.ok ? tr.trace : null };
  return tr.ok ? { ok: true, entry } : { ok: true, entry, traceDropped: tr.why };
}

// ---- board ----

const boardKey = track => `race:top:${track}`;
const order = (a, b) => a.ms - b.ms || a.at - b.at;
const pub = rows => rows.slice(0, RACE_SHOW).map(({ name, ms, at }) => ({ name, ms, at }));
export const getBoard = async (kv, track) => (await kv.get(boardKey(track), 'json')) || [];

/** Add a validated entry, keeping each name's best. Returns {rank (1-based or null), best, rows}. */
export async function addTime(kv, entry, now = Date.now()) {
  const rows = await getBoard(kv, entry.track);
  const mine = rows.find(r => r.key === entry.key);
  if (mine && mine.ms <= entry.ms) return { rank: rows.indexOf(mine) + 1, best: false, rows };
  const row = { id: newId(), name: entry.name, key: entry.key, ms: entry.ms, splits: entry.splits, trace: entry.trace || null, at: now };
  const next = [...rows.filter(r => r.key !== entry.key), row].sort(order).slice(0, RACE_KEEP);
  const i = next.indexOf(row);
  if (i < 0) return { rank: mine ? rows.indexOf(mine) + 1 : null, best: false, rows }; // missed the top 100: nothing changes
  await kv.put(boardKey(entry.track), JSON.stringify(next));
  return { rank: i + 1, best: true, rows: next };
}

/** Remove entries by id or by name (case-insensitive). Returns the number removed. */
export async function removeTime(kv, track, { id, name } = {}) {
  const rows = await getBoard(kv, track);
  const key = typeof name === 'string' ? name.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim().toLowerCase() : null;
  const next = rows.filter(r => !((id && r.id === id) || (key && r.key === key)));
  if (next.length !== rows.length) await kv.put(boardKey(track), JSON.stringify(next));
  return rows.length - next.length;
}

// ---- HTTP ----

const cors = origin => (RACE_ORIGINS.includes(origin)
  ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' }
  : { vary: 'Origin' });
const json = (v, status, origin, extra = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(origin), ...extra } });

async function hashHex(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...h.slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const ipKey = async ip => 'race:ip:' + await hashHex(`race:${ip}`);

// ---- funnel counts ----

const utcDay = now => new Date(now).toISOString().slice(0, 10);
const statsKey = (track, day) => `race:stats:${track}:${day}`;

/** Count one visitor reaching a stage today, once per IP. Counts are approximate under bursts (KV read, then write). */
export async function countEvent(kv, track, kind, ip, now = Date.now()) {
  const day = utcDay(now);
  const seen = 'race:seen:' + await hashHex(`seen:${track}:${day}:${kind}:${ip}`);
  if (await kv.get(seen)) return false;
  await kv.put(seen, '1', { expirationTtl: 2 * 86400 });
  const k = statsKey(track, day);
  const c = (await kv.get(k, 'json')) || {};
  c[kind] = (c[kind] || 0) + 1;
  await kv.put(k, JSON.stringify(c), { expirationTtl: (RACE_STATS_DAYS + 1) * 86400 });
  return true;
}

/** The last `days` UTC days of counts, newest first, every stage filled in. */
export async function getStats(kv, track, days, now = Date.now()) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = utcDay(now - i * 86400000);
    const c = (await kv.get(statsKey(track, day), 'json')) || {};
    out.push({ day, ...Object.fromEntries(RACE_EVENTS.map(e => [e, c[e] || 0])) });
  }
  return out;
}

async function readJson(req) {
  if (Number(req.headers.get('content-length') || 0) > RACE_MAX_BODY) return { error: 'too_large', status: 413 };
  const buf = await req.arrayBuffer();
  if (buf.byteLength > RACE_MAX_BODY) return { error: 'too_large', status: 413 };
  if (!buf.byteLength) return { body: {} };
  try { return { body: JSON.parse(new TextDecoder().decode(buf)) }; } catch { return { error: 'bad_json', status: 400 }; }
}

const isAdmin = (req, env) => !!env.RACE_ADMIN_TOKEN && safeEqual(req.headers.get(RACE_ADMIN_HEADER), env.RACE_ADMIN_TOKEN);

/** Routes under /race/. */
export async function handleRaceApi(req, env, { now = Date.now() } = {}) {
  const origin = req.headers.get('origin') || '';
  const url = new URL(req.url), kv = env.KV;
  if (req.method === 'OPTIONS') return new Response(null, { status: RACE_ORIGINS.includes(origin) ? 204 : 403, headers: cors(origin) });

  if (req.method === 'GET' && url.pathname === '/race/top') {
    const track = url.searchParams.get('track') || '';
    if (!Object.hasOwn(RACE_TRACKS, track)) return json({ error: 'unknown_track' }, 404, origin);
    const rows = await getBoard(kv, track);
    // With the admin header, the whole board with ids (so an entry can be deleted by id); the public gets names only.
    if (isAdmin(req, env)) return json({ track, all: rows.map(({ id, name, ms, splits, trace, at }) => ({ id, name, ms, splits, trace: trace ? trace.length : null, at })) }, 200, origin);
    return json({ track, top: pub(rows) }, 200, origin);
  }

  // The ghost: the fastest lap on the board with its checkpoint splits and, when it has one, its path
  if (req.method === 'GET' && url.pathname === '/race/ghost') {
    const track = url.searchParams.get('track') || '';
    if (!Object.hasOwn(RACE_TRACKS, track)) return json({ error: 'unknown_track' }, 404, origin);
    const r = (await getBoard(kv, track))[0];
    return json({ track, ghost: r ? { name: r.name, ms: r.ms, splits: r.splits, trace: r.trace || null, at: r.at } : null }, 200, origin);
  }

  if (req.method === 'POST' && url.pathname === '/race/time') {
    if (!RACE_ORIGINS.includes(origin)) return json({ error: 'origin' }, 403, origin);
    const r = await readJson(req);
    if (r.error) return json({ error: r.error }, r.status, origin);
    // Every post that parses counts toward the per-IP limit, valid or not, so guessing the checks is slow.
    const ip = req.headers.get('cf-connecting-ip') || '?';
    const k = await ipKey(ip);
    const prev = Number(await kv.get(k));
    if (prev && now - prev < RACE_RATE_SEC * 1000) {
      const wait = Math.max(1, Math.ceil((prev + RACE_RATE_SEC * 1000 - now) / 1000));
      return json({ error: 'rate', retryAfter: Math.min(wait, RACE_RATE_SEC) }, 429, origin, { 'retry-after': String(Math.min(wait, RACE_RATE_SEC)) });
    }
    await kv.put(k, String(now), { expirationTtl: Math.max(60, RACE_RATE_SEC) }); // KV won't take a TTL under 60 s; the window is checked above
    const p = parseTime(r.body);
    if (p.ok && p.traceDropped) console.log('race trace dropped', JSON.stringify({ why: p.traceDropped, ms: r.body.ms, name: r.body.name, trace: Array.isArray(r.body.trace) ? r.body.trace.slice(0, 3).concat([['…', r.body.trace.length]], r.body.trace.slice(-3)) : typeof r.body.trace }));
    if (!p.ok) {
      // Rejections are rare and the message to the player is short: keep the detail in the log for a tail
      console.log('race reject', JSON.stringify({ error: p.error, segment: p.segment ?? null, ms: r.body?.ms, splits: r.body?.splits, trace: Array.isArray(r.body?.trace) ? r.body.trace.length : null, name: r.body?.name }));
      return json({ error: p.error, ...(p.segment != null ? { segment: p.segment } : {}) }, 400, origin);
    }
    const { rank, best, rows } = await addTime(kv, p.entry, now);
    await countEvent(kv, p.entry.track, 'post', ip, now);
    return json({ ok: true, rank, best, top: pub(rows), ...(p.traceDropped ? { traceDropped: p.traceDropped } : {}) }, 200, origin);
  }

  // Funnel event from the page (sent with sendBeacon, so text/plain and no preflight). No reply body.
  if (req.method === 'POST' && url.pathname === '/race/event') {
    if (!RACE_ORIGINS.includes(origin)) return json({ error: 'origin' }, 403, origin);
    const r = await readJson(req);
    if (r.error) return json({ error: r.error }, r.status, origin);
    const { track, kind } = r.body && typeof r.body === 'object' ? r.body : {};
    if (typeof track !== 'string' || !Object.hasOwn(RACE_TRACKS, track)) return json({ error: 'unknown_track' }, 400, origin);
    if (typeof kind !== 'string' || kind === 'post' || !RACE_EVENTS.includes(kind)) return json({ error: 'bad_kind' }, 400, origin);
    await countEvent(kv, track, kind, req.headers.get('cf-connecting-ip') || '?', now);
    return new Response(null, { status: 204, headers: cors(origin) });
  }

  // Funnel counts, admin only: ?track=&days= (1 to 90, default 14)
  if (req.method === 'GET' && url.pathname === '/race/stats') {
    if (!isAdmin(req, env)) return json({ error: 'forbidden' }, 403, origin);
    const track = url.searchParams.get('track') || '';
    if (!Object.hasOwn(RACE_TRACKS, track)) return json({ error: 'unknown_track' }, 404, origin);
    const days = Math.min(RACE_STATS_DAYS, Math.max(1, Number.parseInt(url.searchParams.get('days'), 10) || 14));
    return json({ track, days: await getStats(kv, track, days, now) }, 200, origin);
  }

  if (req.method === 'DELETE' && url.pathname === '/race/time') {
    const token = env.RACE_ADMIN_TOKEN;
    if (!token) return json({ error: 'admin_disabled' }, 403, origin);
    const given = req.headers.get(RACE_ADMIN_HEADER);
    if (!given) return json({ error: 'unauthorized' }, 401, origin);
    if (!safeEqual(given, token)) return json({ error: 'forbidden' }, 403, origin);
    const r = await readJson(req);
    if (r.error) return json({ error: r.error }, r.status, origin);
    const b = r.body && typeof r.body === 'object' ? r.body : {};
    const q = k => (typeof b[k] === 'string' && b[k]) || url.searchParams.get(k) || '';
    const track = q('track'), id = q('id'), name = q('name');
    if (!Object.hasOwn(RACE_TRACKS, track)) return json({ error: 'unknown_track' }, 400, origin);
    if (!id && !name) return json({ error: 'need_id_or_name' }, 400, origin);
    const removed = await removeTime(kv, track, { id: id || null, name: name || null });
    return json({ ok: removed > 0, removed }, removed ? 200 : 404, origin);
  }

  return json({ error: 'not_found' }, 404, origin);
}
