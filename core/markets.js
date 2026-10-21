// Strike markets and their Hyperliquid twins. Port of Strike Copilot common.py (markets, tier, hl_map).

/** Strike base asset -> Hyperliquid coin where the names differ. Everything else maps by name (main dex) or "xyz:<name>". */
export const ALIASES = { SKHYNIX: 'xyz:SKHX', NAS100: 'xyz:XYZ100', WTI: 'xyz:CL', XAG: 'xyz:SILVER', XAU: 'xyz:GOLD' };
const F = Number;

/**
 * @param {object} strikeMarkets `markets` object from Strike GET /v2/markets
 * @param {Set<string>} hlCore coin names on Hyperliquid's main dex
 * @param {Set<string>} hlXyz coin names on the xyz dex ("xyz:GOLD")
 * @returns {Record<string, {base: string, hl: string|null, minNotional: number, tiers: number[][]}>}
 */
export function buildMarkets(strikeMarkets, hlCore, hlXyz) {
  const out = {};
  for (const [sym, m] of Object.entries(strikeMarkets || {})) {
    if (m.status !== 'trading') continue;
    const b = m.base_asset;
    const hl = ALIASES[b] ?? (hlCore.has(b) ? b : hlXyz.has(`xyz:${b}`) ? `xyz:${b}` : null);
    const tiers = (m.margin_tiers || []).map(t => [F(t.max_notional), F(t.max_leverage), F(t.maintenance_margin_rate), F(t.maintenance_amount || 0)]);
    out[sym] = { base: b, hl, minNotional: F(m.order_min_notional || 10), tiers: tiers.length ? tiers : [[1e18, 10, 0.025, 0]] };
  }
  return out;
}

/** HL coin -> Strike symbol, for every Strike market a Hyperliquid wallet can be copied on. */
export const hlMap = mk => Object.fromEntries(Object.entries(mk).filter(([, v]) => v.hl).map(([s, v]) => [v.hl, s]));

/** Strike margin tier for a position of this notional: [max leverage, maintenance margin in USD]. */
export function tier(m, notional) {
  const t = m.tiers.find(t => notional <= t[0]) ?? m.tiers[m.tiers.length - 1];
  return [t[1], Math.max(notional * t[2] - t[3], 0)];
}

/** Stock and commodity markets (HL xyz dex): their prices pause outside market hours. */
export const isOffHours = (mk, sym) => !!mk[sym]?.hl?.startsWith('xyz:');
