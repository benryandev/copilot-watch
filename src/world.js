// The world room for the ecosystem map's multiplayer: who's driving, where, under what name.
// Pure logic, no Cloudflare types; the Durable Object shell in world-worker.js wires it to websockets.
import { cleanName } from './race.js';

export const WORLD_RADIUS = 400; // m from the world centre: anything further is not a place a car can be
export const WORLD_MAX_SPEED = 40; // m/s, above the car's top speed with a margin for a jump landing
export const WORLD_FRAME_MAX = 256; // bytes: a pose is ~50, a hi ~80

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

// ---- poses ----

const fin = v => typeof v === 'number' && Number.isFinite(v);
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const TAU = Math.PI * 2;

/** Validate and round a pose frame {x, z, h, s, j?}. Returns {ok, x, z, h, s, j} or {ok: false}. */
export function parsePose(m) {
  if (!m || typeof m !== 'object' || !fin(m.x) || !fin(m.z) || !fin(m.h) || !fin(m.s)) return { ok: false };
  if (Math.hypot(m.x, m.z) > WORLD_RADIUS || m.s < 0 || m.s > WORLD_MAX_SPEED + 0.5) return { ok: false };
  let h = m.h % TAU; if (h > Math.PI) h -= TAU; else if (h <= -Math.PI) h += TAU;
  return { ok: true, x: r1(m.x), z: r1(m.z), h: r2(h), s: Math.min(WORLD_MAX_SPEED, r1(m.s)), j: m.j === 1 || m.j === true };
}
