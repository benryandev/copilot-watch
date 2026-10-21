// Strike public reads (no key, no auth). Every function takes a final {fetch} option (tests inject a fake).
import { strikeGet } from './http.js';

const F = Number;
const q = encodeURIComponent;

/** GET /v2/markets → the `markets` object keyed by symbol ({} on failure). */
export async function markets({ fetch } = {}) { return (await strikeGet('/v2/markets', { fetch })).markets || {}; }

/** addr1 → main account and its active sub-accounts, or null. */
export async function accountByAddress(addr1, { fetch } = {}) {
  const r = await strikeGet(`/v2/account?blockchain_address=${q(addr1)}`, { fetch });
  if (!r.account_id) return null;
  return { accountId: r.account_id, nickname: r.nickname || null, subs: (r.sub_accounts || []).map(s => ({ id: s.account_id, name: s.name })) };
}

/** Nickname (with or without @) → {accountId} of the main account, or null. */
export async function accountByNickname(n, { fetch } = {}) {
  const r = await strikeGet(`/v2/account/by-nickname?nickname=${q(n.replace(/^@/, ''))}`, { fetch });
  return r.account_id ? { accountId: r.account_id, nickname: r.nickname || null } : null;
}

/** Account UUID (main or sub) → its details, or null. Sub-account names are public. */
export async function accountById(id, { fetch } = {}) {
  const r = await strikeGet(`/v2/account?account_id=${q(id)}`, { fetch });
  if (!r.account_id) return null;
  const isSub = !!r.parent_account_id;
  return { accountId: r.account_id, name: r.name || null, nickname: r.nickname || null, parentId: r.parent_account_id || null,
    parentAddress: r.parent_blockchain_address || null, isSub, subs: isSub ? [] : (r.sub_accounts || []).map(s => ({ id: s.account_id, name: s.name })) };
}

/** Copy leaderboard rows for one status: [{followerId, followerAddress, leadId, mode, amount, status, createdAt}]. Strike caches it ~10 minutes. */
export async function leaderboard({ status = 'active', fetch } = {}) {
  const r = await strikeGet(`/v2/copy/leaderboard?status=${q(status)}&limit=500`, { fetch });
  return (r.entries || []).map(e => ({
    followerId: e.follower?.account_id || null, followerAddress: e.follower?.address || null, leadId: (e.lead_account_id || '').toLowerCase(),
    platform: e.platform || 'hyperliquid', mode: e.copy_mode === 'fixed_ratio' ? 'fixed ratio' : 'fixed margin',
    amount: e.copy_mode === 'fixed_ratio' ? F(e.copy_amount || 0) : F(e.margin_per_entry_order || 0),
    status: e.status, createdAt: e.created_at || 0 }));
}

/** Mark prices for every market: {sym: mark}. */
export async function premiumIndex({ fetch } = {}) {
  const r = await strikeGet('/price/v2/premiumIndex', { fetch });
  return Object.fromEntries((Array.isArray(r) ? r : []).map(x => [x.symbol, F(x.markPrice)]));
}

/**
 * Copied positions with mark and liquidation price: [{subId, leadId, market, side, size, leverage, marginMode, entry, mark, liq, pnl}].
 * Falls back to /v2/positions + premiumIndex (subId and leadId null) if the copy route needs auth again.
 * Returns null when Strike can't be read at all (callers must not treat that as "no positions").
 */
export async function copyPositions(accountId, { fetch, tries } = {}) {
  const r = await strikeGet(`/v2/copy/positions?account_id=${q(accountId)}`, { fetch, tries });
  if (Array.isArray(r.positions)) return r.positions.map(p => ({
    subId: p.subscription_id || null, leadId: (p.lead_account_id || '').toLowerCase() || null, market: p.market, side: p.side,
    size: Math.abs(F(p.size)), leverage: F(p.leverage), marginMode: p.margin_mode, entry: F(p.entry_price), mark: F(p.mark_price),
    liq: F(p.liquidation_price) || null, pnl: F(p.pnl || 0), own: !!p.own }));
  const pos = await strikeGet(`/v2/positions?account_id=${q(accountId)}`, { fetch, tries });
  if (!Array.isArray(pos.positions)) return null;
  const marks = await premiumIndex({ fetch });
  return pos.positions.filter(p => F(p.size)).map(p => ({
    subId: null, leadId: null, market: p.symbol, side: F(p.size) > 0 ? 'long' : 'short', size: Math.abs(F(p.size)),
    leverage: F(p.leverage), marginMode: p.margin_mode, entry: F(p.entry_price), mark: marks[p.symbol] ?? null,
    liq: F(p.liquidation_price) || null, pnl: F(p.upnl || 0), own: null }));
}

const tagSub = cid => (cid || '').startsWith('copy:') ? cid.split(':')[1] || null : null;

/** Newest fills first: [{id, symbol, side, size, price, ts, pnl, copySubId|null, autoClose|null}]. null if Strike can't be read. */
export async function fills(accountId, { limit = 200, fetch, tries } = {}) {
  const r = await strikeGet(`/v2/history/fill?account_id=${q(accountId)}&limit=${limit}`, { fetch, tries });
  if (!Array.isArray(r.fills)) return null;
  return r.fills.map(f => ({ id: String(f.id), symbol: f.symbol, side: f.side, size: F(f.size), price: F(f.price), ts: f.timestamp,
    pnl: F(f.realized_pnl || 0), copySubId: tagSub(f.client_order_id), autoClose: f.auto_close_type || null }));
}
