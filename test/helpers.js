// Fake Strike for command and poll tests (no network).
export const ADDR = 'addr1q' + 'x'.repeat(60);
export function fakeStrike(over = {}) {
  const accounts = {
    'acc-main': { accountId: 'acc-main', nickname: 'Tester', isSub: false, subs: [{ id: 'acc-sub1', name: 'Sub1' }, { id: 'acc-sub2', name: 'Demo' }] },
    'acc-sub1': { accountId: 'acc-sub1', name: 'Sub1', isSub: true, parentId: 'acc-main', subs: [] },
  };
  return {
    accountByAddress: async a => (a === ADDR ? { accountId: 'acc-main', nickname: 'Tester', subs: accounts['acc-main'].subs } : null),
    accountByNickname: async n => (n.replace(/^@/, '').toLowerCase() === 'tester' ? { accountId: 'acc-main', nickname: 'Tester' } : null),
    accountById: async id => accounts[id] || null,
    leaderboard: async () => [{ followerId: 'acc-sub1', leadId: '0xlead000000000000000000000000000000000001', mode: 'fixed margin', amount: 10, status: 'active' }],
    copyPositions: async id => (id === 'acc-sub1' ? [{ subId: 's1', leadId: '0xlead000000000000000000000000000000000001', market: 'BTC-USD', side: 'long', leverage: 3, mark: 100, liq: 70, pnl: -1.2 }] : []),
    fills: async () => [],
    ...over,
  };
}
