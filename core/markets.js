// Strike markets and their Hyperliquid twins. Port of Strike Copilot common.py (markets, tier, hl_map).

/** Strike base asset -> Hyperliquid coin where the names differ. Everything else maps by name (main dex) or "xyz:<name>". */
export const ALIASES = { SKHYNIX: 'xyz:SKHX', NAS100: 'xyz:XYZ100', WTI: 'xyz:CL', XAG: 'xyz:SILVER', XAU: 'xyz:GOLD' };
const F = Number;

/**
 * @param {object} strikeMarkets `markets` object from Strike GET /v2/markets
 * @param {Set<string>} hlCore coin names on Hyperliquid's main dex
 * @param {Set<string>} hlXyz coin names on the xyz dex ("xyz:GOLD")
 * @param {Record<string, Set<string>>} [hlOther] other builder dexes: {io: Set(["io:DRAM", ...])}. Strike copies a lead's fills
 *   on any of them by name (a lead's io:DRAM fill was copied to DRAM-USD on 22 Oct 2026), so they go in `alt`.
 * @returns {Record<string, {base: string, hl: string|null, alt: string[], minNotional: number, tiers: number[][]}>}
 */
export function buildMarkets(strikeMarkets, hlCore, hlXyz, hlOther = {}) {
  const out = {};
  for (const [sym, m] of Object.entries(strikeMarkets || {})) {
    if (m.status !== 'trading') continue;
    const b = m.base_asset;
    const hl = ALIASES[b] ?? (hlCore.has(b) ? b : hlXyz.has(`xyz:${b}`) ? `xyz:${b}` : null);
    const tiers = (m.margin_tiers || []).map(t => [F(t.max_notional), F(t.max_leverage), F(t.maintenance_margin_rate), F(t.maintenance_amount || 0)]);
    const names = [...new Set([b, (ALIASES[b] || '').replace(/^xyz:/, '')].filter(Boolean))];
    const alt = Object.entries(hlOther).flatMap(([dex, set]) => names.map(n => `${dex}:${n}`).filter(c => set.has(c) && c !== hl));
    out[sym] = { base: b, hl, alt, minNotional: F(m.order_min_notional || 10), tiers: tiers.length ? tiers : [[1e18, 10, 0.025, 0]] };
  }
  return out;
}

/** HL coin -> Strike symbol, for every Strike market a Hyperliquid wallet can be copied on. */
export const hlMap = mk => Object.fromEntries(Object.entries(mk).flatMap(([s, v]) => coinsOf(v).map(c => [c, s])));

/** Every Hyperliquid coin a Strike market copies from: the main one first, then the same name on other dexes. */
export const coinsOf = m => (m ? [m.hl, ...(m.alt || [])].filter(Boolean) : []);

/** Builder dexes beyond xyz that hold a Strike market's twin (whose positions a lead check must also read). */
export const altDexes = mk => [...new Set(Object.values(mk).flatMap(v => (v.alt || []).map(c => c.split(':')[0])))].sort();

/** Strike margin tier for a position of this notional: [max leverage, maintenance margin in USD]. */
export function tier(m, notional) {
  const t = m.tiers.find(t => notional <= t[0]) ?? m.tiers[m.tiers.length - 1];
  return [t[1], Math.max(notional * t[2] - t[3], 0)];
}

/** Stock and commodity markets (HL xyz dex): their prices pause outside market hours. */
export const isOffHours = (mk, sym) => !!mk[sym]?.hl?.startsWith('xyz:');
