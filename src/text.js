// All user-facing wording, platform-neutral plain text. Alerts state what happened and the plain options; never "do this".

export const DISCLAIMER = 'Not financial advice. Not affiliated with Strike Finance.';
export const short = a => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '?');
export const usd = (n, sign = false) => {
  const v = Math.round(Number(n) || 0), s = Math.abs(v).toLocaleString('en-US');
  return `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}$${s}`;
};
export const pct = n => `${(Math.round(n * 10) / 10).toFixed(1)}%`;
export const day = ts => new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
/** A price at 5 significant figures (386.58, 0.00012345). */
export const px = n => { const v = Number(n); return Number.isFinite(v) ? String(Number(v.toPrecision(5))) : '?'; };
export const mkt = sym => (sym || '').replace(/-USD$/, '');

export const T = {
  start: 'Copilot Watch sends alerts about Strike copy trades. It reads public data only and never asks for a key.\n\n' +
    'Send /watch with a Strike address (addr1…), a nickname or a sub-account ID. Add a sub-account name after an address to watch only that one, e.g. /watch addr1… Sub1.\n\n' +
    'Alerts: a copy near liquidation, a copy the lead has already closed, a lead trade that wasn\'t copied, a copy that would be liquidated before the lead, a lead using most of their margin, a lead withdrawing most of their funds, and a copy closed by liquidation.\n\n' +
    'Commands: /status, /settings liq=5, /unwatch <account>, /paper <0x wallet> (try a copy on paper first), /lang zh (简体中文) or /lang tw (繁體中文), /stop.\n\n' +
    'Stored: this chat\'s id, the accounts you watch and the last fills seen. /stop deletes all of it. ' + DISCLAIMER,
  help: 'Commands:\n/watch <addr1, nickname or sub-account ID> [sub-account name]\n/status: open copies and how close each is to liquidation\n/settings liq=5: alert when a copy is within this % of liquidation (1 to 20)\n/unwatch <account>: stop watching one account\n/paper <0x wallet> [size]: paper copy a Hyperliquid wallet (no money)\n/lang en|zh|tw: language (English, 简体中文 or 繁體中文)\n/stop: stop everything and delete this chat\'s data\n\nSub-account IDs: Strike app, Sub-accounts page, Account ID column, copy button.',
  dmOnly: 'Copilot Watch works in direct messages only. Open a chat with the bot and send /start.',
  rate: 'Too many commands, try again in a minute.',
  full: 'Copilot Watch is at its limit of watched chats for now (it is a hackathon prototype). Try again later.',
  badInput: 'That doesn\'t look like a Strike address (addr1…), nickname or account ID. Send /help for examples.',
  hlAddr: 'That is a Hyperliquid wallet. /watch takes the Strike account that copies it: its address (addr1…), nickname or sub-account ID.',
  notFound: 'No Strike account found for that. Check the spelling, or use the address (addr1…) or the account ID from the Sub-accounts page.',
  ambiguousSub: 'Two sub-accounts share that name. Copy the sub-account\'s Account ID from Strike\'s Sub-accounts page and use /watch <id>.',
  subNotFound: names => `No active sub-account with that name. Sub-accounts on this address: ${names.length ? names.join(', ') : 'none'}.`,
  tooMany: 'This chat already watches 5 accounts. Use /unwatch <account> first.',
  tooManyForUser: 'You already have Copilot Watch in 3 channels. Use /stop in one of them first.',
  tooManyChannels: 'This server already has Copilot Watch in 3 channels. Use /stop in one of them first.',
  strikeDown: 'Couldn\'t reach Strike just now. Try again in a minute.',
  notOwner: 'Only the person who set up this watch, or a member with Manage Server, can change it.',
  nothingWatched: 'No accounts watched here yet. Send /watch with a Strike address, nickname or sub-account ID.',
  stopped: 'Stopped. This chat\'s watches, paper copies and stored data are deleted.',
  paperHelp: 'Paper copy a Hyperliquid wallet before copying it for real: /paper <0x wallet> [account size, default 1000]. It starts 14 days back so there are numbers straight away, then follows the wallet\'s real trades. No money, no key. /paper alone lists this chat\'s paper copies.',
  paperBadWallet: 'Paper copies follow a Hyperliquid wallet: 0x followed by 40 characters.',
  paperMax: 'This chat already has 3 paper copies running. They end after 30 days.',
  paperFull: 'Paper copies are at their limit for now (it is a hackathon prototype). Try again later.',
  paperList: 'Paper copies in this chat:',
  paperItem: (t, url) => `${short(t.lead)}: ${t.settings.mode === 'fm' ? 'fixed margin' : 'fixed ratio'} ${usd(t.settings.amount)}, ${t.settings.lev}x ${t.settings.marginMode}. ${url}`,
  paperMade: (t, url) => `Paper copy started: ${short(t.lead)}, fixed margin ${usd(t.settings.amount)} per entry, ${t.settings.lev}x isolated, on a ${usd(t.settings.start)} paper account, counted from 14 days ago.\n${url}\nThe page replays the wallet's real trades each time you open it; a summary arrives here daily at 08:00 Brisbane time. Change the settings on the page.`,
  unwatched: label => `Stopped watching ${label}.`,
  unwatchNone: 'That account isn\'t watched here. /status lists what is.',
  settingsBad: 'Use /settings liq=5 (a whole number from 1 to 20). Alerts fire when a copy is within that % of its liquidation price.',
  settingsOk: n => `Liquidation alerts now fire within ${n}% of the liquidation price (and again at 2%).`,
  watchHead: 'Watching:',
  watchLine: (label, subs, open) => subs.length
    ? `${label}: ${subs.map(s => `copying ${short(s.leadId)} (${s.mode} ${usd(s.amount)})`).join('; ')}, ${open} open ${open === 1 ? 'copy' : 'copies'}.`
    : `${label}: no active copies yet; the copy list can lag up to 10 minutes.`,
  watchTail: 'Alerts cover changes from now on, checked about every 2 minutes. /status shows the open copies.',
  statusHead: label => `${label}`,
  statusNone: 'no open copies.',
  statusLine: p => `${mkt(p.market)} ${p.side} ${p.leverage}x: P&L ${usd(p.pnl, true)}, ${p.dist == null ? 'no liquidation price' : `${pct(p.dist)} from liquidation`}${p.leadId ? `, lead ${short(p.leadId)}` : ''}`,
  statusTail: liq => `Liquidation alerts at ${liq}% and 2%. Data from Strike's public API; the copy list can lag up to 10 minutes.`,
  langSet: 'Language set to English. /lang zh switches to 简体中文, /lang tw to 繁體中文.',
  langBad: 'Use /lang en (English), /lang zh (简体中文) or /lang tw (繁體中文).',
  dailyHead: 'Daily paper copy update:',
  trialLine: (t, r, since, page) => {
    const s = t.settings, mode = s.mode === 'fm' ? `fixed margin ${usd(s.amount)}` : `fixed ratio ${usd(s.amount)}`;
    return `Paper copy of ${short(t.lead)} (${mode}, ${s.lev}x ${s.marginMode}): ${usd(r.net, true)} since ${since}, biggest drop ${usd(r.dd)}, ` +
      `${r.liquidations} liquidation${r.liquidations === 1 ? '' : 's'}, ${r.taken} entries copied. ${page}${t.id}`;
  },
  trialBusy: (t, page) => `Paper copy of ${short(t.lead)}: Hyperliquid was busy, so no update today. ${page}${t.id}`,
};

const OFF_HOURS = "This is a stock or commodity: when its home exchange is closed, Strike's price keeps moving and can jump when the exchange reopens.";

/** Alert wording. Each takes the facts and returns plain text. */
export const A = {
  A1: (label, c, dist, offHours) =>
    `⚠️ ${label}: the ${mkt(c.market)} ${c.side} copy is ${pct(dist)} from liquidation (mark ${px(c.mark)}, liquidation ${px(c.liq)}). ` +
    `Options: add margin to this position in Strike, reduce it, or leave it.${offHours ? ' ' + OFF_HOURS : ''}`,
  A2: (label, c, why) =>
    `${label}: the ${mkt(c.market)} ${c.side} copy is still open, but the lead ${short(c.leadId)} ${why.flip ? `is now ${why.flip} instead` : `no longer holds ${mkt(c.market)}`}. ` +
    'Strike doesn\'t always close a copy the lead has left. Options: close it in Strike, or keep it as your own position.',
  A2liq: (label, c) =>
    `${label}: the lead ${short(c.leadId)} was liquidated on ${mkt(c.market)}. Check whether this copy closed; it still shows open.`,
  A3: (label, leadId, sym, side) =>
    `${label}: the lead ${short(leadId)} opened or added a ${side} in ${mkt(sym)} more than 10 minutes ago and this account has no copy fill for it (likely caps, balance or a leverage lock). ` +
    'Options: check the copy settings in Strike, or leave it.',
  A4: (leadId, dex, ratio) =>
    `The lead ${short(leadId)} is close to liquidation on Hyperliquid${dex === 'main' ? '' : ' (stocks and commodities)'}: maintenance margin is ${pct(ratio * 100)} of account value, and Hyperliquid liquidates at 100%. ` +
    'If they are liquidated, copies of those positions may stay open.',
  A5: (leadId, out, before) =>
    `The lead ${short(leadId)} moved ${usd(out)} out of their Hyperliquid account in the last day (it held about ${usd(before)}). ` +
    'With fixed ratio, copy sizes follow the lead\'s equity, so later copies can change size.',
  A6fill: (label, f, kind) =>
    `${label}: a ${mkt(f.symbol)} copy was closed by ${kind === 'adl' ? 'auto-deleverage (ADL)' : 'liquidation'} (${day(f.ts)}${f.pnl ? `, P&L ${usd(f.pnl, true)}` : ''}).`,
  A7: (label, c, dist, lp, leadDist, toMatch, added) =>
    `${label}: the ${mkt(c.market)} ${c.side} copy would be liquidated before the lead's own position. ` +
    `Copy: ${c.leverage}x, liquidation ${px(c.liq)} (${pct(dist)} away). The lead ${short(c.leadId)}: ${lp.lev}x isolated${added ? ' with margin added' : ''}, liquidation ${px(lp.liqPx)} (${pct(leadDist)} away). ` +
    (added ? 'Strike copies the lead\'s leverage setting, not margin they add to a position later. ' : '') +
    `Options: ${toMatch ? `add about ${usd(toMatch)} margin to this position in Strike to bring its liquidation price close to the lead's, ` : 'add margin to this position in Strike, '}or leave it.`,
  A6sub: (label, leadId, status) =>
    `${label}: the copy of ${short(leadId)} is now ${status} on Strike's copy list.`,
};
