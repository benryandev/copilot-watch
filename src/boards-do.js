// Boards: one Durable Object per leaderboard, the board's only writer (6 Nov 2026). The boards were one KV value each,
// changed by read-modify-write; KV reads can be about a minute stale, so two posts close together could each read the
// board from before the other and the second write erased the first's row (CryptoNinja's 30.372 on the Lagoon). Here
// the same merge rules (race.js addTime/removeTime, arcade.js addScore/removeScore) run one request at a time over the
// object's own storage, and every change is mirrored to the same KV key, so KV stays current for a rollback.
// Lives in copilot-world (wrangler.world.toml), never in copilot-watch: a DO migration must not touch the alerts.
import { addTime, removeTime } from './race.js';
import { addScore, removeScore } from './arcade.js';

const SEEDED = 'board:seeded';

/** A KV-shaped view of DO storage: the merge functions only call get(key, 'json') and put(key, string). */
export const kvOver = storage => ({
  async get(k, type) {
    const v = await storage.get(k);
    if (v === undefined || v === null) return null;
    return type === 'json' ? JSON.parse(v) : v;
  },
  put: (k, v) => storage.put(k, String(v)),
});

const raceKey = track => `race:top:${track}`, arcadeKey = game => `arcade:top:${game}`;
// Each op checks that the board it would write is this object's own, so a request can never write another board's key
const OPS = {
  read: async (kv, key) => (await kv.get(key, 'json')) || [],
  raceAdd: (kv, key, { entry, now }) => raceKey(entry?.track) === key ? addTime(kv, entry, now) : null,
  raceRemove: async (kv, key, { track, id, name }) => raceKey(track) === key ? { removed: await removeTime(kv, track, { id, name }) } : null,
  arcadeAdd: (kv, key, { entry, now }) => arcadeKey(entry?.game) === key ? addScore(kv, entry, now) : null,
  arcadeRemove: async (kv, key, { game, id, name }) => arcadeKey(game) === key ? { removed: await removeScore(kv, game, { id, name }) } : null,
};

const reply = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

export class Boards {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.kv = kvOver(ctx.storage);
  }

  // Once per object: copy the board KV holds today. A KV failure throws, so nothing is stored over a board it could not read.
  async seed(key) {
    if (await this.ctx.storage.get(SEEDED)) return;
    const v = await this.env.KV.get(key);
    if (v !== null && v !== undefined) await this.ctx.storage.put(key, v);
    await this.ctx.storage.put(SEEDED, true);
  }

  async mirror(key) {
    try { await this.env.KV.put(key, await this.ctx.storage.get(key)); } catch { console.log('board mirror failed', JSON.stringify({ key })); }
  }

  async fetch(req) {
    let body;
    try { body = await req.json(); } catch { return reply({ error: 'bad_json' }, 400); }
    const { op, key, args = {} } = body || {};
    if (op === 'reseed') { // the writer was off and KV moved on: drop this copy, seed again on the next request
      await this.ctx.blockConcurrencyWhile(() => this.ctx.storage.deleteAll());
      return reply({ ok: true });
    }
    if (!Object.hasOwn(OPS, op) || typeof key !== 'string') return reply({ error: 'bad_op' }, 400);
    let out;
    try {
      out = await this.ctx.blockConcurrencyWhile(async () => {
        await this.seed(key);
        const before = await this.ctx.storage.get(key);
        const res = await OPS[op](this.kv, key, args);
        const after = await this.ctx.storage.get(key);
        return { res, value: after !== before ? after : null };
      });
    } catch (e) {
      console.log('board op failed', JSON.stringify({ key, op, error: e?.message || 'error' }));
      return reply({ error: 'board_busy' }, 500);
    }
    if (out.res === null) return reply({ error: 'wrong_board' }, 400);
    // Mirror writes run one after another and each writes the board as stored at that moment, so a slow earlier put
    // can never land after a later one and leave KV behind (the branch review, 6 Nov)
    if (out.value !== null) await (this.mirrored = (this.mirrored || Promise.resolve()).then(() => this.mirror(key)));
    return reply(out.res);
  }
}
