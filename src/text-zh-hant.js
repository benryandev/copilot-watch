// Traditional Chinese wording (Taiwan / Hong Kong usage), same keys and arguments as T and A in text.js.
// Localized, not converted from the simplified text: 帳戶, 設定, 指令, 預設, 伺服器, 訊息, 布里斯本.
// Terms: 跟單 = copy, 帶單員 = lead, 強平 = liquidation, 保證金 = margin, 逐倉/全倉 = isolated/cross, 子帳戶 = sub-account.
import { short, usd, pct, px, mkt } from './text.js';

export const DISCLAIMER_HANT = '不構成投資建議。與 Strike Finance 無關聯。';
const side = s => (s === 'long' ? '多單' : s === 'short' ? '空單' : s || '');
const margin = m => (m === 'isolated' ? '逐倉' : m === 'cross' ? '全倉' : m || '');
const mode = m => (m === 'fixed ratio' || m === 'fr' ? '固定比例' : '固定保證金');
export const dayHant = ts => new Date(ts).toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', timeZone: 'UTC' });

export const TH = {
  start: 'Copilot Watch 會針對 Strike 的跟單交易發送提醒。它只讀取公開資料，絕不會向你索取金鑰。\n\n' +
    '傳送 /watch 加上 Strike 地址（addr1…）、暱稱或子帳戶 ID。在地址後面加上子帳戶名稱，就可以只關注這個子帳戶，例如 /watch addr1… Sub1。\n\n' +
    '提醒內容：跟單倉位接近強平、帶單員已經平倉但跟單仍在持有、帶單員的交易沒有被跟單、跟單倉位會比帶單員更早被強平、帶單員用掉了大部分保證金、帶單員轉走了大部分資金，以及跟單倉位被強平。\n\n' +
    '指令：/status、/settings liq=5、/unwatch <帳戶>、/paper <0x 錢包>（先用模擬跟單試試看）、/lang en（切換為英文）、/stop。\n\n' +
    '我們保存的內容：本聊天的 ID、你關注的帳戶，以及最近看到的成交紀錄。/stop 會全部刪除。' + DISCLAIMER_HANT,
  help: '指令：\n/watch <addr1、暱稱或子帳戶 ID> [子帳戶名稱]\n/status：目前的跟單倉位，以及各自距離強平還有多遠\n/settings liq=5：跟單倉位距離強平價格在這個百分比以內時提醒（1 到 20）\n/unwatch <帳戶>：停止關注某個帳戶\n/paper <0x 錢包> [金額]：模擬跟單一個 Hyperliquid 錢包（不用真錢）\n/lang en|zh|tw：切換語言（English、简体中文或繁體中文）\n/stop：停止所有提醒，並刪除本聊天的資料\n\n子帳戶 ID：在 Strike App 的子帳戶頁面，Account ID 欄位，點複製按鈕。',
  dmOnly: 'Copilot Watch 只能在私訊中使用。請和機器人開啟私訊，然後傳送 /start。',
  rate: '指令太頻繁了，請一分鐘後再試。',
  full: 'Copilot Watch 目前關注的聊天數量已達上限（這是一個黑客松原型）。請稍後再試。',
  badInput: '這看起來不像 Strike 地址（addr1…）、暱稱或帳戶 ID。傳送 /help 查看範例。',
  hlAddr: '這是一個 Hyperliquid 錢包。/watch 需要的是跟單它的 Strike 帳戶：地址（addr1…）、暱稱或子帳戶 ID。',
  notFound: '找不到對應的 Strike 帳戶。請檢查拼寫，或改用地址（addr1…），或子帳戶頁面上的帳戶 ID。',
  ambiguousSub: '有兩個子帳戶同名。請在 Strike 的子帳戶頁面複製這個子帳戶的 Account ID，然後傳送 /watch <id>。',
  subNotFound: names => `找不到這個名稱的有效子帳戶。這個地址下的子帳戶：${names.length ? names.join('、') : '無'}。`,
  tooMany: '本聊天已經關注了 5 個帳戶。請先使用 /unwatch <帳戶>。',
  tooManyForUser: '你已經在 3 個頻道中使用 Copilot Watch。請先在其中一個頻道使用 /stop。',
  tooManyChannels: '這個伺服器已經在 3 個頻道中使用 Copilot Watch。請先在其中一個頻道使用 /stop。',
  strikeDown: '暫時無法連線到 Strike。請一分鐘後再試。',
  notOwner: '只有設定這個提醒的人，或擁有「管理伺服器」權限的成員，才能修改。',
  nothingWatched: '這裡還沒有關注任何帳戶。傳送 /watch 加上 Strike 地址、暱稱或子帳戶 ID。',
  stopped: '已停止。本聊天的關注、模擬跟單和保存的資料都已刪除。',
  paperHelp: '在真正跟單之前，先模擬跟單一個 Hyperliquid 錢包：/paper <0x 錢包> [帳戶金額，預設 1000]。它會從 14 天前開始計算，所以馬上就有數據，之後會跟隨這個錢包的真實交易。不用真錢，也不需要金鑰。只傳送 /paper 會列出本聊天的模擬跟單。',
  paperBadWallet: '模擬跟單的對象是 Hyperliquid 錢包：0x 加 40 個字元。',
  paperMax: '本聊天已經有 3 個模擬跟單在執行中。它們會在 30 天後結束。',
  paperFull: '模擬跟單數量目前已達上限（這是一個黑客松原型）。請稍後再試。',
  paperList: '本聊天的模擬跟單：',
  paperItem: (t, url) => `${short(t.lead)}：${mode(t.settings.mode)} ${usd(t.settings.amount)}，${t.settings.lev} 倍${margin(t.settings.marginMode)}。${url}`,
  paperMade: (t, url) => `模擬跟單已開始：${short(t.lead)}，每筆開倉固定保證金 ${usd(t.settings.amount)}，${t.settings.lev} 倍逐倉，模擬帳戶 ${usd(t.settings.start)}，從 14 天前開始計算。\n${url}\n每次打開頁面都會重新回放這個錢包的真實交易；每天布里斯本時間 08:00 會在這裡收到一份摘要。可以在頁面上修改設定。`,
  unwatched: label => `已停止關注 ${label}。`,
  unwatchNone: '這裡沒有關注這個帳戶。/status 會列出已關注的帳戶。',
  settingsBad: '請使用 /settings liq=5（1 到 20 的整數）。跟單倉位距離強平價格在這個百分比以內時會提醒。',
  settingsOk: n => `跟單倉位距離強平價格 ${n}% 以內時會提醒（到 2% 時會再提醒一次）。`,
  watchHead: '正在關注：',
  watchLine: (label, subs, open) => subs.length
    ? `${label}：${subs.map(s => `跟單 ${short(s.leadId)}（${mode(s.mode)} ${usd(s.amount)}）`).join('；')}，${open} 個跟單倉位。`
    : `${label}：還沒有進行中的跟單；跟單清單最多可能延遲 10 分鐘。`,
  watchTail: '從現在起的變化都會提醒，大約每 2 分鐘檢查一次。/status 會顯示目前的跟單倉位。',
  statusHead: label => `${label}`,
  statusNone: '沒有跟單倉位。',
  statusLine: p => `${mkt(p.market)} ${side(p.side)} ${p.leverage} 倍：損益 ${usd(p.pnl, true)}，${p.dist == null ? '沒有強平價格' : `距離強平 ${pct(p.dist)}`}${p.leadId ? `，帶單員 ${short(p.leadId)}` : ''}`,
  statusTail: liq => `在 ${liq}% 和 2% 時提醒強平風險。資料來自 Strike 的公開 API；跟單清單最多可能延遲 10 分鐘。`,
  langSet: '語言已切換為繁體中文。傳送 /lang en 可切換回英文，/lang zh 可切換為简体中文。',
  langBad: '請使用 /lang en（English）、/lang zh（简体中文）或 /lang tw（繁體中文）。',
  dailyHead: '每日模擬跟單更新：',
  trialLine: (t, r, since, page) => `${short(t.lead)} 的模擬跟單（${mode(t.settings.mode)} ${usd(t.settings.amount)}，${t.settings.lev} 倍${margin(t.settings.marginMode)}）：自 ${since} 起 ${usd(r.net, true)}，最大回撤 ${usd(r.dd)}，強平 ${r.liquidations} 次，已跟單 ${r.taken} 筆開倉。${page}${t.id}`,
  trialBusy: (t, page) => `${short(t.lead)} 的模擬跟單：Hyperliquid 目前繁忙，今天沒有更新。${page}${t.id}`,
};

const OFF_HOURS_HANT = '這是股票或商品合約：相關標的市場收盤後，Strike 上的價格仍可能變動，並可能在市場重新開盤時出現跳空。';
const why2 = (c, why) => (why.flip ? `現在持有的是${side(why.flip)}` : `已不再持有 ${mkt(c.market)}`);

export const AH = {
  A1: (label, c, dist, offHours) =>
    `⚠️ ${label}：你的 ${mkt(c.market)} ${side(c.side)}跟單倉位距離強平 ${pct(dist)}（標記價格 ${px(c.mark)}，強平價格 ${px(c.liq)}）。` +
    `你可以在 Strike 中為該倉位追加保證金、減倉，或維持現狀。${offHours ? OFF_HOURS_HANT : ''}`,
  A2: (label, c, why) =>
    `${label}：你的 ${mkt(c.market)} ${side(c.side)}跟單倉位仍處於開倉狀態，但帶單員 ${short(c.leadId)} ${why2(c, why)}。` +
    '帶單員平倉後，Strike 不一定會同步平掉你的跟單倉位。你可以選擇在 Strike 中平倉，或繼續持有該倉位並自行管理。',
  A2liq: (label, c) =>
    `${label}：帶單員 ${short(c.leadId)} 在 ${mkt(c.market)} 上的倉位已被強平，但你的跟單倉位仍顯示為持倉中。請在 Strike 中確認它是否已經平倉。`,
  A3: (label, leadId, sym, sd) =>
    `${label}：帶單員 ${short(leadId)} 在 10 多分鐘前於 ${mkt(sym)} 開了或加了${side(sd)}，但這個帳戶沒有對應的跟單成交（可能是上限、餘額或槓桿鎖定）。` +
    '你可以在 Strike 中檢查跟單設定，或維持現狀。',
  A4: (leadId, dex, ratio) =>
    `帶單員 ${short(leadId)} 在 Hyperliquid 上的${dex === 'main' ? '' : '股票及商品'}倉位正接近強平。目前維持保證金比例為 ${pct(ratio * 100)}，達到 100% 時將觸發強平。` +
    '如果帶單員被強平，相關倉位的跟單可能仍會保持開倉狀態。',
  A5: (leadId, out, before) =>
    `帶單員 ${short(leadId)} 在過去一天從 Hyperliquid 帳戶轉出了 ${usd(out)}（原本約有 ${usd(before)}）。` +
    '在固定比例模式下，跟單規模會跟隨帶單員的權益，所以之後的跟單規模可能會改變。',
  A6fill: (label, f, kind) =>
    `${label}：一筆 ${mkt(f.symbol)} 跟單倉位因${kind === 'adl' ? '自動減倉（ADL）' : '強平'}而平倉（${dayHant(f.ts)}${f.pnl ? `，損益：${usd(f.pnl, true)}` : ''}）。`,
  A7: (label, c, dist, lp, leadDist, toMatch, added) =>
    `${label}：你的 ${mkt(c.market)} ${side(c.side)}跟單倉位會比帶單員自己的倉位更早被強平。\n` +
    `你的跟單倉位：${c.leverage} 倍槓桿，強平價格為 ${px(c.liq)}（距離強平價格 ${pct(dist)}）。\n` +
    `帶單員 ${short(c.leadId)}：${lp.lev} 倍逐倉${added ? '，且已追加保證金' : ''}，強平價格為 ${px(lp.liqPx)}（距離強平價格 ${pct(leadDist)}）。\n` +
    (added ? 'Strike 會複製帶單員的槓桿設定，但不會自動複製其之後追加到倉位中的保證金。\n' : '') +
    (toMatch ? `你可以考慮在 Strike 中為該倉位追加約 ${usd(toMatch)} 的保證金，讓強平價格更接近帶單員的水準；也可以維持現狀。`
      : '你可以考慮在 Strike 中為該倉位追加保證金，讓強平價格離目前價格更遠；也可以維持現狀。'),
  A6sub: (label, leadId, status) =>
    `${label}：Strike 的跟單清單現已將你對帶單員 ${short(leadId)} 的跟單倉位標示為${status === 'liquidated' ? '已強平' : status === 'stopped' ? '已停止' : status}。`,
};
