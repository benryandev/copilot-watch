// KV schema for Copilot Watch. Values are JSON. Nothing here holds message text.
//   chat:<tg|dc>:<id>  {platform, chatId, guildId?, ownerUserId, accounts: [{accountId, label}], settings: {liq, lang?}, createdAt}
//   acct:<accountId>   {chats: [chatKey], base: snapshot baseline, at}
//   lead:<0x>          {at, ...last snapshot}
//   cool:<chatKey>:<alertKey>   1, expires (A1 6 h, others 24 h)
//   rate:<chatKey>:<minute>     count, expires after 2 minutes
//   cache:leaderboard  {at, rows}
//   stat:<name>:<YYYY-MM-DD>   daily count (no ids), expires after 400 days; see scripts/stats.mjs
//   lang:<chatKey>              'en' | 'zh', a /lang choice made before the chat has a record; expires after 30 days, /stop deletes it

export const chatKey = (platform, chatId) => `chat:${platform}:${chatId}`;

/** Add 1 to today's (UTC) count for `name`. Counts only, never ids; a failed write is ignored so it can't break a command. */
export async function bump(kv, name, now = Date.now()) {
  if (!kv) return;
  try {
    const k = `stat:${name}:${new Date(now).toISOString().slice(0, 10)}`;
    const n = (Number(await kv.get(k)) || 0) + 1;
    await kv.put(k, String(n), { expirationTtl: 400 * 86400, metadata: { n } }); // metadata lets a key listing read counts without a get each
  } catch { /* counts are best effort */ }
}

export function createStore(kv, { now = () => Date.now() } = {}) {
  const getJ = k => kv.get(k, 'json');
  const putJ = (k, v, o) => kv.put(k, JSON.stringify(v), o);
  async function listAll(prefix) {
    const out = []; let cursor;
    do { const r = await kv.list({ prefix, cursor }); out.push(...r.keys.map(k => k.name)); cursor = r.list_complete ? undefined : r.cursor; } while (cursor);
    return out;
  }
  const s = {
    getChat: key => getJ(key),
    async putChat(chat) {
      const key = chatKey(chat.platform, chat.chatId);
      const before = await getJ(key);
      await putJ(key, chat);
      const was = new Set((before?.accounts || []).map(a => a.accountId)), is = new Set(chat.accounts.map(a => a.accountId));
      for (const id of is) if (!was.has(id)) await s.linkAcct(id, key);
      for (const id of was) if (!is.has(id)) await s.unlinkAcct(id, key);
      return key;
    },
    async deleteChat(key) {
      const chat = await getJ(key); if (!chat) return false;
      for (const a of chat.accounts) await s.unlinkAcct(a.accountId, key);
      await kv.delete(key); await kv.delete(`pending:${key}`); return true;
    },
    async countAccts() { return (await listAll('acct:')).length; },
    async countChats() { return (await listAll('chat:')).length; },
    async listChats() { const keys = await listAll('chat:'); return (await Promise.all(keys.map(getJ))).filter(Boolean); },
    getLang: key => kv.get(`lang:${key}`),
    putLang: (key, lang) => kv.put(`lang:${key}`, lang, { expirationTtl: 30 * 86400 }),
    deleteLang: key => kv.delete(`lang:${key}`),
    getAcct: id => getJ(`acct:${id}`),
    putAcct: (id, v) => putJ(`acct:${id}`, v),
    async linkAcct(id, key) {
      const a = (await getJ(`acct:${id}`)) || { chats: [], base: null, at: 0 };
      if (!a.chats.includes(key)) a.chats.push(key);
      await putJ(`acct:${id}`, a);
    },
    async unlinkAcct(id, key) {
      const a = await getJ(`acct:${id}`); if (!a) return;
      a.chats = a.chats.filter(c => c !== key);
      if (a.chats.length) await putJ(`acct:${id}`, a); else await kv.delete(`acct:${id}`);
    },
    getLead: addr => getJ(`lead:${addr.toLowerCase()}`),
    putLead: (addr, v) => putJ(`lead:${addr.toLowerCase()}`, v),
    /** true the first time for (chat, alert) within ttl seconds; false while the cool-down runs. */
    async coolOnce(key, alertKey, ttlSec) {
      const k = `cool:${key}:${alertKey}`;
      if (await kv.get(k)) return false;
      await kv.put(k, '1', { expirationTtl: Math.max(60, ttlSec) }); return true;
    },
    /** Alerts that couldn't be delivered, kept for an hour and resent on the next poll. */
    getPending: key => getJ(`pending:${key}`),
    putPending: (key, alerts) => alerts.length ? putJ(`pending:${key}`, alerts, { expirationTtl: 3600 }) : kv.delete(`pending:${key}`),
    /** Per-chat command limit per minute. */
    async rateOk(key, perMin = 10) {
      const k = `rate:${key}:${Math.floor(now() / 60000)}`;
      const n = Number(await kv.get(k)) || 0;
      if (n >= perMin) return false;
      await kv.put(k, String(n + 1), { expirationTtl: 120 }); return true;
    },
    /** Generic JSON cache: returns the stored value if younger than maxAgeMs, else loads (keeping the old value if the load fails). */
    async cached(name, maxAgeMs, loader) {
      const c = await getJ(`cache:${name}`);
      if (c && now() - c.at < maxAgeMs) return c.v;
      let v = null; try { v = await loader(); } catch { v = null; }
      if (v != null) { await putJ(`cache:${name}`, { at: now(), v }); return v; }
      return c ? c.v : null;
    },
    getCache: async name => (await getJ(`cache:${name}`))?.v ?? null,
    setCache: (name, v) => putJ(`cache:${name}`, { at: now(), v }),
    /** Strike caches the leaderboard ~10 minutes, so do the same. */
    async cachedLeaderboard(loader, maxAgeMs = 10 * 60 * 1000) {
      const c = await getJ('cache:leaderboard');
      if (c && now() - c.at < maxAgeMs) return c.rows;
      const rows = await loader();
      if (rows && rows.length) await putJ('cache:leaderboard', { at: now(), rows });
      return rows?.length ? rows : (c?.rows || []);
    },
  };
  return s;
}
