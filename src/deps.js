// Production wiring: KV store plus Strike/Hyperliquid clients on the Worker's fetch.
import { createStore } from './store.js';
import * as strikeApi from '../core/strike.js';
import * as hlApi from '../core/hl.js';

export function makeDeps(env) {
  const store = createStore(env.KV);
  const strike = {
    accountByAddress: a => strikeApi.accountByAddress(a),
    accountByNickname: n => strikeApi.accountByNickname(n),
    accountById: id => strikeApi.accountById(id),
    leaderboard: (o = {}) => strikeApi.leaderboard(o),
    copyPositions: id => strikeApi.copyPositions(id),
    fills: (id, o = {}) => strikeApi.fills(id, o),
    markets: () => strikeApi.markets(),
  };
  const hl = {
    clearinghouse: u => hlApi.clearinghouse(u, { fetch: globalThis.fetch }),
    fillsByTime: (u, t0, t1) => hlApi.fillsByTime(u, t0, t1, { maxPages: 1, pause: 0 }),
    ledger: (u, t0) => hlApi.ledger(u, t0),
    meta: async () => {
      const { hlInfo } = await import('../core/http.js');
      const core = await hlInfo({ type: 'meta' }, { want: Object });
      const xyz = await hlInfo({ type: 'meta', dex: 'xyz' }, { want: Object });
      return { core: new Set(core.universe.map(u => u.name)), xyz: new Set(xyz.universe.map(u => u.name)) };
    },
  };
  return { store, strike, hl, env };
}
