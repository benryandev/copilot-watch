import test from 'node:test'; import assert from 'node:assert/strict';
import { resolveWatchTarget } from '../src/resolve.js'; import { fakeStrike, ADDR } from './helpers.js';

test('addr1 → main and every sub', async () => {
  const r = await resolveWatchTarget(`  ${ADDR.toUpperCase()} `, undefined, { strike: fakeStrike() });
  assert.deepEqual(r.accounts.map(a => a.label), ['Tester (main)', 'Tester / Sub1', 'Tester / Demo']);
});
test('two subs with the same name → ambiguous_sub', async () => {
  const strike = fakeStrike({ accountByAddress: async () => ({ accountId: 'm', nickname: null, subs: [{ id: 'a', name: 'Sub1' }, { id: 'b', name: 'Sub1' }] }) });
  assert.equal((await resolveWatchTarget(ADDR, 'Sub1', { strike })).reason, 'ambiguous_sub');
});
test('sub picked by name, case-insensitive', async () => {
  const r = await resolveWatchTarget(ADDR, 'demo', { strike: fakeStrike() });
  assert.deepEqual(r.accounts, [{ accountId: 'acc-sub2', label: 'Tester / Demo' }]);
});
test('nickname not found → not_found; email-only account by nickname works', async () => {
  assert.equal((await resolveWatchTarget('@nobody', undefined, { strike: fakeStrike() })).reason, 'not_found');
  const r = await resolveWatchTarget('@Tester', undefined, { strike: fakeStrike() });
  assert.equal(r.ok, true); assert.equal(r.accounts.length, 3);
});
test('UUID of a sub → that sub only, labelled with its name', async () => {
  const strike = fakeStrike({ accountById: async () => ({ accountId: '01a07991-b1a0-7a47-8843-050162be1085', name: 'Sub1', isSub: true, subs: [] }) });
  const r = await resolveWatchTarget('01A07991-B1A0-7A47-8843-050162BE1085', undefined, { strike });
  assert.deepEqual(r.accounts, [{ accountId: '01a07991-b1a0-7a47-8843-050162be1085', label: 'Sub1' }]);
});
test('bad input', async () => {
  for (const s of ['0xabc', '', 'x'.repeat(5000), 'a b', '<script>']) assert.equal((await resolveWatchTarget(s, undefined, { strike: fakeStrike() })).reason, 'bad_input', s.slice(0, 20));
});
