// Paper Copy trials: settings + a start time, stored in KV for 30 days. Whoever views a trial replays the lead's real
// fills from the start with core/replay.js; nothing runs in the background except the optional daily bot summary.

export const PAGE = 'https://strike.benryan.com.au/paper/';
export const ORIGINS = ['https://strike.benryan.com.au', 'http://localhost:8080'];
export const TTL = 30 * 86400, BACKDATE_DAYS = 14, MAX_TRIALS = 500, MAX_PER_CHAT = 3;
const DAY = 86_400_000;
const ID = /^[A-Za-z0-9_-]{22}$/;

export function newId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

/** Validate a trial request. Returns {ok, trial} or {ok: false, error}. */
export function parseTrial(body, now = Date.now()) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad_json' };
  const lead = String(body.lead || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lead)) return { ok: false, error: 'bad_wallet' };
  const s = body.settings || {};
  const mode = s.mode === 'fr' ? 'fr' : s.mode === 'fm' ? 'fm' : null;
  const amount = mode === 'fm' ? num(s.amount, 1, 100_000) : num(s.amount, 10, 1_000_000);
  const lev = num(s.lev, 1, 20), cap = num(s.cap ?? 0, 0, 1e7), tcap = num(s.tcap ?? 0, 0, 1e7);
  const start = num(s.start ?? 1000, 10, 1_000_000); // paper account size
  const marginMode = s.marginMode === 'cross' ? 'cross' : s.marginMode === 'isolated' || s.marginMode == null ? 'isolated' : null;
  const ex = Array.isArray(s.excluded) ? s.excluded : [];
  if (!mode || amount == null || lev == null || !Number.isInteger(lev) || cap == null || tcap == null || start == null || !marginMode
    || ex.length > 40 || !ex.every(x => typeof x === 'string' && /^[A-Z0-9]{1,15}-USD$/.test(x))) return { ok: false, error: 'bad_settings' };
  const back = num(body.backdate ?? BACKDATE_DAYS, 0, 30);
  if (back == null) return { ok: false, error: 'bad_settings' };
  return { ok: true, trial: { lead, settings: { mode, amount, lev, marginMode, cap, tcap, excluded: [...new Set(ex)], start },
    from: now - Math.round(back) * DAY, createdAt: now, expiresAt: now + TTL * 1000 } };
}

export async function countTrials(kv) {
  let n = 0, cursor;
  do { const r = await kv.list({ prefix: 'paper:', cursor }); n += r.keys.length; cursor = r.list_complete ? undefined : r.cursor; } while (cursor);
  return n;
}

/** Store a validated trial. Returns {id, url} or {error: 'full'}. */
export async function createTrial(kv, trial, { chat = null } = {}) {
  if (await countTrials(kv) >= MAX_TRIALS) return { error: 'full' };
  const id = newId();
  await kv.put(`paper:${id}`, JSON.stringify({ id, ...trial, chat }), { expirationTtl: TTL });
  return { id, url: PAGE + id };
}

export async function getTrial(kv, id) {
  if (!ID.test(id || '')) return null;
  return kv.get(`paper:${id}`, 'json');
}

const cors = origin => (ORIGINS.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' } : { vary: 'Origin' });
const json = (v, status, origin) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(origin) } });

/** Routes under /api/paper. */
export async function handlePaperApi(req, env, { now = Date.now(), limiter = env.CMD_LIMITER } = {}) {
  const origin = req.headers.get('origin') || '';
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: ORIGINS.includes(origin) ? 204 : 403, headers: cors(origin) });
  if (req.method === 'POST' && url.pathname === '/api/paper') {
    if (!ORIGINS.includes(origin)) return json({ error: 'origin' }, 403, origin);
    if (limiter && !(await limiter.limit({ key: `ip:${req.headers.get('cf-connecting-ip') || '?'}` })).success) return json({ error: 'rate' }, 429, origin);
    const text = await req.text();
    if (text.length > 4000) return json({ error: 'too_large' }, 413, origin);
    let body; try { body = JSON.parse(text); } catch { return json({ error: 'bad_json' }, 400, origin); }
    const p = parseTrial(body, now);
    if (!p.ok) return json({ error: p.error }, 400, origin);
    const r = await createTrial(env.KV, p.trial);
    return r.error ? json({ error: r.error }, 503, origin) : json(r, 201, origin);
  }
  const m = url.pathname.match(/^\/api\/paper\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    const t = await getTrial(env.KV, m[1]);
    if (!t) return json({ error: 'not_found' }, 404, origin);
    const { chat, ...pub } = t; // the chat link stays private
    return json(pub, 200, origin);
  }
  return json({ error: 'not_found' }, 404, origin);
}
