// /watch identifier → Strike accounts (main and active subs). Public reads only.

export const RE = {
  addr1: /^addr1[0-9a-z]{50,110}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  nick: /^@?[A-Za-z0-9_.-]{2,32}$/,
};

const mainLabel = nick => (nick ? `${nick} (main)` : 'Main account');
const subLabel = (nick, name) => (nick ? `${nick} / ${name}` : name || 'Sub-account');

/**
 * @returns {Promise<{ok: true, accounts: {accountId: string, label: string}[]} | {ok: false, reason: 'not_found'|'ambiguous_sub'|'sub_not_found'|'bad_input', names?: string[]}>}
 */
export async function resolveWatchTarget(input, subName, { strike }) {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 120) return { ok: false, reason: 'bad_input' };
  const id = raw.toLowerCase();
  if (/^0x[0-9a-f]*$/.test(id)) return { ok: false, reason: 'bad_input', hl: id.length === 42 };
  let main = null; // {accountId, nickname, subs}
  if (RE.addr1.test(id)) {
    main = await strike.accountByAddress(id);
  } else if (RE.uuid.test(id)) {
    const a = await strike.accountById(id);
    if (!a) return { ok: false, reason: 'not_found' };
    if (a.isSub) return { ok: true, accounts: [{ accountId: a.accountId, label: a.name || 'Sub-account' }] };
    main = { accountId: a.accountId, nickname: a.nickname, subs: a.subs };
  } else if (RE.nick.test(raw)) {
    const n = await strike.accountByNickname(raw);
    if (n) { const a = await strike.accountById(n.accountId); main = { accountId: n.accountId, nickname: n.nickname || raw.replace(/^@/, ''), subs: a?.subs || [] }; }
  } else return { ok: false, reason: 'bad_input' };
  if (!main) return { ok: false, reason: 'not_found' };

  if (subName) {
    const want = String(subName).trim().toLowerCase();
    if (want === 'main') return { ok: true, accounts: [{ accountId: main.accountId, label: mainLabel(main.nickname) }] };
    const hits = main.subs.filter(s => (s.name || '').toLowerCase() === want);
    if (hits.length > 1) return { ok: false, reason: 'ambiguous_sub' };
    if (!hits.length) return { ok: false, reason: 'sub_not_found', names: main.subs.map(s => s.name) };
    return { ok: true, accounts: [{ accountId: hits[0].id, label: subLabel(main.nickname, hits[0].name) }] };
  }
  return { ok: true, accounts: [
    { accountId: main.accountId, label: mainLabel(main.nickname) },
    ...main.subs.map(s => ({ accountId: s.id, label: subLabel(main.nickname, s.name) })),
  ] };
}
