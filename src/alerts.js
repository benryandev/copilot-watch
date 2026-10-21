// Pure alert detectors over (previous, current) public snapshots of one Strike account. No I/O.
//
// Snapshot = { accountId, label, at, since,           // since = when the baseline was first stored
//   copies: [{subId, leadId, market, side, mark, liq}] | null,   // null = Strike unreadable this round
//   subs: {leadId: {status, mode, amount}},
//   fills: [{id, symbol, ts, copySubId, autoClose, pnl}] | null,
//   orphans: [key] }                                   // orphan keys seen this round (an alert needs two rounds in a row)
// leads = {leadAddr: null | {ch: {main, xyz}, fills: [{coin, dir, time, oid, liquidation}], withdrawn24h, accountValue}}
//   null = Hyperliquid didn't answer this round: never read as "the lead holds nothing".
import { A } from './text.js';
import { hlMap, isOffHours } from '../core/markets.js';

export const COOL = { A1: 6 * 3600, default: 24 * 3600 };
const MIN = 60_000;
const ymd = t => new Date(t).toISOString().slice(0, 10);

function leadSize(lead, coin) {
  let s = 0;
  for (const d of ['main', 'xyz']) for (const p of lead.ch?.[d]?.positions || []) if (p.coin === coin) s += p.szi;
  return s;
}
const isLiqFill = (f, addr) => !!f.liquidation && (!f.liquidation.liquidatedUser || f.liquidation.liquidatedUser.toLowerCase() === addr);
const opens = f => /^Open |>/.test(f.dir || '');
const openSide = f => (/Long$/.test(f.dir) ? 'long' : 'short');

/** Orphan keys for this round (used for the two-rounds-in-a-row rule). */
export function findOrphans(cur, leads, mk) {
  const out = [];
  for (const c of cur.copies || []) {
    if (!c.leadId) continue;
    const lead = leads[c.leadId];
    if (!lead) continue; // missing or null: skip, never infer "flat"
    const coin = mk[c.market]?.hl; if (!coin) continue;
    const sz = leadSize(lead, coin);
    if (sz === 0 || (sz > 0) !== (c.side === 'long')) out.push(`${c.subId || c.leadId}:${c.market}:${c.side}`);
  }
  return out;
}

/**
 * @param {object} prev previous snapshot (baseline) of this account
 * @param {object} cur current snapshot
 * @param {{liq: number}} settings this chat's settings
 * @param {{leads: object, mk: object, now: number}} ctx
 * @returns {{key: string, kind: string, accountId: string, text: string, ttl: number}[]}
 */
export function detectAlerts(prev, cur, settings, { leads = {}, mk = {}, now = Date.now() } = {}) {
  const out = []; const label = cur.label; const add = (kind, key, text) => out.push({ kind, key: `${kind}:${key}`, accountId: cur.accountId, text, ttl: COOL[kind] || COOL.default });
  if (!prev) return out; // first poll: baseline only
  const since = prev.since ?? prev.at;
  const thr = Math.min(20, Math.max(1, Number(settings?.liq) || 5)) / 100;

  // A1: copy near liquidation (settings %, then again at 2%)
  for (const c of cur.copies || []) {
    if (!c.liq || !c.mark) continue;
    const dist = Math.max(0, (c.side === 'long' ? c.mark - c.liq : c.liq - c.mark) / c.mark);
    const id = `${c.subId || c.leadId || 'own'}:${c.market}:${c.side}`;
    if (dist <= thr) add('A1', `${id}:${Math.round(thr * 100)}`, A.A1(label, c, dist * 100, isOffHours(mk, c.market)));
    if (dist <= 0.02 && thr > 0.02) add('A1', `${id}:2`, A.A1(label, c, dist * 100, isOffHours(mk, c.market)));
  }

  // A2: orphaned copy, only when seen in two polls in a row (a close the copy is still following doesn't count)
  const prevOrphans = new Set(prev.orphans || []);
  for (const c of cur.copies || []) {
    if (!c.leadId) continue;
    const lead = leads[c.leadId]; if (!lead) continue;
    const coin = mk[c.market]?.hl; if (!coin) continue;
    const k = `${c.subId || c.leadId}:${c.market}:${c.side}`;
    if (!(cur.orphans || []).includes(k) || !prevOrphans.has(k)) continue;
    const last = (lead.fills || []).filter(f => f.coin === coin).at(-1);
    if (last && isLiqFill(last, c.leadId)) { add('A2', k, A.A2liq(label, c)); continue; }
    const sz = leadSize(lead, coin);
    add('A2', k, A.A2(label, c, sz === 0 ? `no longer holds ${coin.replace('xyz:', '')}` : `is now ${sz > 0 ? 'long' : 'short'} instead`));
  }

  // A3: a lead open/add on a Strike market with no copy fill within 10 minutes
  const to = hlMap(mk);
  const copyFills = (cur.fills || []).filter(f => f.copySubId);
  if (cur.fills) for (const [leadId, sub] of Object.entries(cur.subs || {})) {
    if (sub.status !== 'active') continue;
    const lead = leads[leadId]; if (!lead) continue;
    const subIds = new Set((cur.copies || []).filter(c => c.leadId === leadId && c.subId).map(c => c.subId));
    const seen = new Set();
    for (const f of lead.fills || []) {
      const sym = to[f.coin];
      if (!sym || !opens(f) || seen.has(f.oid)) continue;
      if (f.time <= since || f.time < (sub.since || 0) || now - f.time < 10 * MIN) continue;
      seen.add(f.oid);
      const hit = copyFills.some(x => x.symbol === sym && x.ts >= f.time - MIN && x.ts <= f.time + 10 * MIN && (!subIds.size || subIds.has(x.copySubId)));
      if (!hit) add('A3', `${leadId}:${f.oid}`, A.A3(label, leadId, sym, openSide(f)));
    }
  }

  // A4: lead using >= 90% of margin on either dex
  for (const leadId of Object.keys(cur.subs || {})) {
    const lead = leads[leadId]; if (!lead) continue;
    for (const dex of ['main', 'xyz']) {
      const d = lead.ch?.[dex];
      if (d && d.accountValue > 0 && d.marginUsed / d.accountValue >= 0.9) add('A4', `${leadId}:${dex}:${ymd(now)}`, A.A4(leadId, dex, d.marginUsed / d.accountValue));
    }
    // A5: more than half the perp account withdrawn in 24 h
    const before = (lead.accountValue || 0) + (lead.withdrawn24h || 0);
    if (lead.withdrawn24h > 0 && before > 0 && lead.withdrawn24h > 0.5 * before) add('A5', `${leadId}:${ymd(now)}`, A.A5(leadId, lead.withdrawn24h, before));
  }

  // A6: copy closed by liquidation or ADL (new fills only), or subscription ended
  if (cur.fills) {
    const prevIds = new Set((prev.fills || []).map(f => f.id));
    const done = new Set();
    for (const f of cur.fills) {
      const kind = f.autoClose === 'liquidation' || f.autoClose === 'adl' ? f.autoClose : null;
      if (!kind || prevIds.has(f.id) || f.ts <= since) continue;
      const k = `${f.symbol}:${Math.floor(f.ts / MIN)}`; if (done.has(k)) continue; done.add(k);
      const pnl = cur.fills.filter(x => x.symbol === f.symbol && x.autoClose === f.autoClose && Math.abs(x.ts - f.ts) < MIN).reduce((s, x) => s + (x.pnl || 0), 0);
      add('A6', k, A.A6fill(label, { ...f, pnl }, kind));
    }
  }
  for (const [leadId, sub] of Object.entries(cur.subs || {})) {
    const was = prev.subs?.[leadId]?.status;
    if (was === 'active' && (sub.status === 'liquidated' || sub.status === 'stopped')) add('A6', `sub:${leadId}:${sub.status}:${ymd(now)}`, A.A6sub(label, leadId, sub.status));
  }
  return out;
}
