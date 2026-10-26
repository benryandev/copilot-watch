// Paper Copy summaries: replay a trial from its start to now (public Hyperliquid data), and the 08:00 Brisbane
// daily message for trials started from the bot.
import { fetchLead, replay, fmSize, frSize, equityFn, DAY } from '../core/replay.js';
import { buildMarkets } from '../core/markets.js';
import { getTrial, PAGE } from './paper.js';
import { makeDeps } from './deps.js';
import { sendTelegram } from './telegram.js';
import { postDiscord } from './discord.js';
import { texts } from './i18n.js';

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

export const trialLine = (t, r, lang = 'en') => {
  const since = new Date(t.from).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-AU', { day: 'numeric', month: lang === 'zh' ? 'long' : 'short', timeZone: 'Australia/Brisbane' });
  return texts(lang).T.trialLine(t, r, since, PAGE);
};

export async function dailyPaper(env, deps = null) {
  const d = deps || { ...makeDeps(env), send: (chat, text) => chat.platform === 'tg' ? sendTelegram(env, chat.chatId, text) : postDiscord(env, chat.chatId, text) };
  const kv = d.kv || env.KV; const now = d.now ? d.now() : Date.now();
  const chats = (await d.store.listChats()).filter(c => c.trials?.length);
  const res = { chats: 0, trials: 0, failed: 0 };
  if (!chats.length) { console.log(res); return res; }
  const meta = await d.hl.meta(); const mk = buildMarkets(await d.strike.markets(), meta.core, meta.xyz, meta.other || {});
  let budget = 60; const fundingCache = new Map();  // funding is per market, so trials in one run share it
  for (const c of chats) {
    const lang = c.platform === 'dc' ? 'en' : c.settings?.lang || 'en', { T } = texts(lang);
    const lines = [];
    for (const id of c.trials) {
      if (budget-- <= 0) break;
      const t = await getTrial(kv, id); if (!t) continue;
      try { lines.push(trialLine(t, await (d.runTrial || runTrial)(t, mk, { now, fundingCache }), lang)); res.trials++; }
      catch { res.failed++; lines.push(T.trialBusy(t, PAGE)); }
    }
    if (lines.length) { await d.send(c, [T.dailyHead, ...lines].join('\n\n')); res.chats++; }
  }
  console.log(res);
  return res;
}
