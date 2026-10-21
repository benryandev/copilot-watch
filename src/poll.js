// The 2-minute cron: read public Strike and Hyperliquid data for every watched account, diff against the stored
// baseline, send new alerts. The first poll for an account only stores its baseline. Logs carry counts only.
import { detectAlerts, findOrphans, PRIORITY } from './alerts.js';
import { buildMarkets } from '../core/markets.js';
import { HlBusyError } from '../core/http.js';
import { makeDeps } from './deps.js';
import { sendTelegram } from './telegram.js';
import { postDiscord } from './discord.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isHl = a => /^0x[0-9a-f]{40}$/.test(a || '');
const PER_ACCOUNT = 3, PER_LEAD = 4; // subrequests (copy positions may fall back to 2 calls; HL: 2 clearinghouse + fills + ledger)

async function loadMarkets(deps) {
  return deps.store.cached('markets', 12 * 3600_000, async () => {
    const [sm, meta] = await Promise.all([deps.strike.markets(), deps.hl.meta()]);
    const mk = buildMarkets(sm, meta.core, meta.xyz);
    return Object.keys(mk).length ? mk : null;
  });
}

async function readLead(addr, deps, now) {
  const ch = await deps.hl.clearinghouse(addr);
  const fills = await deps.hl.fillsByTime(addr, now - 30 * 60_000, now);
  const led = await deps.hl.ledger(addr, now - 24 * 3600_000);
  const withdrawn24h = led.filter(u => u.usdc < 0).reduce((s, u) => s - u.usdc, 0);
  return { ch, fills: fills.map(f => ({ coin: f.coin, dir: f.dir, time: f.time, oid: f.oid, liquidation: f.liquidation || null })),
    withdrawn24h, accountValue: (ch.main?.accountValue || 0) + (ch.xyz?.accountValue || 0) };
}

const slimFills = f => f.slice(0, 200).map(({ id, symbol, ts, copySubId, autoClose, pnl }) => ({ id, symbol, ts, copySubId, autoClose, pnl }));

/**
 * @param {object} env Worker env
 * @param {object} [deps] {store, strike, hl, send(chat, text), now(), budget, gap}
 */
export async function poll(env, deps = null) {
  const d = deps || { ...makeDeps(env), send: (chat, text) => chat.platform === 'tg' ? sendTelegram(env, chat.chatId, text) : postDiscord(env, chat.chatId, text) };
  const now = d.now ? d.now() : Date.now(); const gap = d.gap ?? 250; let budget = d.budget ?? 900;
  const res = { accounts: 0, leads: 0, sent: 0, skippedLeads: 0, deferredLeads: 0 };
  const chats = await d.store.listChats();
  if (!chats.length) { console.log(res); return res; }

  const accounts = new Map();
  for (const c of chats) for (const a of c.accounts) {
    if (!accounts.has(a.accountId)) accounts.set(a.accountId, { label: a.label, chats: [] });
    accounts.get(a.accountId).chats.push(c);
  }
  const mk = (await loadMarkets(d)) || {};
  const active = await d.store.cachedLeaderboard(() => d.strike.leaderboard({ status: 'active' }));
  budget -= 4;

  // Strike side, per account
  const cur = new Map(), prevs = new Map();
  for (const [id, a] of accounts) {
    const prev = (await d.store.getAcct(id))?.base || null; prevs.set(id, prev);
    const [copies, fills] = await Promise.all([d.strike.copyPositions(id).catch(() => null), d.strike.fills(id, { limit: 200 }).catch(() => null)]);
    budget -= PER_ACCOUNT;
    const subs = {};
    for (const r of active) if (r.followerId === id && isHl(r.leadId)) subs[r.leadId] = { status: 'active', mode: r.mode, amount: r.amount, since: r.createdAt };
    cur.set(id, { accountId: id, label: a.label, at: now, since: prev?.since ?? now, copies: copies ?? null, fills: fills ? slimFills(fills) : null, subs, orphans: [] });
  }

  // A subscription that left the active list: find out how it ended (liquidated or stopped)
  const gone = [...cur.values()].flatMap(c => Object.entries(prevs.get(c.accountId)?.subs || {}).filter(([l, s]) => s.status === 'active' && !c.subs[l]).map(([l]) => [c, l]));
  if (gone.length) {
    const ended = {};
    for (const st of ['liquidated', 'stopped']) ended[st] = await d.store.cached(`lb-${st}`, 10 * 60_000, () => d.strike.leaderboard({ status: st }));
    for (const [c, l] of gone) for (const st of ['liquidated', 'stopped']) if ((ended[st] || []).some(r => r.followerId === c.accountId && r.leadId === l)) c.subs[l] = { status: st };
  }

  // Hyperliquid side, per unique lead, oldest-read first, within the subrequest budget
  const leadIds = [...new Set([...cur.values()].flatMap(c => [...Object.keys(c.subs), ...(c.copies || []).map(p => p.leadId)]).filter(isHl))];
  const lastAt = Object.fromEntries(await Promise.all(leadIds.map(async l => [l, (await d.store.getLead(l))?.at || 0])));
  leadIds.sort((x, y) => lastAt[x] - lastAt[y]);
  const leads = {};
  for (const l of leadIds) {
    if (budget < PER_LEAD) { res.deferredLeads++; continue; } // undefined = not read this round; detectors skip it
    budget -= PER_LEAD;
    try { leads[l] = await readLead(l, d, now); res.leads++; await d.store.putLead(l, { at: now }); }
    catch (e) { leads[l] = null; res.skippedLeads++; if (!(e instanceof HlBusyError)) console.log({ leadError: e?.name || 'error' }); }
    if (gap) await sleep(gap);
  }

  // Detect, send, store the new baseline
  const outbox = new Map();
  for (const [id, a] of accounts) {
    const c = cur.get(id), prev = prevs.get(id);
    c.orphans = findOrphans(c, leads, mk);
    res.accounts++;
    for (const chat of a.chats) {
      const key = `chat:${chat.platform}:${chat.chatId}`;
      for (const al of detectAlerts(prev, c, chat.settings, { leads, mk, now })) {
        if (!(await d.store.coolOnce(key, al.key, al.ttl))) continue;
        if (!outbox.has(key)) outbox.set(key, { chat, texts: [] });
        outbox.get(key).texts.push(al);
      }
    }
    // keep last round's data where Strike didn't answer, so a blip never resets the baseline
    const base = { ...c, copies: c.copies ?? prev?.copies ?? [], fills: c.fills ?? prev?.fills ?? [], subs: { ...(prev?.subs || {}), ...c.subs } };
    for (const [l, s] of Object.entries(base.subs)) if (s.status !== 'active' && !c.subs[l]) delete base.subs[l];
    await d.store.putAcct(id, { chats: a.chats.map(ch => `chat:${ch.platform}:${ch.chatId}`), base });
  }
  for (const c of chats) { // undelivered alerts from earlier polls go out first
    const key = `chat:${c.platform}:${c.chatId}`, p = await d.store.getPending(key);
    if (!p?.length) continue;
    if (!outbox.has(key)) outbox.set(key, { chat: c, texts: [] });
    outbox.get(key).texts.unshift(...p); outbox.get(key).hadPending = true;
  }
  for (const [key, { chat, texts: als, hadPending }] of outbox) {
    const batch = als.sort((x, y) => PRIORITY[x.kind] - PRIORITY[y.kind]).slice(0, 10);
    let ok = false;
    try { ok = await d.send(chat, batch.map(a => a.text).join('\n\n')); } catch { ok = false; }
    if (ok === 'gone') { await d.store.deleteChat(key); await d.store.putPending(key, []); res.removed = (res.removed || 0) + 1; continue; }
    if (ok) { res.sent += batch.length; if (hadPending) await d.store.putPending(key, []); }
    else { res.failed = (res.failed || 0) + 1; await d.store.putPending(key, batch.map(({ kind, key: k, text }) => ({ kind, key: k, text }))); }
  }
  console.log(res);
  return res;
}
