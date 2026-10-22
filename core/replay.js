// Replay a lead as a Strike copier would have copied them. Line-for-line port of Strike Copilot scripts/replay.py
// (parity-tested against it: test/replay-parity.test.js). Rules, as in Copilot:
// - Only lead orders on markets Strike lists are copied. Closes take the same fraction off the copy as the lead took off
//   their position (the lead position is resynced from each order's startPosition).
// - Fixed ratio: copy = lead order x (amount / lead equity then), capped at 100%. Fixed margin: one entry of `margin` at `lev`
//   per opening or increasing lead order.
// - An open is skipped when it is excluded, below the market minimum, over a cap, or short of free margin (in that order).
// - Taker fee per side; closes land SLIP (10 bp) worse. Open copies are marked at 1h candle closes between orders.
// - Liquidation: each candle's low (longs) or high (shorts) against Strike's maintenance margin tier. Isolated: the copy's
//   margin is lost. Cross: every copy closes when equity at the worst price falls to the summed maintenance.
// - Funding (optional `funding`): Strike's hourly rates per market, settled on the copy's size at each hourly mark; longs
//   pay a positive rate, shorts receive it. Isolated funding comes out of (or into) the position's margin.
// Not modelled: Strike's liquidation fee. Parity with Copilot holds with funding off (Copilot has none).
import { tier, hlMap } from './markets.js';
import * as hl from './hl.js';
import { fundingHistory } from './strike.js';

export const SLIP = 0.0010;
export const DAY = 86_400_000;
const F = Number;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const day = t => new Date(t).toISOString().slice(0, 10);

/**
 * Lead fills -> orders on Strike symbols, grouped by (symbol, oid) in first-seen order, sorted by time (stable).
 * @param {object[]} fills Hyperliquid fills sorted by (time, tid)
 * @returns {{c: string, t: number, q: number, n: number, sp: number}[]} q signed size, n notional, sp lead position before
 */
export function hlToOrders(fills, mk) {
  const toSym = hlMap(mk); const orders = new Map();
  for (const f of fills) {
    const sym = toSym[f.coin];
    if (!sym) continue;
    const key = `${sym}\0${f.oid}`;
    let o = orders.get(key);
    if (!o) orders.set(key, o = { c: sym, t: f.time, q: 0, n: 0, sp: F(f.startPosition) });
    o.q += F(f.sz) * (f.side === 'B' ? 1 : -1); o.n += F(f.sz) * F(f.px);
  }
  return [...orders.values()].sort((a, b) => a.t - b.t);
}

/** Account value history [[t, v]] -> (t => last value at or before t, else the first; 0 when there is no history). */
export function equityFn(history) {
  const h = (history || []).map(([t, v]) => [Math.trunc(F(t)), F(v)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return t => {
    if (!h.length) return 0;
    let lo = 0, hi = h.length;  // bisect_right
    while (lo < hi) { const mid = (lo + hi) >> 1; if (t < h[mid][0]) hi = mid; else lo = mid + 1; }
    return h[Math.max(lo - 1, 0)][1];
  };
}

/** Fixed margin: every opening or increasing lead order is one entry of `margin` at `lev`. Returns (q, px, t) => copy size. */
export const fmSize = (margin, lev) => (q, px) => (q > 0 ? 1 : -1) * margin * lev / px;

/**
 * Fixed ratio: lead order x (amount / lead equity) x mult, capped at 100% of the lead's order; entries below
 * `minEntry` trade value are raised to it. `equity` is t => lead equity (equityFn).
 */
export const frSize = (amount, equity, mult = 1, minEntry = 0) => (q, px, t) => {
  const eq = equity(t);
  if (eq <= 0) return 0;
  let s = q * Math.min(amount * mult / eq, 1);
  if (minEntry && 0 < Math.abs(s) * px && Math.abs(s) * px < minEntry) s = (s > 0 ? 1 : -1) * minEntry / px;
  return s;
};

/**
 * Run one copy setting over a lead's orders and 1h marks.
 * @param {object} a
 * @param {{c, t, q, n, sp}[]} a.orders from hlToOrders
 * @param {[number, string, number, number, number][]} a.marks [T, symbol, close, low, high]
 * @param {number} a.start account size (USD)
 * @param {(q: number, px: number, t: number) => number} a.size fmSize or frSize
 * @param {number} a.lev leverage setting; a market's own max caps the margin posted
 * @param {number} a.fee taker fee per side (0.0005 = 0.05%)
 * @param {number} [a.cap] max margin per symbol (0 = none)
 * @param {number} [a.tcap] max total margin (0 = none)
 * @param {Set<string>} [a.excluded] Strike symbols not copied
 * @param {'isolated'|'cross'} [a.marginMode]
 * @param {Record<string, [number, number][]>|null} [a.funding] Strike symbol -> sorted [ms, hourly rate]; null = no funding
 * @param {object[]|null} [a.log] if given, every copy event is pushed here: {t, sym, kind: 'open'|'add'|'close'|'skip'|'liq', why?, px, q?, pnl?}
 */
export function replay({ orders, marks, start, size, lev, fee, cap = 0, tcap = 0, excluded = new Set(), mk, marginMode = 'isolated', funding = null, log = null }) {
  // Plain objects keyed by Strike symbol keep insertion order, like Copilot's defaultdicts; `g` is a defaultdict read.
  const lp = {}, cq = {}, ce = {}, mg = {}, lots = {}, symPk = {}, last = {}, n = {};
  const g = (o, k) => (k in o ? o[k] : (o[k] = 0));
  let cash = start, pk = start, dd = 0, low = start, usedPk = 0, realised = 0, fees = 0, vol = 0, wiped = null;
  let entriesPk = 0, liqLoss = 0, paid = 0; const liqs = [], fi = {};
  const ev = orders.map(o => [o.t, 1, o]).concat(marks.map(m => [m[0], 0, m])).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const live = () => Object.keys(cq).filter(k => cq[k]);
  const eqf = () => { let s = 0; for (const k of live()) s += cq[k] * (last[k] - ce[k]); return cash + s; };
  const usedf = () => { let s = 0; for (const k of live()) s += Math.abs(cq[k]) * last[k] / lev; return s; };
  const levc = c => Math.min(lev, tier(mk[c], 0)[0]);  // the market's max leverage caps the setting
  const maint = (c, px) => tier(mk[c], Math.abs(cq[c]) * px)[1];

  const liquidate = (c, px, t) => {
    const pnl = marginMode === 'isolated' ? -mg[c] : cq[c] * (px - ce[c]);
    cash += pnl; realised += pnl; liqLoss -= pnl; liqs.push([c, day(t), Math.round(-pnl)]);
    log?.push({ t, sym: c, kind: 'liq', px, pnl });
    cq[c] = 0; mg[c] = 0; lots[c] = 0;
  };

  const tryOpen = (c, add, px, t) => {
    if (!add) return false;
    const m = k => Math.abs(g(cq, k)) * g(ce, k) / lev;
    const need = Math.abs(add) * px / lev;
    let why = null;
    if (excluded.has(c)) why = 'excluded';
    else if (Math.abs(add) * px < mk[c].minNotional) why = 'tiny';
    else if ((cap && m(c) + need > cap) || (tcap && live().reduce((s, k) => s + m(k), 0) + need > tcap)) why = 'capped';
    else if (eqf() - usedf() < need) why = 'no_margin';
    if (why) { n[why] = (n[why] || 0) + 1; log?.push({ t, sym: c, kind: 'skip', why, px, q: add }); return false; }
    const wasOpen = !!g(cq, c);
    ce[c] = g(cq, c) + add ? (g(ce, c) * cq[c] + add * px) / (cq[c] + add) : px;
    cq[c] += add; mg[c] = g(mg, c) + Math.abs(add) * px / levc(c);
    cash -= Math.abs(add) * px * fee; fees += Math.abs(add) * px * fee; vol += Math.abs(add) * px;
    n.taken = (n.taken || 0) + 1; lots[c] = g(lots, c) + 1;
    log?.push({ t, sym: c, kind: wasOpen ? 'add' : 'open', px, q: add });
    return true;
  };

  for (const [t, kind, o] of ev) {
    if (wiped) break;
    let c;
    if (kind === 0) {
      const [, sym, p, lo, hi] = o; c = sym;
      const fr = funding?.[c];
      if (fr) {  // settle every funding hour up to this mark (hours before the copy opened pass with nothing held)
        let i = fi[c] || 0;
        for (; i < fr.length && fr[i][0] <= t; i++) if (g(cq, c)) {
          const pay = -cq[c] * p * fr[i][1];
          cash += pay; realised += pay; paid += pay; if (marginMode === 'isolated') mg[c] += pay;
        }
        fi[c] = i;
      }
      if (g(cq, c)) {
        const worst = cq[c] > 0 ? lo : hi;
        if (marginMode === 'isolated') {
          if (g(mg, c) + cq[c] * (worst - ce[c]) <= maint(c, worst)) liquidate(c, worst, t);
        } else {
          const px = Object.fromEntries(live().map(k => [k, k === c ? worst : last[k]]));
          let e = 0, mm = 0;
          for (const k in px) e += cq[k] * (px[k] - ce[k]);
          for (const k in px) mm += maint(k, px[k]);
          if (cash + e <= mm) for (const k in px) liquidate(k, px[k], t);
        }
        if (cq[c]) last[c] = p;
      }
    } else {
      c = o.c; const q = o.q;
      if (!q) continue;
      const px = o.n / Math.abs(q); last[c] = px; lp[c] = o.sp;
      if (lp[c] === 0 || lp[c] * q > 0) {  // open or add
        tryOpen(c, size(q, px, t), px, t); lp[c] += q;
      } else {  // reduce / close / flip: close the same fraction of the copy
        const frac = Math.min(Math.abs(q) / Math.abs(lp[c]), 1);
        if (g(cq, c)) {
          const side = cq[c] > 0 ? 1 : -1, cl = cq[c] * frac, xp = px * (1 - SLIP * side);
          const pnl = cl * (xp - ce[c]) - Math.abs(cl) * xp * fee;
          cash += pnl; realised += pnl; fees += Math.abs(cl) * xp * fee; vol += Math.abs(cl) * xp; cq[c] -= cl; mg[c] = g(mg, c) * (1 - frac);
          log?.push({ t, sym: c, kind: 'close', px: xp, q: -cl, pnl });
        }
        const rem = Math.abs(q) > Math.abs(lp[c]) ? q + lp[c] : 0;
        lp[c] = !rem ? lp[c] + q : 0;
        if (Math.abs(lp[c]) < 1e-12) { lp[c] = 0; cq[c] = 0; lots[c] = 0; mg[c] = 0; }
        if (rem) {
          cq[c] = 0; lots[c] = 0; mg[c] = 0;
          tryOpen(c, size(rem, px, t), px, t); lp[c] = rem;
        }
      }
    }
    if (cq[c]) symPk[c] = Math.max(symPk[c] || 0, Math.abs(cq[c]) * ce[c] / lev);
    let ent = 0; for (const k in lots) if (cq[k]) ent += lots[k];
    entriesPk = Math.max(entriesPk, ent);
    const eq = eqf(); usedPk = Math.max(usedPk, usedf()); pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); low = Math.min(low, eq);
    if (eq <= 0) wiped = day(t);
  }
  const eq = eqf();
  const { taken = 0, ...skipped } = n;
  return {
    net: eq - start, realised, open: eq - start - realised, dd, ddPct: start ? dd / start : 0, low,
    peakMargin: usedPk, peakEntries: entriesPk, symPk, fees, funding: paid, volume: vol, wiped, taken, skipped, lev, marginMode,
    liquidations: liqs.length, liqLoss, liqList: liqs,
    openNow: Object.fromEntries(live().map(k => [k, Math.round(cq[k] * last[k])])),
  };
}

/**
 * Fetch everything needed to replay one Hyperliquid wallet over the last `days`, within a budget: at most `maxPages`
 * fill pages (2,000 each) and 1h candles for the `maxCoins` most-traded symbols (by notional). Calls are sequential.
 * Funding comes from Strike (`funding: false` skips it).
 * @returns {Promise<{orders, marks, funding: Record<string, [number, number][]>, equityHistory: number[][], fills: {coin, time, closedPnl}[], nfills: number, truncated: boolean, unmarked: string[], t0: number, now: number}>}
 */
export async function fetchLead(addr, days, mk, { fetch, onProgress = null, maxPages = 10, maxCoins = 12, now = Date.now(), pause = 250, funding = true, fundingCache = null } = {}) {
  const user = addr.toLowerCase(); const t0 = now - Math.trunc(days * DAY);
  const fills = await hl.fillsByTime(user, t0, now, { maxPages, fetch, pause, onPage: (page, pages) => onProgress?.({ step: 'fills', page, pages }) });
  const orders = hlToOrders(fills, mk);
  const traded = {};
  for (const o of orders) traded[o.c] = (traded[o.c] || 0) + o.n;
  const ranked = Object.keys(traded).sort((a, b) => traded[b] - traded[a] || (a < b ? -1 : 1));
  const keep = ranked.slice(0, maxCoins).sort(), unmarked = ranked.slice(maxCoins).sort();
  const marks = [];
  for (const [i, s] of keep.entries()) {
    if (pause) await sleep(pause);
    onProgress?.({ step: 'candles', page: i + 1, pages: keep.length, sym: s });
    for (const k of await hl.candles(mk[s].hl, t0, now, { fetch })) marks.push([k.T, s, k.c, k.l, k.h]);
  }
  // Strike's hourly funding for the same markets (one public call each; a shared cache serves many trials in one run).
  const fund = {};
  if (funding && keep.length) {
    onProgress?.({ step: 'funding', page: 1, pages: 1 });
    const get = s => { if (!fundingCache) return fundingHistory(s, { fetch }); if (!fundingCache.has(s)) fundingCache.set(s, fundingHistory(s, { fetch })); return fundingCache.get(s); };
    const rows = await Promise.all(keep.map(get));
    keep.forEach((s, i) => { if (rows[i].length) fund[s] = rows[i].filter(r => r[0] >= t0 - 3_600_000); });
  }
  let equityHistory = [];
  if (orders.length) {
    if (pause) await sleep(pause);
    onProgress?.({ step: 'equity', page: 1, pages: 1 });
    equityHistory = (await hl.portfolioHistory(user, { fetch })).accountValue;
  }
  // Slim fills (every coin, listed or not) for realised P&L by coin.
  const slim = fills.map(f => ({ coin: f.coin, time: f.time, closedPnl: F(f.closedPnl || 0) }));
  return { orders, marks, funding: fund, equityHistory, fills: slim, nfills: fills.length, truncated: fills.truncated, unmarked, t0, now };
}
