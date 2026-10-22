import test from 'node:test'; import assert from 'node:assert/strict';
import { detectAlerts, findOrphans } from '../src/alerts.js';

const L = '0xlead000000000000000000000000000000000001';
const mk = { 'BTC-USD': { hl: 'BTC', tiers: [[1e18, 10, 0.025, 0]] }, 'XAU-USD': { hl: 'xyz:GOLD', tiers: [[1e18, 10, 0.025, 0]] }, 'NIGHT-USD': { hl: null, tiers: [[1e18, 10, 0.025, 0]] } };
const NOW = Date.UTC(2026, 9, 22, 3, 0);
const copy = (market, side, o = {}) => ({ subId: 's1', leadId: L, market, side, mark: 100, liq: 50, ...o });
const leadState = (positions = [], o = {}) => ({ ch: { main: { accountValue: 1000, marginUsed: 100, maintUsed: 10, positions: positions.filter(p => !p.coin.startsWith('xyz:')) }, xyz: { accountValue: 0, marginUsed: 0, positions: positions.filter(p => p.coin.startsWith('xyz:')) } }, fills: [], withdrawn24h: 0, accountValue: 1000, ...o });
const snap = (o = {}) => ({ accountId: 'acc', label: 'Sub1', at: NOW, since: NOW - 3600_000, copies: [], subs: { [L]: { status: 'active' } }, fills: [], orphans: [], ...o });
const run = (prev, cur, leads = {}, liq = 5) => detectAlerts(prev, cur, { liq }, { leads, mk, now: NOW });

test('orphan alert skipped when lead snapshot is null', () => {
  const cur = snap({ copies: [copy('BTC-USD', 'long')] });
  cur.orphans = findOrphans(cur, { [L]: null }, mk);
  assert.deepEqual(cur.orphans, []);
  assert.deepEqual(run({ ...cur, orphans: ['s1:BTC-USD:long'] }, cur, { [L]: null }).filter(a => a.kind === 'A2'), []);
});
test('A1 fires at 5% and again at 2%, not at 6%', () => {
  const keys = liq => run(snap(), snap({ copies: [copy('BTC-USD', 'long', { liq })] })).filter(a => a.kind === 'A1').map(a => a.key);
  assert.deepEqual(keys(95.5), ['A1:s1:BTC-USD:long:5']);
  assert.deepEqual(keys(98.5), ['A1:s1:BTC-USD:long:5', 'A1:s1:BTC-USD:long:2']);
  assert.deepEqual(keys(94), []);
  const short = run(snap(), snap({ copies: [copy('BTC-USD', 'short', { liq: 104 })] })).filter(a => a.kind === 'A1');
  assert.equal(short.length, 1); assert.match(short[0].text, /4\.0% from liquidation \(mark 100, liquidation 104\)/);
});
test('A1 on a stock/commodity mentions market hours', () => {
  const a = run(snap(), snap({ copies: [copy('XAU-USD', 'long', { liq: 97 })] })).find(a => a.kind === 'A1');
  assert.match(a.text, /pause outside market hours/);
});
test('A2 needs two polls in a row; opposite side counts', () => {
  const leads = { [L]: leadState([{ coin: 'BTC', szi: -1 }]) };
  const cur = snap({ copies: [copy('BTC-USD', 'long')] }); cur.orphans = findOrphans(cur, leads, mk);
  assert.deepEqual(cur.orphans, ['s1:BTC-USD:long']);
  assert.equal(run(snap(), cur, leads).filter(a => a.kind === 'A2').length, 0);
  const a = run({ ...cur }, cur, leads).filter(a => a.kind === 'A2');
  assert.equal(a.length, 1); assert.match(a[0].text, /is now short instead/);
});
test('A2 lead flat; lead liquidated wording', () => {
  const flat = { [L]: leadState([]) };
  const cur = snap({ copies: [copy('BTC-USD', 'long')] }); cur.orphans = findOrphans(cur, flat, mk);
  assert.match(run(cur, cur, flat).find(a => a.kind === 'A2').text, /no longer holds BTC/);
  const liq = { [L]: leadState([], { fills: [{ coin: 'BTC', dir: 'Close Long', time: NOW - 60000, oid: 1, liquidation: { liquidatedUser: L } }] }) };
  assert.match(run(cur, cur, liq).find(a => a.kind === 'A2').text, /was liquidated on BTC/);
});
test('A2 lead still holding the same side → nothing', () => {
  const leads = { [L]: leadState([{ coin: 'BTC', szi: 2 }]) };
  const cur = snap({ copies: [copy('BTC-USD', 'long')] });
  assert.deepEqual(findOrphans(cur, leads, mk), []);
});
test('A3 waits 10 minutes and matches only its own subscription tag', () => {
  const f = (minsAgo, oid = 9) => ({ coin: 'BTC', dir: 'Open Long', time: NOW - minsAgo * 60000, oid });
  const cur = (lf, cf) => snap({ copies: [copy('BTC-USD', 'long')], fills: cf });
  assert.equal(run(snap(), cur(), { [L]: leadState([], { fills: [f(9)] }) }).filter(a => a.kind === 'A3').length, 0);
  const other = [{ id: 'x', symbol: 'BTC-USD', ts: NOW - 10.5 * 60000, copySubId: 'other-sub' }];
  const a = run(snap(), cur(null, other), { [L]: leadState([], { fills: [f(11)] }) }).filter(a => a.kind === 'A3');
  assert.equal(a.length, 1); assert.equal(a[0].key, `A3:${L}:BTC-USD:${Math.floor((NOW - 11 * 60000) / 3600000)}`); assert.match(a[0].text, /BTC long/);
  const mine = [{ id: 'y', symbol: 'BTC-USD', ts: NOW - 10.5 * 60000, copySubId: 's1' }];
  assert.equal(run(snap(), cur(null, mine), { [L]: leadState([], { fills: [f(11)] }) }).filter(a => a.kind === 'A3').length, 0);
});
test('A3 ignores closes, unlisted coins and fills before the baseline', () => {
  const lf = [{ coin: 'BTC', dir: 'Close Long', time: NOW - 15 * 60000, oid: 1 }, { coin: 'XMR', dir: 'Open Long', time: NOW - 15 * 60000, oid: 2 },
    { coin: 'BTC', dir: 'Open Long', time: NOW - 2 * 3600_000, oid: 3 }];
  assert.equal(run(snap(), snap(), { [L]: leadState([], { fills: lf }) }).filter(a => a.kind === 'A3').length, 0);
});
test('A4 margin stress and A5 withdrawal', () => {
  const busy = leadState([], { ch: { main: { accountValue: 1000, marginUsed: 1000, maintUsed: 590, positions: [] }, xyz: { accountValue: 0, marginUsed: 0, positions: [] } } });
  assert.equal(run(snap(), snap(), { [L]: busy }).filter(a => a.kind === 'A4').length, 0);
  const stressed = leadState([], { ch: { main: { accountValue: 1000, marginUsed: 1000, maintUsed: 600, positions: [] }, xyz: { accountValue: 0, marginUsed: 0, positions: [] } } });
  assert.match(run(snap(), snap(), { [L]: stressed }).find(a => a.kind === 'A4').text, /maintenance margin is 60\.0% of account value/);
  assert.equal(run(snap(), snap(), { [L]: leadState([], { withdrawn24h: 400, accountValue: 600 }) }).filter(a => a.kind === 'A5').length, 0);
  assert.match(run(snap(), snap(), { [L]: leadState([], { withdrawn24h: 700, accountValue: 300 }) }).find(a => a.kind === 'A5').text, /moved \$700 out/);
});
test('A6 from auto_close_type, grouped per symbol and minute', () => {
  const fills = [{ id: '2', symbol: 'BTC-USD', ts: NOW - 30000, autoClose: 'liquidation', pnl: -6 }, { id: '1', symbol: 'BTC-USD', ts: NOW - 31000, autoClose: 'liquidation', pnl: -4 }];
  const a = run(snap(), snap({ fills })).filter(a => a.kind === 'A6');
  assert.equal(a.length, 1); assert.match(a[0].text, /closed by liquidation .*P&L −\$10/);
});
test('A6 when the subscription is liquidated', () => {
  assert.match(run(snap(), snap({ subs: { [L]: { status: 'liquidated' } } })).find(a => a.kind === 'A6').text, /now liquidated/);
});
test('history before baseline never alerts', () => {
  const fills = [{ id: '1', symbol: 'BTC-USD', ts: NOW - 2 * 3600_000, autoClose: 'liquidation' }];
  assert.deepEqual(run(snap(), snap({ fills })), []);
  assert.deepEqual(detectAlerts(null, snap({ fills, copies: [copy('BTC-USD', 'long', { liq: 99 })] }), { liq: 5 }, { mk, now: NOW }), []);
});
test('no Strike data this round → no A1/A3/A6', () => {
  assert.deepEqual(run(snap(), snap({ copies: null, fills: null })), []);
});

test('A3 at most once per market per hour', () => {
  const fl = [0, 1, 2].map(i => ({ coin: 'BTC', dir: 'Open Long', time: NOW - (12 + i) * 60000, oid: 100 + i }));
  assert.equal(run(snap(), snap(), { [L]: leadState([], { fills: fl }) }).filter(a => a.kind === 'A3').length, 1);
});

test('alert prices are rounded to 5 significant figures', async () => {
  const { px } = await import('../src/text.js');
  assert.equal(px('386.57804342'), '386.58'); assert.equal(px('400.15301707884936'), '400.15');
  assert.equal(px('5.776850571902943691'), '5.7769'); assert.equal(px('84134'), '84134'); assert.equal(px('abc'), '?');
});

test('A7: copy liquidated before the lead, with the margin to match', () => {
  const cx = { 'CXMT-USD': { hl: 'xyz:CXMT', tiers: [[1e18, 10, 0.025, 0]] } };
  const c = copy('CXMT-USD', 'long', { mark: 6.1, liq: 5.7769, size: 476.6, leverage: 10, marginMode: 'isolated' });
  const lead = liqPx => ({ [L]: leadState([{ coin: 'xyz:CXMT', szi: 7200, value: 43920, liqPx, lev: 10, levType: 'isolated', entry: 6.588 }]) });
  const go = (cp, leads) => detectAlerts(snap(), snap({ copies: [cp] }), { liq: 5 }, { leads, mk: cx, now: NOW }).filter(a => a.kind === 'A7');
  const a = go(c, lead(5.2411));
  assert.equal(a.length, 1); assert.equal(a[0].key, 'A7:s1:CXMT-USD:long');
  assert.match(a[0].text, /CXMT long copy would be liquidated before the lead's own position/);
  assert.match(a[0].text, /liquidation 5\.7769 \(5\.3% away\)/); assert.match(a[0].text, /liquidation 5\.2411 \(14\.1% away\)/);
  assert.match(a[0].text, /add about \$255 margin/);
  assert.equal(go(c, lead(5.85)).length, 0, 'lead closer to liquidation: no alert');
  assert.equal(go(c, lead(5.70)).length, 0, 'gap under 2% of mark: no alert');
  assert.equal(go({ ...c, liq: 4.5 }, lead(4.0)).length, 0, 'copy more than 20% away: no alert');
  assert.equal(go({ ...c, side: 'short', liq: 6.5 }, lead(5.2411)).length, 0, 'lead on the other side: no alert');
  assert.equal(go(c, { [L]: null }).length, 0, 'lead unreadable: no alert');
  assert.match(a[0].text, /10x isolated with margin added/); assert.match(a[0].text, /not margin they add/);
  const plain = go({ ...c, liq: 5.9 }, { [L]: leadState([{ coin: 'xyz:CXMT', szi: 7200, value: 43920, liqPx: 5.75, lev: 10, levType: 'isolated', entry: 6.2 }]) });
  assert.equal(plain.length, 1); assert.doesNotMatch(plain[0].text, /margin added|not margin they add/);
  const crossLead = { [L]: leadState([{ coin: 'xyz:CXMT', szi: 7200, value: 43920, liqPx: 2.1, lev: 10, levType: 'cross' }]) };
  assert.equal(go(c, crossLead).length, 0, 'lead cross: account-level risk is A4, no A7');
  assert.equal(go(c, lead(null)).length, 0, 'no lead liquidation price: no alert');
  const cc = go({ ...c, marginMode: 'cross' }, lead(5.2411));
  assert.equal(cc.length, 1); assert.match(cc[0].text, /Options: add margin to this position in Strike, or leave it/);
});

// 22 Oct 2026: Demo's DRAM short copied the lead's io:DRAM short; the lead held it, but A2 said it didn't (only main/xyz were read).
test('A2: a position on another builder dex (io:DRAM) counts as the lead holding the market', () => {
  const m = { ...mk, 'DRAM-USD': { hl: 'xyz:DRAM', alt: ['io:DRAM'], tiers: [[1e18, 10, 0.025, 0]] } };
  const held = { [L]: { ...leadState([]), ch: { ...leadState([]).ch, io: { accountValue: 500, marginUsed: 50, maintUsed: 5, positions: [{ coin: 'io:DRAM', szi: -143.9 }] } } } };
  const cur = snap({ copies: [copy('DRAM-USD', 'short')] });
  cur.orphans = findOrphans(cur, held, m);
  assert.deepEqual(cur.orphans, []);
  assert.deepEqual(detectAlerts({ ...cur, orphans: ['s1:DRAM-USD:short'] }, cur, { liq: 5 }, { leads: held, mk: m, now: NOW }).filter(a => a.kind === 'A2'), []);
  // and when it really is gone from every dex, the alert names the Strike market
  const gone = { [L]: leadState([]) }; const c2 = snap({ copies: [copy('DRAM-USD', 'short')] }); c2.orphans = findOrphans(c2, gone, m);
  const a = detectAlerts({ ...c2 }, c2, { liq: 5 }, { leads: gone, mk: m, now: NOW }).filter(a => a.kind === 'A2');
  assert.equal(a.length, 1); assert.match(a[0].text, /no longer holds DRAM\b/);
});

// 22 Oct 2026: the lead was short xyz:AAOI and long para:AAOI; netting the two said "now long instead" against Demo's short copy.
test('A2: opposite positions on two dexes are not netted; the copied side still counts as held', () => {
  const m = { ...mk, 'AAOI-USD': { hl: 'xyz:AAOI', alt: ['para:AAOI'], tiers: [[1e18, 10, 0.025, 0]] } };
  const base = leadState([{ coin: 'xyz:AAOI', szi: -200 }]);
  const held = { [L]: { ...base, ch: { ...base.ch, para: { accountValue: 500, marginUsed: 50, maintUsed: 5, positions: [{ coin: 'para:AAOI', szi: 430 }] } } } };
  const cur = snap({ copies: [copy('AAOI-USD', 'short')] });
  cur.orphans = findOrphans(cur, held, m);
  assert.deepEqual(cur.orphans, []);
  assert.deepEqual(detectAlerts({ ...cur, orphans: ['s1:AAOI-USD:short'] }, cur, { liq: 5 }, { leads: held, mk: m, now: NOW }).filter(a => a.kind === 'A2'), []);
});
