// The world room for the ecosystem map's multiplayer: who's driving, where, under what name.
// Pure logic, no Cloudflare types; the Durable Object shell in world-worker.js wires it to websockets.
import { cleanName } from './race.js';

// ---- names ----

// Names nobody but the owner may wear on a tag in a Strike-branded world. Compared after the same folding isRude uses.
export const RESERVED = ['ben', 'ben ryan', 'benryan', 'benryanme', 'shan', 'strike', 'strike finance', 'strikefinance', 'strike team',
  'admin', 'mod', 'moderator', 'intern'];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
const fold = s => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[013457@$!]/g, c => LEET[c] ?? c).replace(/[^a-z]/g, '');
const RESERVED_FOLDED = new Set(RESERVED.map(fold));

/** True when the name is one of the reserved names (Ben, Shan, Strike and staff-sounding words), however spelled. */
export function isReserved(name) { return RESERVED_FOLDED.has(fold(name)); }

/**
 * Pick the name a player wears. A clean, polite, unreserved name is kept (owner may use reserved ones); anything else
 * becomes "Driver NN". A name already worn in the room gets " (2)", " (3)". `taken` holds lower-cased names in use;
 * `next()` returns the next two-digit string for the fallback.
 */
export function pickName(raw, { owner = false, taken = new Set(), next = () => '01' } = {}) {
  const c = cleanName(raw);
  let name, fallback = false;
  if (c.ok && (owner || !isReserved(c.name))) name = c.name;
  else {
    fallback = true;
    name = `Driver ${next()}`;
    for (let i = 0; i < 99 && taken.has(name.toLowerCase()); i++) name = `Driver ${next()}`;
  }
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${name.replace(/ \(\d+\)$/, '')} (${n})`;
  return { name, fallback };
}
