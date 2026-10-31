// The world room for the ecosystem map's multiplayer: who's driving, where, under what name.
// Pure logic, no Cloudflare types; the Durable Object shell in world-worker.js wires it to websockets.
import { cleanName } from './race.js';

export const WORLD_VERSION = '2026-10-31.8'; // bumped on deploy so /presence shows which code the room runs
export const WORLD_OFF_KEY = 'world:off'; // any value under this KV key pauses new connections and closes live ones
export const WORLD_OFF_TTL_MS = 30_000; // how long the room trusts its last read of the kill switch

/** A cached read of the kill switch: `read()` resolves to the KV value (null when absent); re-read at most once per ttl. */
export function offChecker(read, ttl = WORLD_OFF_TTL_MS) {
  let at = -Infinity, off = false;
  return async now => {
    if (now - at >= ttl) { at = now; off = (await read()) != null; }
    return off;
  };
}

export const WORLD_RADIUS = 400; // m from the world centre: anything further is not a place a car can be
export const WORLD_MAX_SPEED = 40; // m/s, above the car's top speed with a margin for a jump landing
export const WORLD_FRAME_MAX = 256; // bytes: a pose is ~50, a hi ~80

// ---- names ----

// Names nobody but the owner may wear. Ben's call (31 Oct 2026): only his own handle, so another Ben or Shan can be
// themselves; "Ben Ryan" folds to the same letters. Compared after the same folding isRude uses.
export const RESERVED = ['benryan', 'benryanme'];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
// Cyrillic and Greek letters that look like Latin ones (lower case, applied after toLowerCase), so "Вen" is still Ben
const LOOKALIKE = { а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ё: 'e',
  α: 'a', β: 'b', ε: 'e', ζ: 'z', η: 'h', ι: 'i', κ: 'k', μ: 'm', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'y', χ: 'x' };
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKE).join('')}]`, 'gu');
const fold = s => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(LOOKALIKE_RE, c => LOOKALIKE[c]).replace(/[013457@$!]/g, c => LEET[c] ?? c).replace(/[^a-z]/g, '');
const RESERVED_FOLDED = new Set(RESERVED.map(fold));

/** True when the name is one of the reserved names (Ben, Shan, Strike and staff-sounding words), however spelled. */
export function isReserved(name) { return RESERVED_FOLDED.has(fold(name)); }

/**
 * Pick the name a player wears. A clean, polite, unreserved name is kept (owner may use reserved ones); anything else
 * becomes "Driver NN". A name already worn in the room gets " (2)", " (3)". `taken` holds lower-cased names in use;
 * `next()` returns the next two-digit string for the fallback.
 */
export function pickName(raw, { owner = false, allow = null, taken = new Set(), next = () => '01', keep = null } = {}) {
  const c = cleanName(raw);
  let name, fallback = false, reason;
  // The owner may wear any reserved name; a guest token (allow) only the folded names it was issued for
  const permitted = n => owner || !isReserved(n) || (allow instanceof Set && allow.has(fold(n)));
  if (c.ok && permitted(c.name)) name = c.name;
  else {
    fallback = true;
    reason = !c.ok ? (c.error === 'rude_name' ? 'rude' : 'bad') : 'reserved';
    // Already wearing a Driver number? Keep it, rather than handing out a new one for every refused try
    name = keep && /^Driver \d\d$/.test(keep) ? keep : `Driver ${next()}`;
    for (let i = 0; i < 99 && taken.has(name.toLowerCase()); i++) name = `Driver ${next()}`;
  }
  if (taken.has(name.toLowerCase())) reason ??= 'taken';
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${name.replace(/ \(\d+\)$/, '')} (${n})`;
  return reason ? { name, fallback, reason } : { name, fallback };
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

// ---- the room ----

export const WORLD_MAX = 200; // sockets in the room
export const WORLD_IP_MAX = 4; // sockets per client address
export const WORLD_POSE_MAX_HZ = 20; // poses per second per socket; faster ones are dropped
export const WORLD_SNAPSHOT_MS = 100; // at most one snapshot per 100 ms
export const WORLD_RENAME_SEC = 10;
export const WORLD_BAD_MAX = 3; // bad frames in a row before the socket is closed
export const WORLD_JUMP_MS = 1000; // one teleport flag per second
export const WORLD_PING_MAX_HZ = 2;
export const WORLD_FLOOD_MAX = 100; // frames dropped for rate inside 10 s before the socket is closed as a flood
export const WORLD_FLOOD_WINDOW_MS = 10_000;
export const WORLD_FLOOD_BLOCK_MS = 60_000; // a flooder's address is refused for this long
export const WORLD_IDLE_MS = 60_000; // nothing heard for this long (the client beats once a second): the socket is dead, drop it
// District colours from the map (content.js), minus the player's own hub green, so your car is always the green one.
export const COLOURS = ['#22d3ee', '#facc15', '#ec4899', '#3b82f6', '#f97316', '#a78bfa', '#0fb89c', '#94a3b8'];

const msg = (to, m) => [to, m];

export class Room {
  /** @param {{ownerToken?: string, blocks?: Record<string, number>}} o blocks: kick blocks keyed s:<id> / i:<ipKey> → until ms */
  /** guests: { token: [names] } lets a named person (Shan, say) wear their own reserved name and nothing else */
  constructor({ ownerToken = null, guests = {}, blocks = {} } = {}) {
    this.ownerToken = ownerToken;
    this.guests = new Map(Object.entries(guests || {}).filter(([t, names]) => t && Array.isArray(names)).map(([t, names]) => [t, new Set(names.map(fold))]));
    this.blocks = { ...blocks };
    this.players = new Map(); // id → player
    this.colourN = 0;
    this.driverN = 0;
    this.lastSnap = -Infinity;
    this.dirty = new Set();
  }

  /** What a presented token permits: {owner} for Ben's, {allow} for a guest's, nothing otherwise. */
  grant(token) {
    if (!(typeof token === 'string' && token)) return {};
    if (this.ownerToken && token === this.ownerToken) return { owner: true };
    const allow = this.guests.get(token);
    return allow ? { allow } : {};
  }

  joined() { return [...this.players.values()].filter(p => p.joined); }
  online() { return this.joined().length; }
  taken() { return new Set(this.joined().map(p => p.name.toLowerCase())); }
  nextDriver() { this.driverN = (this.driverN % 99) + 1; return String(this.driverN).padStart(2, '0'); }
  blocked(key, now) { const until = this.blocks[key]; if (!until) return false; if (until <= now) { delete this.blocks[key]; return false; } return true; }

  /** A socket arrives, before its hi. */
  open(id, { ipKey }, now) {
    if (this.blocked('s:' + id, now) || this.blocked('i:' + ipKey, now)) return { ok: false, error: 'blocked' };
    if ([...this.players.values()].filter(p => p.ipKey === ipKey).length >= WORLD_IP_MAX) return { ok: false, error: 'ip' };
    if (this.players.size >= WORLD_MAX) return { ok: false, error: 'full' };
    this.players.set(id, { id, ipKey, since: now, joined: false, name: null, colour: null, pose: null, times: [], pings: [], dropped: [], lastJump: -Infinity, bad: 0, renamedAt: -Infinity, lastMsg: now });
    return { ok: true };
  }

  /** What the shell stores on the socket so the roster survives hibernation. */
  attachment(id) {
    const p = this.players.get(id);
    return p?.joined ? { id: p.id, name: p.name, colour: p.colour, ipKey: p.ipKey, since: p.since, heardAt: p.lastMsg } : null;
  }

  /** Rebuild joined players from stored attachments after a wake-up. */
  restore(entries, now = Date.now()) {
    for (const e of entries) {
      if (!e?.id) continue;
      // Last heard is what the attachment says (refreshed every 30 s of messages), else when it joined: a wake-up must not make a dead socket look alive
      this.players.set(e.id, { id: e.id, ipKey: e.ipKey, since: e.since, joined: true, name: e.name, colour: e.colour, pose: null, times: [], pings: [], dropped: [], lastJump: -Infinity, bad: 0, renamedAt: -Infinity, lastMsg: e.heardAt ?? e.since ?? now });
      this.colourN++;
    }
  }

  broadcast(m, except = null) { return this.joined().filter(p => p.id !== except).map(p => msg(p.id, m)); }

  peerView(p) { return { id: p.id, name: p.name, colour: p.colour, ...(p.pose ? { x: p.pose.x, z: p.pose.z, h: p.pose.h, s: p.pose.s } : {}) }; }

  /** One frame from a socket. Returns the messages to send, whether to close, and when to flush a held snapshot. */
  onMessage(id, raw, now) {
    const p = this.players.get(id);
    if (!p) return { out: [] };
    p.lastMsg = now;
    const bad = () => (++p.bad >= WORLD_BAD_MAX ? { out: [], close: 'bad' } : { out: [] });
    // A frame dropped for rate is free for the sender and billed to us: too many of them and the socket goes, the address rests
    const flooded = () => {
      p.dropped = p.dropped.filter(t => now - t < WORLD_FLOOD_WINDOW_MS);
      p.dropped.push(now);
      if (p.dropped.length <= WORLD_FLOOD_MAX) return { out: [] };
      this.blocks['i:' + p.ipKey] = now + WORLD_FLOOD_BLOCK_MS;
      return { out: [], close: 'flood' };
    };
    const over = (times, hz) => { const keep = times.filter(t => now - t < 1000); times.length = 0; times.push(...keep); if (keep.length >= hz) return true; times.push(now); return false; };
    if (typeof raw !== 'string' || raw.length > WORLD_FRAME_MAX) return bad();
    let m;
    try { m = JSON.parse(raw); } catch { return bad(); }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return bad();
    if (m.t === 'hi' && !p.joined) {
      p.name = pickName(m.name, { ...this.grant(m.owner), taken: this.taken(), next: () => this.nextDriver() }).name;
      p.colour = COLOURS[this.colourN++ % COLOURS.length];
      p.joined = true; p.bad = 0;
      const peers = this.joined().filter(o => o !== p).map(o => this.peerView(o));
      return { out: [msg(id, { t: 'ok', id, name: p.name, colour: p.colour, now, peers }),
        ...this.broadcast({ t: 'join', id, name: p.name, colour: p.colour }, id), ...this.broadcast({ t: 'n', online: this.online() }, id)] };
    }
    if (m.t === 'ping') return over(p.pings, WORLD_PING_MAX_HZ) ? flooded() : { out: [msg(id, { t: 'pong', now, echo: m.echo })] };
    if (!p.joined) return bad();
    if (m.t === 'p') {
      const pose = parsePose(m);
      if (!pose.ok) return bad();
      p.bad = 0;
      if (over(p.times, WORLD_POSE_MAX_HZ)) return flooded(); // dropped; a sustained flood closes the socket
      if (pose.j) { if (now - p.lastJump < WORLD_JUMP_MS) pose.j = false; else p.lastJump = now; }
      p.pose = pose;
      this.dirty.add(id);
      const wait = WORLD_SNAPSHOT_MS - (now - this.lastSnap);
      return wait <= 0 ? this.flush(now) : { out: [], flushIn: wait };
    }
    if (m.t === 'name') {
      p.bad = 0;
      if (now - p.renamedAt < WORLD_RENAME_SEC * 1000) return { out: [msg(id, { t: 'err', error: 'rate' })] };
      p.renamedAt = now;
      const taken = this.taken(); taken.delete(p.name.toLowerCase());
      const pick = pickName(m.name, { ...this.grant(m.owner), taken, next: () => this.nextDriver(), keep: p.name });
      p.name = pick.name;
      const asked = typeof m.name === 'string' ? m.name.slice(0, 40) : '';
      const named = pick.reason ? { t: 'named', name: p.name, reason: pick.reason, asked } : { t: 'named', name: p.name };
      return { out: [msg(id, named), ...this.broadcast({ t: 'rename', id, name: p.name }, id)] };
    }
    return bad();
  }

  /** Send the held snapshot (movers since the last one) to everyone. */
  flush(now) {
    if (!this.dirty.size) return { out: [] };
    const p = [...this.dirty].map(id => this.players.get(id)).filter(q => q?.pose).map(q => [q.id, q.pose.x, q.pose.z, q.pose.h, q.pose.s, q.pose.j ? 1 : 0]);
    this.dirty.clear();
    this.lastSnap = now;
    return { out: this.broadcast({ t: 's', now, p }) };
  }

  /** A socket went away. */
  close(id) {
    const p = this.players.get(id);
    if (!p) return { out: [] };
    this.players.delete(id);
    this.dirty.delete(id);
    if (!p.joined) return { out: [] };
    return { out: [...this.broadcast({ t: 'leave', id }), ...this.broadcast({ t: 'n', online: this.online() })] };
  }

  /** Drop sockets nothing has been heard from for WORLD_IDLE_MS: browsers killed without a close frame. The shell closes them. */
  reap(now) {
    const dead = [...this.players.values()].filter(p => now - p.lastMsg > WORLD_IDLE_MS).map(p => p.id);
    const out = [];
    for (const id of dead) out.push(...this.close(id).out);
    return { closed: dead, out };
  }

  /** For the admin: who's here (no addresses). */
  who() { return this.joined().map(p => ({ id: p.id, name: p.name, colour: p.colour, x: p.pose?.x ?? null, z: p.pose?.z ?? null, since: p.since })); }

  /** Block matching players (by id, or by name ignoring case and a " (2)" suffix) for `minutes` and drop them. The shell closes the sockets. */
  kick({ id, name } = {}, minutes, now) {
    const base = n => n.trim().toLowerCase().replace(/ \(\d+\)$/, '');
    const key = typeof name === 'string' ? base(name) : null;
    const hits = this.joined().filter(p => (id && p.id === id) || (key && base(p.name) === key));
    const until = now + Math.max(1, Number(minutes) || 60) * 60_000;
    const out = [];
    for (const p of hits) { this.blocks['s:' + p.id] = until; this.blocks['i:' + p.ipKey] = until; out.push(...this.close(p.id).out); }
    return { closed: hits.map(p => p.id), blocks: { ...this.blocks }, out };
  }
}
