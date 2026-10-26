// Platform-neutral commands. Transports turn messages into {platform, chatId, guildId, userId, isAdmin, name, args} and send back a Reply.
import { texts, parseLang } from './i18n.js';
import { resolveWatchTarget } from './resolve.js';
import { chatKey, bump } from './store.js';
import { parseTrial, createTrial, getTrial, MAX_PER_CHAT, PAGE } from './paper.js';

/** /start payloads counted as arrivals (Telegram deep links: t.me/CopilotWatchBot?start=check). */
export const SOURCES = ['check', 'copilot'];

export const MAX_ACCOUNTS = 5, MAX_CHANNELS_PER_GUILD = 3, MAX_CHATS = 300, MAX_WATCHED = 300, MAX_DC_PER_USER = 3;

/** Active copies for an account from the (cached) leaderboard. */
export const subsFor = (rows, accountId) => rows.filter(r => r.followerId === accountId && r.status === 'active');

const canChange = (cmd, chat) => cmd.platform !== 'dc' || cmd.isAdmin || !chat || chat.ownerUserId === cmd.userId;

/**
 * @param {{platform: 'tg'|'dc', chatId: string, guildId?: string, userId: string, isAdmin?: boolean, name: string, args: string[]}} cmd
 * @param {{store, strike, now?: () => number}} deps  strike: {accountByAddress, accountByNickname, accountById, leaderboard, copyPositions}
 * @returns {Promise<{text: string, ephemeral?: boolean}>}
 */
export async function handleCommand(cmd, deps) {
  const { store, strike, now = () => Date.now() } = deps;
  const key = chatKey(cmd.platform, cmd.chatId);
  if (!(await (deps.rateOk ? deps.rateOk(key) : store.rateOk(key)))) return { text: texts(cmd.lang).T.rate, ephemeral: true };
  const chat = await store.getChat(key);
  // Discord stays English; Telegram: the chat's saved choice, else a /lang pref, else the app's language.
  const lang = cmd.platform === 'dc' ? 'en' : chat?.settings?.lang || (store.getLang ? await store.getLang(key) : null) || cmd.lang || 'en';
  const { T } = texts(lang);
  const args = (cmd.args || []).map(a => String(a)).filter(Boolean);

  switch (cmd.name) {
    case 'start':
      if (SOURCES.includes(args[0])) await bump(deps.kv || deps.env?.KV, `from_${args[0]}`, now());
      return { text: T.start };
    case 'help': return { text: T.help };

    case 'watch': {
      if (!args.length) return { text: T.help };
      if (chat && !canChange(cmd, chat)) return { text: T.notOwner, ephemeral: true };
      if (!chat && (await store.countChats()) >= MAX_CHATS) return { text: T.full };
      if (cmd.platform === 'dc' && !chat && cmd.guildId) {
        const dcs = (await store.listChats()).filter(c => c.platform === 'dc');
        if (dcs.filter(c => c.guildId === cmd.guildId).length >= MAX_CHANNELS_PER_GUILD) return { text: T.tooManyChannels };
        if (dcs.filter(c => c.ownerUserId === cmd.userId).length >= MAX_DC_PER_USER) return { text: T.tooManyForUser };
      }
      let r;
      try { r = await resolveWatchTarget(args[0], args[1], { strike }); } catch { return { text: T.strikeDown }; }
      if (!r.ok) return { text: r.reason === 'ambiguous_sub' ? T.ambiguousSub : r.reason === 'sub_not_found' ? T.subNotFound(r.names) : r.reason === 'not_found' ? T.notFound : r.hl ? T.hlAddr : T.badInput };
      const have = chat?.accounts || [];
      const add = r.accounts.filter(a => !have.some(h => h.accountId === a.accountId));
      if (have.length + add.length > MAX_ACCOUNTS) return { text: T.tooMany };
      if (add.length) { const known = await Promise.all(add.map(a => store.getAcct(a.accountId)));
        if (known.some(k => !k) && (await store.countAccts()) + known.filter(k => !k).length > MAX_WATCHED) return { text: T.full }; }
      const next = chat || { platform: cmd.platform, chatId: cmd.chatId, guildId: cmd.guildId || null, ownerUserId: cmd.userId, accounts: [], settings: { liq: 5, lang }, createdAt: now() };
      next.accounts = [...have, ...add];
      await store.putChat(next);
      if (!chat) await bump(deps.kv || deps.env?.KV, `chat_${cmd.platform}`, now());
      const rows = await store.cachedLeaderboard(() => strike.leaderboard()).catch(() => []);
      const lines = [];
      for (const a of r.accounts) {
        const pos = await strike.copyPositions(a.accountId).catch(() => null);
        lines.push(T.watchLine(a.label, subsFor(rows, a.accountId), pos ? pos.length : 0));
      }
      return { text: [T.watchHead, ...lines, '', T.watchTail].join('\n') };
    }

    case 'unwatch': {
      if (!chat?.accounts.length) return { text: T.nothingWatched };
      if (!canChange(cmd, chat)) return { text: T.notOwner, ephemeral: true };
      const want = args.join(' ').trim().toLowerCase();
      const hit = chat.accounts.filter(a => a.accountId === want || a.label.toLowerCase() === want || a.label.toLowerCase().endsWith(`/ ${want}`));
      if (!hit.length || !want) return { text: T.unwatchNone };
      chat.accounts = chat.accounts.filter(a => !hit.includes(a));
      if (chat.accounts.length) await store.putChat(chat); else await store.deleteChat(key);
      return { text: hit.map(a => T.unwatched(a.label)).join('\n') };
    }

    case 'status': {
      if (!chat?.accounts.length) return { text: T.nothingWatched };
      const out = [];
      for (const a of chat.accounts) {
        const pos = await strike.copyPositions(a.accountId).catch(() => null);
        out.push(`${T.statusHead(a.label)}${pos === null ? `: ${T.strikeDown}` : pos.length ? '' : `: ${T.statusNone}`}`);
        const rows = (pos || []).map(p => ({ ...p, dist: p.liq && p.mark ? Math.abs(p.mark - p.liq) / p.mark * 100 : null }));
        rows.sort((x, y) => (x.dist ?? 1e9) - (y.dist ?? 1e9)); // nearest to liquidation first
        for (const p of rows) out.push('  ' + T.statusLine(p));
      }
      out.push('', T.statusTail(chat.settings?.liq ?? 5));
      return { text: out.join('\n') };
    }

    case 'settings': {
      if (!chat) return { text: T.nothingWatched };
      if (!canChange(cmd, chat)) return { text: T.notOwner, ephemeral: true };
      const m = /^(?:liq=)?(\d{1,2})%?$/i.exec(args.join('').trim());
      const n = m ? Number(m[1]) : NaN;
      if (!(n >= 1 && n <= 20)) return { text: T.settingsBad };
      chat.settings = { ...(chat.settings || {}), liq: n };
      await store.putChat(chat);
      return { text: T.settingsOk(n) };
    }

    case 'paper': {
      const kv = deps.kv || deps.env?.KV;
      if (chat && !canChange(cmd, chat)) return { text: T.notOwner, ephemeral: true };
      const live = [];
      for (const id of chat?.trials || []) { const t = await getTrial(kv, id); if (t) live.push(t); }
      if (!args.length) return { text: live.length ? [T.paperList, ...live.map(t => T.paperItem(t, PAGE + t.id))].join('\n') : T.paperHelp };
      if (live.length >= MAX_PER_CHAT) return { text: T.paperMax };
      const sizeArg = args[1] ? Number(String(args[1]).replace(/[$,]/g, '')) : 1000;
      if (!(sizeArg >= 10 && sizeArg <= 1_000_000)) return { text: T.paperHelp };
      const p = parseTrial({ lead: args[0], settings: { mode: 'fm', amount: Math.max(1, Math.round(sizeArg / 20)), lev: 5, marginMode: 'isolated', start: sizeArg } }, now());
      if (!p.ok) return { text: p.error === 'bad_wallet' ? T.paperBadWallet : T.paperHelp };
      const r = await createTrial(kv, p.trial, { chat: key });
      if (r.error) return { text: T.paperFull };
      const next = chat || { platform: cmd.platform, chatId: cmd.chatId, guildId: cmd.guildId || null, ownerUserId: cmd.userId, accounts: [], settings: { liq: 5, lang }, createdAt: now() };
      next.trials = [...live.map(t => t.id), r.id];
      await store.putChat(next);
      await bump(kv, 'paper_bot', now());
      if (!chat) await bump(kv, `chat_${cmd.platform}`, now());
      return { text: T.paperMade(p.trial, r.url) };
    }

    case 'lang': {
      const want = cmd.platform === 'dc' ? null : parseLang(args[0]);
      if (!want) return { text: T.langBad };
      if (chat) {
        if (!canChange(cmd, chat)) return { text: T.notOwner, ephemeral: true };
        chat.settings = { ...(chat.settings || {}), lang: want };
        await store.putChat(chat);
      } else if (store.putLang) await store.putLang(key, want);
      return { text: texts(want).T.langSet };
    }

    case 'stop': {
      if (store.deleteLang) await store.deleteLang(key);
      if (!chat) return { text: T.stopped };
      if (!canChange(cmd, chat)) return { text: T.notOwner, ephemeral: true };
      const kv = deps.kv || deps.env?.KV;
      for (const id of chat.trials || []) if (kv) await kv.delete(`paper:${id}`);
      await store.deleteChat(key);
      await bump(kv, 'stop', now());
      return { text: T.stopped };
    }

    default: return { text: T.help };
  }
}
