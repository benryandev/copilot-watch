// Score boards for the arcade cabinets in the Copilot Check ecosystem world (first: Flappy Coin by IBuyTheTop, 1 Nov 2026).
//   arcade:top:<game>  [{id, name, key, ipk, ak, score, level, won, ms, at}] by score desc then earlier first; at most 100, one per
//                      name (key = lower case) and one per player (ipk: a hash of the poster's address and device token, or of
//                      the address alone when the page sent no token), at most ARCADE_ADDR_ROWS per address (ak: a hash of the
//                      address; rows from before tokens have no ak and carry that same hash as ipk). Hashes are never sent out.
//   arcade:ip:<hash>   {t, n}: posts from one address in the window that began at t (ARCADE_RATE_BURST per ARCADE_RATE_SEC; the key
//                      lives 60 s, KV's minimum TTL). A key from before the budget holds a bare timestamp and reads as one post.
// A score is only a number, so the checks are about pace, not proof: the game hands over the run's play time and its level, and
// a post has to be consistent with the game's own rules (points per second, time per level, points per level). Anything that
// slips through can be removed by id or name with the race admin header, as on the race board.
import { RACE_ORIGINS, RACE_ADMIN_HEADER, cleanName, cors, json, readJson, hashHex, isAdmin, parseDevice } from './race.js';
import { safeEqual } from './telegram.js';
import { newId } from './paper.js';

/** Known cabinets. scoreMax: the most the game can pay out in a full clear; levelMax: its last level; maxMs: longest run kept. */
export const ARCADE_GAMES = {
  // Flappy Coin: 10 points a candle (84 candles in a clear), +10 a mine and +5 a ship shot; 10 levels of 8 candles (12 on the last)
  'flappy-coin': { scoreMax: 2600, levelMax: 10, maxMs: 30 * 60_000 },
};
export const ARCADE_PTS_PER_SEC = 40; // the most the game can pay out in a second (candles, mines and ships together, at level 10 pace)
export const ARCADE_LEVEL_MS = 6000; // a level is eight candles; at the game's fastest pace they take longer than this
export const ARCADE_LEVEL_PTS = 80; // reaching level L means 8 × (L − 1) candles passed, 10 points each
export const ARCADE_RATE_SEC = 10, ARCADE_KEEP = 100, ARCADE_SHOW = 10;
/** People who share one public address (an office on one wifi, as on the race board, 4 Nov 2026): each device gets its own row, up
 * to this many rows per address, and the post limit is a budget of this many per address per ARCADE_RATE_SEC rather than one. The
 * budget stays per address, not per device: a token is free to mint. */
export const ARCADE_ADDR_ROWS = 5, ARCADE_RATE_BURST = 5;

/** Validate a posted run. Returns {ok, entry: {game, name, key, score, level, won, ms, device}} or {ok: false, error}.
 *  device is the page's device token, lower case, or null when it sent none or a malformed one. */
export function parseScore(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'bad_json' };
  const g = typeof body.game === 'string' && Object.hasOwn(ARCADE_GAMES, body.game) ? ARCADE_GAMES[body.game] : null;
  if (!g) return { ok: false, error: 'unknown_game' };
  const n = cleanName(body.name);
  if (!n.ok) return n;
  const { score, level, won, ms } = body;
  if (!Number.isSafeInteger(score) || score <= 0 || score > g.scoreMax) return { ok: false, error: 'bad_score' };
  if (!Number.isSafeInteger(level) || level < 1 || level > g.levelMax) return { ok: false, error: 'bad_level' };
  if (typeof won !== 'boolean' || (won && level !== g.levelMax)) return { ok: false, error: 'bad_won' };
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms >= g.maxMs) return { ok: false, error: 'bad_ms' };
  if (score > (ms * ARCADE_PTS_PER_SEC) / 1000) return { ok: false, error: 'too_fast' };
  if (ms < (level - 1) * ARCADE_LEVEL_MS) return { ok: false, error: 'level_too_fast' };
  if (score < (level - 1) * ARCADE_LEVEL_PTS) return { ok: false, error: 'level_score' };
  return { ok: true, entry: { game: body.game, name: n.name, key: n.name.toLowerCase(), score, level, won, ms, device: parseDevice(body.device) } };
}

const boardKey = game => `arcade:top:${game}`;
const order = (a, b) => b.score - a.score || a.at - b.at;
const pub = rows => rows.slice(0, ARCADE_SHOW).map(({ name, score, level, won, at }) => ({ name, score, level, won, at }));
export const getBoard = async (kv, game) => (await kv.get(boardKey(game), 'json')) || [];

/** Add a validated run: one row per name and one per player (entry.ipk, a hash of the poster's address and device token), each
 *  keeping its best. A higher score under a new name from the same player replaces that player's row, name and all; a lower one
 *  changes nothing. One address (entry.ak) holds at most ARCADE_ADDR_ROWS rows, so clearing storage for a fresh token cannot refill
 *  the board from one connection: a post that would add a row past that is refused with error 'address_full', while a post that
 *  replaces a row the address already holds always goes through. Rows from before tokens carry the address hash as ipk and no ak.
 *  Returns {rank (1-based or null), best, rows, error?}. */
export async function addScore(kv, entry, now = Date.now()) {
  const rows = await getBoard(kv, entry.game);
  const same = r => r.key === entry.key || (entry.ipk && r.ipk === entry.ipk);
  const held = rows.filter(same).sort(order)[0];
  if (held && held.score >= entry.score) return { rank: rows.indexOf(held) + 1, best: false, rows };
  if (entry.ak) {
    const mine = rows.filter(r => (r.ak || r.ipk) === entry.ak);
    if (mine.length >= ARCADE_ADDR_ROWS && !mine.some(same)) return { rank: null, best: false, rows, error: 'address_full' };
  }
  const row = { id: newId(), name: entry.name, key: entry.key, ipk: entry.ipk || null, ak: entry.ak || null, score: entry.score, level: entry.level, won: entry.won, ms: entry.ms, at: now };
  const next = [...rows.filter(r => !same(r)), row].sort(order).slice(0, ARCADE_KEEP);
  const i = next.indexOf(row);
  if (i < 0) return { rank: held ? rows.indexOf(held) + 1 : null, best: false, rows };
  await kv.put(boardKey(entry.game), JSON.stringify(next));
  return { rank: i + 1, best: true, rows: next };
}

/** Remove rows by id or by name (case-insensitive, cleaned like a posted name). Returns the number removed. */
export async function removeScore(kv, game, { id, name } = {}) {
  const rows = await getBoard(kv, game);
  const c = typeof name === 'string' ? cleanName(name) : null;
  const key = c?.ok ? c.name.toLowerCase() : (typeof name === 'string' ? name.trim().toLowerCase() : null);
  const next = rows.filter(r => !((id && r.id === id) || (key && r.key === key)));
  if (next.length !== rows.length) await kv.put(boardKey(game), JSON.stringify(next));
  return rows.length - next.length;
}

const ipKey = async ip => 'arcade:ip:' + await hashHex(`arcade:${ip}`);

/** Routes under /arcade/. */
export async function handleArcadeApi(req, env, { now = Date.now() } = {}) {
  const origin = req.headers.get('origin') || '';
  const url = new URL(req.url), kv = env.KV;
  if (req.method === 'OPTIONS') return new Response(null, { status: RACE_ORIGINS.includes(origin) ? 204 : 403, headers: { ...cors(origin), 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS' } });

  if (req.method === 'GET' && url.pathname === '/arcade/top') {
    const game = url.searchParams.get('game') || '';
    if (!Object.hasOwn(ARCADE_GAMES, game)) return json({ error: 'unknown_game' }, 404, origin);
    const rows = await getBoard(kv, game);
    if (isAdmin(req, env)) return json({ game, all: rows.map(({ id, name, score, level, won, ms, at }) => ({ id, name, score, level, won, ms, at })) }, 200, origin);
    return json({ game, top: pub(rows) }, 200, origin);
  }

  if (req.method === 'POST' && url.pathname === '/arcade/score') {
    if (!RACE_ORIGINS.includes(origin)) return json({ error: 'origin' }, 403, origin);
    const r = await readJson(req);
    if (r.error) return json({ error: r.error }, r.status, origin);
    // Every post that parses counts toward the address's budget, valid or not, so guessing the checks is slow.
    const ip = req.headers.get('cf-connecting-ip') || '?';
    const k = await ipKey(ip), windowMs = ARCADE_RATE_SEC * 1000;
    const raw = await kv.get(k, 'json');
    const w = raw && typeof raw === 'object' ? raw : raw ? { t: Number(raw), n: 1 } : null; // before the budget the key held a bare timestamp
    const open = w && now - w.t < windowMs ? w : null;
    if (open && open.n >= ARCADE_RATE_BURST) {
      const wait = Math.min(ARCADE_RATE_SEC, Math.max(1, Math.ceil((open.t + windowMs - now) / 1000)));
      return json({ error: 'rate', retryAfter: wait }, 429, origin, { 'retry-after': String(wait) });
    }
    await kv.put(k, JSON.stringify(open ? { t: open.t, n: open.n + 1 } : { t: now, n: 1 }), { expirationTtl: Math.max(60, ARCADE_RATE_SEC) }); // KV won't take a TTL under 60 s; the window is checked above
    const p = parseScore(r.body);
    if (!p.ok) {
      console.log('arcade reject', JSON.stringify({ error: p.error, game: r.body?.game, score: r.body?.score, level: r.body?.level, ms: r.body?.ms, name: r.body?.name }));
      return json({ error: p.error }, 400, origin);
    }
    if (ip !== '?') { // stored on the row, never sent out
      p.entry.ak = await hashHex(`arcade:board:${ip}`); // the address (rows from before tokens carry this very hash as ipk)
      p.entry.ipk = p.entry.device ? await hashHex(`arcade:board:${ip}:${p.entry.device}`) : p.entry.ak; // the player: address and device
    }
    const { rank, best, rows, error } = await addScore(kv, p.entry, now);
    if (error) { // the address already holds its five rows and this would be a sixth
      console.log('arcade reject', JSON.stringify({ error, game: p.entry.game, score: p.entry.score, name: p.entry.name }));
      return json({ error }, 409, origin);
    }
    return json({ ok: true, rank, best, top: pub(rows) }, 200, origin);
  }

  if (req.method === 'DELETE' && url.pathname === '/arcade/score') {
    const token = env.RACE_ADMIN_TOKEN;
    if (!token) return json({ error: 'admin_disabled' }, 403, origin);
    const given = req.headers.get(RACE_ADMIN_HEADER);
    if (!given) return json({ error: 'unauthorized' }, 401, origin);
    if (!safeEqual(given, token)) return json({ error: 'forbidden' }, 403, origin);
    const r = await readJson(req);
    if (r.error) return json({ error: r.error }, r.status, origin);
    const b = r.body && typeof r.body === 'object' ? r.body : {};
    const q = k => (typeof b[k] === 'string' && b[k]) || url.searchParams.get(k) || '';
    const game = q('game'), id = q('id'), name = q('name');
    if (!Object.hasOwn(ARCADE_GAMES, game)) return json({ error: 'unknown_game' }, 400, origin);
    if (!id && !name) return json({ error: 'need_id_or_name' }, 400, origin);
    const removed = await removeScore(kv, game, { id: id || null, name: name || null });
    return json({ ok: removed > 0, removed }, removed ? 200 : 404, origin);
  }

  return json({ error: 'not_found' }, 404, origin);
}
