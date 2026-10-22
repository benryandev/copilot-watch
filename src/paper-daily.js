// Paper Copy summaries: replay a trial from its start to now (public Hyperliquid data), and the 08:00 Brisbane
// daily message for trials started from the bot.
import { fetchLead, replay, fmSize, frSize, equityFn, DAY } from '../core/replay.js';
import { buildMarkets } from '../core/markets.js';
import { getTrial, PAGE } from './paper.js';
import { makeDeps } from './deps.js';
import { sendTelegram } from './telegram.js';
import { postDiscord } from './discord.js';
import { short, usd } from './text.js';

/** Replays one trial. Returns the replay result plus {days}. */
export async function runTrial(t, mk, { now = Date.now(), fetch, maxPages = 3, maxCoins = 8, fundingCache = null } = {}) {
  const days = Math.max(1 / 24, (now - t.from) / DAY);
  const lead = await fetchLead(t.lead, days, mk, { fetch, now, maxPages, maxCoins, fundingCache });
  const s = t.settings;
  const size = s.mode === 'fm' ? fmSize(s.amount, s.lev) : frSize(s.amount, equityFn(lead.equityHistory));
  const r = replay({ orders: lead.orders, marks: lead.marks, start: s.start, size, lev: s.lev, fee: 0.0005, cap: s.cap, tcap: s.tcap,
    excluded: new Set(s.excluded), mk, marginMode: s.marginMode, funding: lead.funding });
  return { ...r, days, truncated: lead.truncated };
}

export const trialLine = (t, r) => {
  const s = t.settings, mode = s.mode === 'fm' ? `fixed margin ${usd(s.amount)}` : `fixed ratio ${usd(s.amount)}`;
  const since = new Date(t.from).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Brisbane' });
  return `Paper copy of ${short(t.lead)} (${mode}, ${s.lev}x ${s.marginMode}): ${usd(r.net, true)} since ${since}, biggest drop ${usd(r.dd)}, ` +
    `${r.liquidations} liquidation${r.liquidations === 1 ? '' : 's'}, ${r.taken} entries copied. ${PAGE}${t.id}`;
};

export async function dailyPaper(env, deps = null) {
  const d = deps || { ...makeDeps(env), send: (chat, text) => chat.platform === 'tg' ? sendTelegram(env, chat.chatId, text) : postDiscord(env, chat.chatId, text) };
  const kv = d.kv || env.KV; const now = d.now ? d.now() : Date.now();
  const chats = (await d.store.listChats()).filter(c => c.trials?.length);
  const res = { chats: 0, trials: 0, failed: 0 };
  if (!chats.length) { console.log(res); return res; }
  const meta = await d.hl.meta(); const mk = buildMarkets(await d.strike.markets(), meta.core, meta.xyz);
  let budget = 60; const fundingCache = new Map();  // funding is per market, so trials in one run share it
  for (const c of chats) {
    const lines = [];
    for (const id of c.trials) {
      if (budget-- <= 0) break;
      const t = await getTrial(kv, id); if (!t) continue;
      try { lines.push(trialLine(t, await (d.runTrial || runTrial)(t, mk, { now, fundingCache }))); res.trials++; }
      catch { res.failed++; lines.push(`Paper copy of ${short(t.lead)}: Hyperliquid was busy, so no update today. ${PAGE}${t.id}`); }
    }
    if (lines.length) { await d.send(c, ['Daily paper copy update:', ...lines].join('\n\n')); res.chats++; }
  }
  console.log(res);
  return res;
}
