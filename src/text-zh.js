// Simplified Chinese wording, same keys and arguments as T and A in text.js. Same rule: state what happened and the plain options.
// Terms: 跟单 = copy, 带单员 = lead, 强平 = liquidation, 保证金 = margin, 逐仓/全仓 = isolated/cross, 子账户 = sub-account.
import { short, usd, pct, px, mkt } from './text.js';

export const DISCLAIMER_ZH = '不构成投资建议。与 Strike Finance 无关联。';
const side = s => (s === 'long' ? '多单' : s === 'short' ? '空单' : s || '');
const margin = m => (m === 'isolated' ? '逐仓' : m === 'cross' ? '全仓' : m || '');
const mode = m => (m === 'fixed ratio' || m === 'fr' ? '固定比例' : '固定保证金');
export const dayZh = ts => new Date(ts).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'UTC' });

export const TZ = {
  start: 'Copilot Watch 会就 Strike 的跟单交易发送提醒。它只读取公开数据，绝不会向你索要密钥。\n\n' +
    '发送 /watch 加上 Strike 地址（addr1…）、昵称或子账户 ID。在地址后面加上子账户名称，可以只关注这个子账户，例如 /watch addr1… Sub1。\n\n' +
    '提醒内容：跟单仓位接近强平、带单员已经平仓但跟单仍在持有、带单员的交易没有被跟单、跟单仓位会比带单员更早被强平、带单员用掉了大部分保证金、带单员转走了大部分资金，以及跟单仓位被强平。\n\n' +
    '命令：/status、/settings liq=5、/unwatch <账户>、/paper <0x 钱包>（先用模拟跟单试一试）、/lang en（切换到英文）、/stop。\n\n' +
    '我们保存的内容：本聊天的 ID、你关注的账户和最近看到的成交记录。/stop 会全部删除。' + DISCLAIMER_ZH,
  help: '命令：\n/watch <addr1、昵称或子账户 ID> [子账户名称]\n/status：当前的跟单仓位，以及各自距离强平还有多远\n/settings liq=5：跟单仓位距离强平价在这个百分比以内时提醒（1 到 20）\n/unwatch <账户>：停止关注某个账户\n/paper <0x 钱包> [金额]：模拟跟单一个 Hyperliquid 钱包（不用真钱）\n/lang en|zh|tw：切换语言（English、简体中文或繁體中文）\n/stop：停止全部提醒，并删除本聊天的数据\n\n子账户 ID：在 Strike 应用的子账户页面，Account ID 一栏，点复制按钮。',
  dmOnly: 'Copilot Watch 只能在私聊中使用。请和机器人开一个私聊，然后发送 /start。',
  rate: '命令太频繁了，请一分钟后再试。',
  full: 'Copilot Watch 目前关注的聊天数量已达上限（这是一个黑客松原型）。请稍后再试。',
  badInput: '这看起来不像 Strike 地址（addr1…）、昵称或账户 ID。发送 /help 查看示例。',
  hlAddr: '这是一个 Hyperliquid 钱包。/watch 需要的是跟单它的 Strike 账户：地址（addr1…）、昵称或子账户 ID。',
  notFound: '没有找到对应的 Strike 账户。请检查拼写，或者使用地址（addr1…），或子账户页面上的账户 ID。',
  ambiguousSub: '有两个子账户同名。请在 Strike 的子账户页面复制这个子账户的 Account ID，然后发送 /watch <id>。',
  subNotFound: names => `没有找到这个名称的活跃子账户。这个地址下的子账户：${names.length ? names.join('、') : '无'}。`,
  tooMany: '本聊天已经关注了 5 个账户。请先使用 /unwatch <账户>。',
  tooManyForUser: '你已经在 3 个频道中使用 Copilot Watch。请先在其中一个频道使用 /stop。',
  tooManyChannels: '这个服务器已经在 3 个频道中使用 Copilot Watch。请先在其中一个频道使用 /stop。',
  strikeDown: '暂时无法连接 Strike。请一分钟后再试。',
  notOwner: '只有设置这个提醒的人，或者拥有“管理服务器”权限的成员，才能修改。',
  nothingWatched: '这里还没有关注任何账户。发送 /watch 加上 Strike 地址、昵称或子账户 ID。',
  stopped: '已停止。本聊天的关注、模拟跟单和保存的数据都已删除。',
  paperHelp: '在真正跟单之前，先模拟跟单一个 Hyperliquid 钱包：/paper <0x 钱包> [账户金额，默认 1000]。它从 14 天前开始计算，所以马上就有数据，之后会跟随这个钱包的真实交易。不用真钱，也不需要密钥。只发送 /paper 会列出本聊天的模拟跟单。',
  paperBadWallet: '模拟跟单的对象是 Hyperliquid 钱包：0x 加 40 个字符。',
  paperMax: '本聊天已经有 3 个模拟跟单在运行。它们会在 30 天后结束。',
  paperFull: '模拟跟单数量目前已达上限（这是一个黑客松原型）。请稍后再试。',
  paperList: '本聊天的模拟跟单：',
  paperItem: (t, url) => `${short(t.lead)}：${mode(t.settings.mode)} ${usd(t.settings.amount)}，${t.settings.lev} 倍${margin(t.settings.marginMode)}。${url}`,
  paperMade: (t, url) => `模拟跟单已开始：${short(t.lead)}，每笔开仓固定保证金 ${usd(t.settings.amount)}，${t.settings.lev} 倍逐仓，模拟账户 ${usd(t.settings.start)}，从 14 天前开始计算。\n${url}\n每次打开页面都会重新回放这个钱包的真实交易；每天布里斯班时间 08:00 会在这里收到一份摘要。可以在页面上修改设置。`,
  unwatched: label => `已停止关注 ${label}。`,
  unwatchNone: '这里没有关注这个账户。/status 会列出已关注的账户。',
  settingsBad: '请使用 /settings liq=5（1 到 20 的整数）。跟单仓位距离强平价在这个百分比以内时会提醒。',
  settingsOk: n => `跟单仓位距离强平价 ${n}% 以内时会提醒（到 2% 时会再提醒一次）。`,
  watchHead: '正在关注：',
  watchLine: (label, subs, open) => subs.length
    ? `${label}：${subs.map(s => `跟单 ${short(s.leadId)}（${mode(s.mode)} ${usd(s.amount)}）`).join('；')}，${open} 个跟单仓位。`
    : `${label}：还没有进行中的跟单；跟单列表最多可能延迟 10 分钟。`,
  watchTail: '从现在起的变化都会提醒，大约每 2 分钟检查一次。/status 显示当前的跟单仓位。',
  statusHead: label => `${label}`,
  statusNone: '没有跟单仓位。',
  statusLine: p => `${mkt(p.market)} ${side(p.side)} ${p.leverage} 倍：盈亏 ${usd(p.pnl, true)}，${p.dist == null ? '没有强平价' : `距离强平 ${pct(p.dist)}`}${p.leadId ? `，带单员 ${short(p.leadId)}` : ''}`,
  statusTail: liq => `在 ${liq}% 和 2% 时提醒强平风险。数据来自 Strike 的公开 API；跟单列表最多可能延迟 10 分钟。`,
  langSet: '语言已切换为简体中文。发送 /lang en 可切换回英文，/lang tw 可切换为繁體中文。',
  langBad: '请使用 /lang en（English）、/lang zh（简体中文）或 /lang tw（繁體中文）。',
  dailyHead: '每日模拟跟单更新：',
  trialLine: (t, r, since, page) => `${short(t.lead)} 的模拟跟单（${mode(t.settings.mode)} ${usd(t.settings.amount)}，${t.settings.lev} 倍${margin(t.settings.marginMode)}）：自 ${since} 起 ${usd(r.net, true)}，最大回撤 ${usd(r.dd)}，强平 ${r.liquidations} 次，已跟单 ${r.taken} 笔开仓。${page}${t.id}`,
  trialBusy: (t, page) => `${short(t.lead)} 的模拟跟单：Hyperliquid 繁忙，今天没有更新。${page}${t.id}`,
};

const OFF_HOURS_ZH = '这是股票或商品合约：相关标的市场收盘后，Strike 上的价格仍可能变动，并可能在市场重新开盘时出现跳空。';

const why2 = (c, why) => (why.flip ? `现在持有的是${side(why.flip)}` : `已不再持有 ${mkt(c.market)}`);

export const AZ = {
  A1: (label, c, dist, offHours) =>
    `⚠️ ${label}：你的 ${mkt(c.market)} ${side(c.side)}跟单仓位距离强平 ${pct(dist)}（标记价格 ${px(c.mark)}，强平价格 ${px(c.liq)}）。` +
    `你可以在 Strike 中为该仓位追加保证金、减仓，或保持现状。${offHours ? OFF_HOURS_ZH : ''}`,
  A2: (label, c, why) =>
    `${label}：你的 ${mkt(c.market)} ${side(c.side)}跟单仓位仍处于开仓状态，但带单员 ${short(c.leadId)} ${why2(c, why)}。` +
    '带单员平仓后，Strike 不一定会同步平掉你的跟单仓位。你可以选择在 Strike 中平仓，或继续持有该仓位并自行管理。',
  A2liq: (label, c) =>
    `${label}：带单员 ${short(c.leadId)} 在 ${mkt(c.market)} 上的仓位已被强平，但你的跟单仓位仍显示为持仓中。请在 Strike 中检查它是否已经平仓。`,
  A3: (label, leadId, sym, sd) =>
    `${label}：带单员 ${short(leadId)} 在 10 多分钟前于 ${mkt(sym)} 开了或加了${side(sd)}，但这个账户没有对应的跟单成交（可能是上限、余额或杠杆锁定）。` +
    '你可以在 Strike 中检查跟单设置，或保持现状。',
  A4: (leadId, dex, ratio) =>
    `带单员 ${short(leadId)} 在 Hyperliquid 上的${dex === 'main' ? '' : '股票及商品'}仓位正接近强平。目前维持保证金比例为 ${pct(ratio * 100)}，达到 100% 时将触发强平。` +
    '如果带单员被强平，相关仓位的跟单可能仍会保持开仓状态。',
  A5: (leadId, out, before) =>
    `带单员 ${short(leadId)} 在过去一天从 Hyperliquid 账户转出了 ${usd(out)}（原来约有 ${usd(before)}）。` +
    '在固定比例模式下，跟单规模跟随带单员的权益，所以之后的跟单规模可能会变化。',
  A6fill: (label, f, kind) =>
    `${label}：一笔 ${mkt(f.symbol)} 跟单仓位因${kind === 'adl' ? '自动减仓（ADL）' : '强平'}而平仓（${dayZh(f.ts)}${f.pnl ? `，盈亏：${usd(f.pnl, true)}` : ''}）。`,
  A7: (label, c, dist, lp, leadDist, toMatch, added) =>
    `${label}：你的 ${mkt(c.market)} ${side(c.side)}跟单仓位会比带单员自己的仓位更早被强平。\n` +
    `你的跟单仓位：${c.leverage} 倍杠杆，强平价格为 ${px(c.liq)}（距离强平价格 ${pct(dist)}）。\n` +
    `带单员 ${short(c.leadId)}：${lp.lev} 倍逐仓${added ? '，且已追加保证金' : ''}，强平价格为 ${px(lp.liqPx)}（距离强平价格 ${pct(leadDist)}）。\n` +
    (added ? 'Strike 会复制带单员的杠杆设置，但不会自动复制其之后追加到仓位中的保证金。\n' : '') +
    (toMatch ? `你可以考虑在 Strike 中为该仓位追加约 ${usd(toMatch)} 的保证金，让强平价格更接近带单员的水平；也可以保持现状。`
      : '你可以考虑在 Strike 中为该仓位追加保证金，让强平价格离当前价格更远；也可以保持现状。'),
  A6sub: (label, leadId, status) =>
    `${label}：Strike 的跟单列表现已将你对带单员 ${short(leadId)} 的跟单仓位标记为${status === 'liquidated' ? '已强平' : status === 'stopped' ? '已停止' : status}。`,
};
