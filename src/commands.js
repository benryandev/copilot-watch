// Platform-neutral commands. Transports turn messages into {platform, chatId, guildId, userId, isAdmin, name, args} and send back a Reply.
import { T } from './text.js';
import { resolveWatchTarget } from './resolve.js';
import { chatKey } from './store.js';

export const MAX_ACCOUNTS = 5, MAX_CHANNELS_PER_GUILD = 3;

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
  if (!(await store.rateOk(key))) return { text: T.rate, ephemeral: true };
  const chat = await store.getChat(key);
  const args = (cmd.args || []).map(a => String(a)).filter(Boolean);

  switch (cmd.name) {
    case 'start': return { text: T.start };
    case 'help': return { text: T.help };

    case 'watch': {
      if (!args.length) return { text: T.help };
      if (chat && !canChange(cmd, chat)) return { text: T.notOwner, ephemeral: true };
      if (cmd.platform === 'dc' && !chat && cmd.guildId) {
        const inGuild = (await store.listChats()).filter(c => c.platform === 'dc' && c.guildId === cmd.guildId);
        if (inGuild.length >= MAX_CHANNELS_PER_GUILD) return { text: T.tooManyChannels };
      }
      let r;
      try { r = await resolveWatchTarget(args[0], args[1], { strike }); } catch { return { text: T.strikeDown }; }
      if (!r.ok) return { text: r.reason === 'ambiguous_sub' ? T.ambiguousSub : r.reason === 'sub_not_found' ? T.subNotFound(r.names) : r.reason === 'not_found' ? T.notFound : r.hl ? T.hlAddr : T.badInput };
      const have = chat?.accounts || [];
      const add = r.accounts.filter(a => !have.some(h => h.accountId === a.accountId));
      if (have.length + add.length > MAX_ACCOUNTS) return { text: T.tooMany };
      const next = chat || { platform: cmd.platform, chatId: cmd.chatId, guildId: cmd.guildId || null, ownerUserId: cmd.userId, accounts: [], settings: { liq: 5 }, createdAt: now() };
      next.accounts = [...have, ...add];
      await store.putChat(next);
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

    case 'stop': {
      if (!chat) return { text: T.stopped };
      if (!canChange(cmd, chat)) return { text: T.notOwner, ephemeral: true };
      await store.deleteChat(key);
      return { text: T.stopped };
    }

    default: return { text: T.help };
  }
}
