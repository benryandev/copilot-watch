// HTTP for the two public APIs. Hyperliquid throttles silently (null or non-JSON replies), so every call retries
// and a throttled reply is never returned as data.

export const STRIKE_API = 'https://api.strikefinance.org';
export const HL_API = 'https://api.hyperliquid.xyz/info';

export class HlBusyError extends Error {
  constructor(t) { super(`Hyperliquid did not answer ${t} (busy or rate-limited). Try again in a minute.`); this.name = 'HlBusyError'; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const parse = s => { try { return JSON.parse(s); } catch { return undefined; } };
const isType = (v, want) => want === Array ? Array.isArray(v) : want === Object ? !!v && typeof v === 'object' && !Array.isArray(v) : true;

/** POST to Hyperliquid /info. `want` (Array or Object) rejects replies of the wrong shape. Throws HlBusyError after the last wait. */
export async function hlInfo(body, { want = null, waits = [0, 2000, 5000, 10000], fetch = globalThis.fetch } = {}) {
  for (const w of waits) {
    if (w) await sleep(w);
    try {
      const r = await fetch(HL_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const v = parse(await r.text());
      if (v !== undefined && v !== null && (!want || isType(v, want))) return v;
    } catch { /* network error: retry */ }
  }
  throw new HlBusyError(body.type);
}

/** Public GET on Strike's API. Returns {} after repeated failures (callers treat {} as "no data"). */
export async function strikeGet(path, { fetch = globalThis.fetch, tries = 3, pause = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(STRIKE_API + path);
      if (r.status === 401 || r.status === 403 || r.status === 404) return { _status: r.status };
      const v = parse(await r.text());
      if (v && typeof v === 'object') return v;
    } catch { /* retry */ }
    if (pause) await sleep(pause * (i + 1));
  }
  return {};
}
