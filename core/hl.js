// Hyperliquid public reads. Every function takes a final {fetch} option (tests inject a fake).
import { hlInfo } from './http.js';

const F = Number;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Fills between t0 and t1 (ms), paged at 2,000, deduped on (tid, oid), sorted by (time, tid). Mirrors Copilot hl_fills. */
export async function fillsByTime(user, t0, t1, { maxPages = 10, onPage = null, pause = 300, fetch } = {}) {
  const seen = new Map(); let s = t0, truncated = false;
  for (let p = 0; p < maxPages; p++) {
    const r = await hlInfo({ type: 'userFillsByTime', user, startTime: s, endTime: t1, aggregateByTime: true }, { want: Array, fetch });
    for (const f of r) seen.set(`${f.tid}:${f.oid}`, f);
    onPage?.(p + 1, maxPages);
    if (r.length < 2000) { truncated = false; break; }
    truncated = p === maxPages - 1;
    s = Math.max(...r.map(f => f.time)) + 1;
    if (pause) await sleep(pause);
  }
  const fills = [...seen.values()].sort((a, b) => a.time - b.time || a.tid - b.tid);
  return Object.assign(fills, { truncated });
}

const dexState = st => ({
  accountValue: F(st.marginSummary?.accountValue || 0),
  marginUsed: F(st.marginSummary?.totalMarginUsed || 0),
  maintUsed: F(st.crossMaintenanceMarginUsed || 0), // Hyperliquid liquidates cross positions when account value falls to this
  withdrawable: F(st.withdrawable || 0),
  positions: (st.assetPositions || []).map(({ position: p }) => ({
    coin: p.coin, szi: F(p.szi), entry: F(p.entryPx || 0), liqPx: p.liquidationPx == null ? null : F(p.liquidationPx),
    lev: F(p.leverage?.value || 0), levType: p.leverage?.type || null, value: F(p.positionValue || 0), upnl: F(p.unrealizedPnl || 0) })),
});

/** Both dexes: {main, xyz}, each {accountValue, marginUsed, positions: [{coin, szi, liqPx, lev}]}. xyz coins carry the "xyz:" prefix. */
export async function clearinghouse(user, { fetch, waits } = {}) {
  const main = await hlInfo({ type: 'clearinghouseState', user }, { want: Object, fetch, ...(waits ? { waits } : {}) });
  const xyz = await hlInfo({ type: 'clearinghouseState', user, dex: 'xyz' }, { want: Object, fetch, ...(waits ? { waits } : {}) });
  const x = dexState(xyz);
  for (const p of x.positions) if (!p.coin.startsWith('xyz:')) p.coin = `xyz:${p.coin}`;
  return { main: dexState(main), xyz: x };
}

/** 1h (default) candles: [{T, c, l, h}] with numbers. */
export async function candles(coin, t0, t1, { interval = '1h', fetch } = {}) {
  const k = await hlInfo({ type: 'candleSnapshot', req: { coin, interval, startTime: t0, endTime: t1 } }, { want: Array, fetch });
  return k.filter(x => x.T <= t1).map(x => ({ T: x.T, c: F(x.c), l: F(x.l), h: F(x.h) }));
}

/** All-time account value and P&L history: {accountValue: [[t, v]], pnl: [[t, v]]}, sorted. */
export async function portfolioHistory(user, { fetch } = {}) {
  const r = Object.fromEntries(await hlInfo({ type: 'portfolio', user }, { want: Array, fetch }));
  const a = r.allTime || {}; const num = h => (h || []).map(([t, v]) => [F(t), F(v)]).sort((x, y) => x[0] - y[0]);
  return { accountValue: num(a.accountValueHistory), pnl: num(a.pnlHistory), perp: r.perpAllTime ? { accountValue: num(r.perpAllTime.accountValueHistory), pnl: num(r.perpAllTime.pnlHistory) } : null };
}

/** Deposits, withdrawals and transfers since t0: [{time, type, usdc}] (usdc signed: + in, - out where known). */
export async function ledger(user, t0, { fetch } = {}) {
  const r = await hlInfo({ type: 'userNonFundingLedgerUpdates', user, startTime: t0 }, { want: Array, fetch });
  return r.map(u => {
    const d = u.delta || {}; let usdc = F(d.usdc || d.usdcValue || 0);
    if (d.type === 'withdraw' || (d.type === 'accountClassTransfer' && d.toPerp === false)) usdc = -Math.abs(usdc);
    if ((d.type === 'internalTransfer' || d.type === 'subAccountTransfer') && d.user?.toLowerCase() === user.toLowerCase()) usdc = -Math.abs(usdc);
    return { time: u.time, type: d.type, usdc };
  });
}
