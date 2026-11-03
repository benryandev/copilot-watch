// Race time-trial leaderboard for the Copilot Check ecosystem game: best lap per name, top 100 per track in one KV key.
//   race:top:<track>   [{id, name, key, ipk, ak, ms, splits, trace, at}] sorted by ms, then earlier at; at most 100, one per name
//                      (key = lower case) and one per player (ipk: a hash of the poster's address and device token, or of the
//                      address alone when the page sent no token), at most RACE_ADDR_ROWS per address (ak: a hash of the
//                      address; rows from before tokens have no ak and carry that same hash as ipk). Hashes are never sent out.
//                      trace: the lap's path for the ghost car, [[t ms, x, z, heading], ...] ten times a second, or null for laps
//                      posted before ghosts existed (the page then rebuilds a ghost from the checkpoint times)
//   race:ip:<hash>     {t, n}: posts from one address in the window that began at t (RACE_RATE_BURST per RACE_RATE_SEC; the key
//                      lives 60 s, KV's minimum TTL). The IP is hashed, never stored.
//   race:stats:<track>:<YYYY-MM-DD>  {open, found, start, finish, post}: visitors per UTC day who reached each stage
//   race:seen:<hash>   one per IP, track, day and stage, so a visitor counts once per stage per day; expires after 2 days
// Times are checked against the track (src/race-tracks.js): every checkpoint segment must take at least its length / RACE_MAX_SPEED.

import { RACE_TRACKS, RACE_MAX_SPEED, RACE_MAX_MS, RACE_SEG_MAX_SPEED } from './race-tracks.js';
import { safeEqual } from './telegram.js';
import { newId } from './paper.js';

export const RACE_ORIGINS = ['https://strike.benryan.com.au', 'http://localhost:8766'];
export const RACE_KEEP = 100, RACE_SHOW = 10, RACE_RATE_SEC = 10, RACE_MAX_BODY = 16384, RACE_NAME_MAX = 20;
/** People who share one public address (a colleague on Tynus's office wifi was told a better time was already on the board,
 * 4 Nov 2026): each device gets its own row, up to this many rows per address, and the post limit is a budget of this many per
 * address per RACE_RATE_SEC rather than one. The budget stays per address, not per device: a token is free to mint. */
export const RACE_ADDR_ROWS = 5, RACE_RATE_BURST = 5;
/** A device token: 16 random bytes as hex, made once by the page and kept in its storage. Anything else counts as no token. */
const DEVICE = /^[0-9a-f]{32}$/i;
export const parseDevice = v => (typeof v === 'string' && DEVICE.test(v) ? v.toLowerCase() : null);
/** Ghost trace: at least 2 and at most 400 samples (40 s at ten a second; the page thins longer laps). */
export const RACE_TRACE_MIN = 2, RACE_TRACE_MAX = 400;
/** A trace must cover at least this share of the lap length (an inside line is shorter than the centreline, a fake is far shorter). */
export const RACE_TRACE_MIN_PATH = 0.7;
/** Fastest believable speed between two trace samples. Looser than the segment check (RACE_MAX_SPEED): samples are 100 ms apart
 * with positions rounded to 0.1 m, and a landing or a nudge off a wall moves the car a little between frames. Ben's first real
 * lap (31 Oct 2026) peaked at 29.3 m/s between samples; the lap itself averaged 25 m/s. A teleport is hundreds of m/s. */
export const RACE_TRACE_WINDOW_MS = 1000; // the trace speed limit is also checked over this long, past the rounding slack
export const RACE_TRACE_MAX_SPEED = 29; // the car's 24 m/s, 28 for a moment after a jump boost, and a little slack (was 40: a 34 m/s lap got through, 1 Nov 2026)
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
  const out = []; let path = 0, prev = null, win = 0;
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
      // The same limit over about a second, where the rounding allowance no longer hides a few m/s (a lap pinned at 31 m/s
      // passes sample to sample; a real 28 m/s boost burst of 1.6 s inside a 24 m/s lap still fits)
      while (win < out.length && tt - out[win][0] > RACE_TRACE_WINDOW_MS) win++;
      if (win < out.length && tt - out[win][0] >= RACE_TRACE_WINDOW_MS * 0.8) {
        const w = out[win], wd = Math.hypot(x - w[1], z - w[2]);
        if (wd > (RACE_TRACE_MAX_SPEED * (tt - w[0])) / 1000 + RACE_TRACE_ROUNDING) return bad('speed');
      }
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
  // The trace is the anti-cheat that sees every tenth of a second, not just the checkpoints: a lap without a valid
  // one does not count (every real client sends one; since 1 Nov 2026, when a trace-less post could skip the speed check)
  if (body.trace === undefined || body.trace === null) return { ok: false, error: 'bad_trace', why: 'missing' };
  const tr = parseTrace(body.trace, ms, t);
  if (!tr.ok) return { ok: false, error: 'bad_trace', why: tr.why };
  return { ok: true, entry: { track: body.track, name: n.name, key: n.name.toLowerCase(), ms, splits: [...splits], trace: tr.trace, device: parseDevice(body.device) } };
}

// ---- board ----

const boardKey = track => `race:top:${track}`;
const order = (a, b) => a.ms - b.ms || a.at - b.at;
const pub = rows => rows.slice(0, RACE_SHOW).map(({ name, ms, at }) => ({ name, ms, at }));
export const getBoard = async (kv, track) => (await kv.get(boardKey(track), 'json')) || [];

/** Add a validated entry: one row per name and one per player (entry.ipk, a hash of the poster's address and device token),
 *  each keeping its best. A faster lap under a new name from the same player replaces that player's row, name and all;
 *  a slower one changes nothing (one player filled nine of the top ten under name variants, 1 Nov 2026). One address
 *  (entry.ak) holds at most RACE_ADDR_ROWS rows, so clearing storage for a fresh token cannot refill the board from one
 *  connection: a post that would add a row past that is refused with error 'address_full', while a post that replaces a
 *  row the address already holds always goes through. Rows from before tokens carry the address hash as ipk and no ak.
 *  Returns {rank (1-based or null), best, rows, error?}. */
export async function addTime(kv, entry, now = Date.now()) {
  const rows = await getBoard(kv, entry.track);
  const same = r => r.key === entry.key || (entry.ipk && r.ipk === entry.ipk);
  const held = rows.filter(same).sort(order)[0];
  if (held && held.ms <= entry.ms) return { rank: rows.indexOf(held) + 1, best: false, rows };
  if (entry.ak) {
    const mine = rows.filter(r => (r.ak || r.ipk) === entry.ak);
    if (mine.length >= RACE_ADDR_ROWS && !mine.some(same)) return { rank: null, best: false, rows, error: 'address_full' };
  }
  const row = { id: newId(), name: entry.name, key: entry.key, ipk: entry.ipk || null, ak: entry.ak || null, ms: entry.ms, splits: entry.splits, trace: entry.trace || null, at: now };
  const next = [...rows.filter(r => !same(r)), row].sort(order).slice(0, RACE_KEEP);
  const i = next.indexOf(row);
  if (i < 0) return { rank: held ? rows.indexOf(held) + 1 : null, best: false, rows }; // missed the top 100: nothing changes
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

export const cors = origin => (RACE_ORIGINS.includes(origin)
  ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' }
  : { vary: 'Origin' });
export const json = (v, status, origin, extra = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(origin), ...extra } });

export async function hashHex(s) {
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

export async function readJson(req) {
  if (Number(req.headers.get('content-length') || 0) > RACE_MAX_BODY) return { error: 'too_large', status: 413 };
  const buf = await req.arrayBuffer();
  if (buf.byteLength > RACE_MAX_BODY) return { error: 'too_large', status: 413 };
  if (!buf.byteLength) return { body: {} };
  try { return { body: JSON.parse(new TextDecoder().decode(buf)) }; } catch { return { error: 'bad_json', status: 400 }; }
}

export const isAdmin = (req, env) => !!env.RACE_ADMIN_TOKEN && safeEqual(req.headers.get(RACE_ADMIN_HEADER), env.RACE_ADMIN_TOKEN);

/** Routes under /race/. */
/** Tell the world room about a new #1 (fireworks for everyone there). Best effort: never delays or fails the post. */
function announceRecord(env, rec, waitUntil) {
  if (!env.WORLD?.fetch || !env.RACE_ADMIN_TOKEN) return;
  const job = env.WORLD.fetch('https://copilot-world/announce', {
    method: 'POST', headers: { 'content-type': 'application/json', [RACE_ADMIN_HEADER]: env.RACE_ADMIN_TOKEN }, body: JSON.stringify({ t: 'record', ...rec }),
  }).catch(err => console.warn('announce', err?.message));
  if (waitUntil) waitUntil(job);
}

export async function handleRaceApi(req, env, { now = Date.now(), waitUntil = null } = {}) {
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
    // Every post that parses counts toward the address's budget, valid or not, so guessing the checks is slow.
    const ip = req.headers.get('cf-connecting-ip') || '?';
    const k = await ipKey(ip), windowMs = RACE_RATE_SEC * 1000;
    const raw = await kv.get(k, 'json');
    const w = raw && typeof raw === 'object' ? raw : raw ? { t: Number(raw), n: 1 } : null; // before the budget the key held a bare timestamp
    const open = w && now - w.t < windowMs ? w : null;
    if (open && open.n >= RACE_RATE_BURST) {
      const wait = Math.max(1, Math.ceil((open.t + windowMs - now) / 1000));
      return json({ error: 'rate', retryAfter: Math.min(wait, RACE_RATE_SEC) }, 429, origin, { 'retry-after': String(Math.min(wait, RACE_RATE_SEC)) });
    }
    await kv.put(k, JSON.stringify(open ? { t: open.t, n: open.n + 1 } : { t: now, n: 1 }), { expirationTtl: Math.max(60, RACE_RATE_SEC) }); // KV won't take a TTL under 60 s; the window is checked above
    const p = parseTime(r.body);
    if (!p.ok) {
      // Rejections are rare and the message to the player is short: keep the detail in the log for a tail
      console.log('race reject', JSON.stringify({ error: p.error, why: p.why ?? null, segment: p.segment ?? null, ms: r.body?.ms, splits: r.body?.splits, trace: Array.isArray(r.body?.trace) ? r.body.trace.length : null, name: r.body?.name }));
      return json({ error: p.error, ...(p.segment != null ? { segment: p.segment } : {}) }, 400, origin);
    }
    if (ip !== '?') { // stored on the row, never sent out
      p.entry.ak = await hashHex(`race:board:${ip}`); // the address (rows from before tokens carry this very hash as ipk)
      p.entry.ipk = p.entry.device ? await hashHex(`race:board:${ip}:${p.entry.device}`) : p.entry.ak; // the player: address and device
    }
    const { rank, best, rows, error } = await addTime(kv, p.entry, now);
    if (error) { // the address already holds its five rows and this would be a sixth
      console.log('race reject', JSON.stringify({ error, ms: p.entry.ms, name: p.entry.name }));
      return json({ error }, 409, origin);
    }
    if (rank === 1 && best) announceRecord(env, { track: p.entry.track, name: p.entry.name, ms: p.entry.ms }, waitUntil);
    await countEvent(kv, p.entry.track, 'post', ip, now);
    return json({ ok: true, rank, best, top: pub(rows) }, 200, origin);
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
