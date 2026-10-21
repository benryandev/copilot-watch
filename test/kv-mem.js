// In-memory stand-in for a Workers KV namespace (get/put/delete/list, expirationTtl, a clock tests can move).
export function memKV() {
  const m = new Map(); const kv = { now: 0, m, writes: 0 };
  const live = k => { const e = m.get(k); if (!e) return null; if (e.exp && e.exp <= kv.now) { m.delete(k); return null; } return e; };
  kv.get = async (k, type) => { const e = live(k); if (!e) return null; return type === 'json' ? JSON.parse(e.v) : e.v; };
  kv.put = async (k, v, o = {}) => { kv.writes++; m.set(k, { v: String(v), exp: o.expirationTtl ? kv.now + o.expirationTtl * 1000 : 0 }); };
  kv.delete = async k => { m.delete(k); };
  kv.list = async ({ prefix = '', cursor } = {}) => {
    const keys = [...m.keys()].filter(k => k.startsWith(prefix) && live(k)).sort().map(name => ({ name }));
    return { keys, list_complete: true, cursor: undefined };
  };
  return kv;
}
