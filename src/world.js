// The world room for the ecosystem map's multiplayer: who's driving, where, under what name.
// Pure logic, no Cloudflare types; the Durable Object shell in world-worker.js wires it to websockets.
import { cleanName, parseDevice } from './race.js';
import { raceTrack } from './race-tracks.js';

export const WORLD_VERSION = '2026-11-02.3'; // bumped on deploy so /presence shows which code the room runs
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
// ── Live races (stage two) ──
export const RACE_JOIN_MS = 20_000; // from Race pressed to the grid
export const RACE_GRID = 8; // cars on the grid
export const RACE_GO_LEAD_MS = 3_000; // race.go goes out this long before startsAt (the 3-2-1)
export const RACE_CLOSE_MS = 60_000; // the race closes this long after the first finisher
export const RACE_DEAD_HEAT_MS = 100; // finishes closer than this share a position
export const RACE_KEEP_MS = 300_000; // a finished race is kept this long for the sheets
export const RACE_MAX_RUN_MS = 300_000; // a race nobody finishes ends on its own this long after the start
export const RACE_MSG_MAX_HZ = 2; // race.open/join/leave per second per socket
// Live races run on the hub's track only. Its checkpoint count comes from the registry; a hub track that is missing or
// not open fails the import, so a deploy with a broken registry fails loudly rather than racing on a wrong count.
export const WORLD_HUB_TRACK = 'realfi-v1';
const hubTrack = raceTrack(WORLD_HUB_TRACK);
if (!hubTrack) throw new Error(`world: the hub track ${WORLD_HUB_TRACK} is not open in the registry`);
export const RACE_CHECKPOINTS = hubTrack.checkpoints.length;
// ── Zones: the hub and each venue page share the room, but see and hear only their own zone ──
export const ZONE_RE = /^[a-z0-9-]{1,16}$/;
export const parseZone = (z) => (typeof z === 'string' && ZONE_RE.test(z) ? z : 'hub');
const RACE_ZONE_ERR = { t: 'err', error: 'race_zone', why: 'Live races run at the Raceway for now' };
// One socket per device: a device joining again (a second tab, a reload before the old socket died) closes the older one
const DUP_ERR = { t: 'err', error: 'dup', why: 'This device is driving in another tab' };
// ── Emotes: a wave, a party, fire, a flag, a thumbs up (the page draws them; the room only relays an index) ──
export const EMOTE_COUNT = 5;
export const EMOTE_MAX_HZ = 2; // per socket per second; each one fans out to the room

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
    this.race = null; // the live race, if any (see openRace)
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
    this.players.set(id, { id, ipKey, since: now, joined: false, name: null, colour: null, zone: 'hub', device: null, pose: null, times: [], pings: [], races: [], emotes: [], dropped: [], lastJump: -Infinity, bad: 0, renamedAt: -Infinity, lastMsg: now });
    return { ok: true };
  }

  /** What the shell stores on the socket so the roster survives hibernation. */
  attachment(id) {
    const p = this.players.get(id);
    return p?.joined ? { id: p.id, name: p.name, colour: p.colour, ipKey: p.ipKey, since: p.since, heardAt: p.lastMsg, ...(p.zone !== 'hub' ? { zone: p.zone } : {}), ...(p.device ? { device: p.device } : {}) } : null; // hub and no device are the defaults, left out
  }

  /** Rebuild joined players from stored attachments after a wake-up. */
  restore(entries, now = Date.now()) {
    for (const e of entries) {
      if (!e?.id) continue;
      // Last heard is what the attachment says (refreshed every 30 s of messages), else when it joined: a wake-up must not make a dead socket look alive
      this.players.set(e.id, { id: e.id, ipKey: e.ipKey, since: e.since, joined: true, name: e.name, colour: e.colour, zone: parseZone(e.zone), device: parseDevice(e.device), pose: null, times: [], pings: [], races: [], emotes: [], dropped: [], lastJump: -Infinity, bad: 0, renamedAt: -Infinity, lastMsg: e.heardAt ?? e.since ?? now });
      this.colourN++;
    }
  }

  broadcast(m, except = null) { return this.joined().filter(p => p.id !== except).map(p => msg(p.id, m)); }
  /** The same, to one zone only. */
  broadcastZone(m, zone, except = null) { return this.joined().filter(p => p.zone === zone && p.id !== except).map(p => msg(p.id, m)); }
  /** Live-race traffic: the race runs at the Raceway, so only the hub hears it. */
  raceCast(m) { return this.broadcastZone(m, 'hub'); }
  /** Joined players per zone, e.g. { hub: 2, 'lagoon-v1': 1 }; a zone with nobody in it is left out. */
  zones() { const z = {}; for (const p of this.players.values()) if (p.joined) z[p.zone] = (z[p.zone] ?? 0) + 1; return z; }
  /** The head count everyone hears on join, leave and kick. */
  count() { return { t: 'n', online: this.online(), zones: this.zones() }; }

  peerView(p) { return { id: p.id, name: p.name, colour: p.colour, zone: p.zone, ...(p.pose ? { x: p.pose.x, z: p.pose.z, h: p.pose.h, s: p.pose.s } : {}) }; }

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
      // The same device already joined: drop the older player first, so its name is free and no count ever shows both
      p.device = parseDevice(m.device);
      const dups = p.device ? this.joined().filter(o => o.device === p.device) : [];
      const dupOut = []; let dupRace = false;
      for (const o of dups) {
        const c = this.close(o.id, now);
        dupOut.push(msg(o.id, DUP_ERR), ...c.out.filter(([, x]) => x.t !== 'n')); // the one count goes out below, after the join
        dupRace ||= !!c.raceChanged;
      }
      p.name = pickName(m.name, { ...this.grant(m.owner), taken: this.taken(), next: () => this.nextDriver() }).name;
      p.colour = COLOURS[this.colourN++ % COLOURS.length];
      p.zone = parseZone(m.zone); // set once, on hi: a venue is its own page, so changing zone is a new socket
      p.joined = true; p.bad = 0;
      const peers = this.joined().filter(o => o !== p).map(o => this.peerView(o));
      const race = p.zone === 'hub' && this.race && this.race.state !== 'done' ? { ...this.raceView(), t: undefined, state: this.race.state, order: this.order() } : null;
      if (race) delete race.t;
      const res = { out: [...dupOut, msg(id, { t: 'ok', id, name: p.name, colour: p.colour, now, peers, zones: this.zones(), race }),
        ...this.broadcast({ t: 'join', id, name: p.name, colour: p.colour, zone: p.zone }, id), ...this.broadcast(this.count(), id)] };
      if (dups.length) res.closeOthers = dups.map(o => ({ id: o.id, reason: 'dup' })); // the shell closes these sockets
      if (dupRace) res.raceChanged = true;
      return res;
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
    if (m.t === 'emote') {
      if (!Number.isInteger(m.e) || m.e < 0 || m.e >= EMOTE_COUNT) return bad();
      p.bad = 0;
      if (over(p.emotes, EMOTE_MAX_HZ)) return flooded();
      return { out: this.broadcastZone({ t: 'emote', id, e: m.e }, p.zone, id) };
    }
    if (m.t === 'race.open' || m.t === 'race.join' || m.t === 'race.leave') {
      p.bad = 0;
      if (over(p.races, RACE_MSG_MAX_HZ)) return flooded(); // each one fans out to the whole room
      return m.t === 'race.open' ? this.openRace(id, now) : m.t === 'race.join' ? this.joinRace(id, now) : this.leaveRace(id, now);
    }
    if (m.t === 'race.cp' || m.t === 'race.fin') {
      const res = m.t === 'race.cp' ? this.checkpoint(id, m.i, now) : this.finish(id, m.ms, now);
      if (res === 'bad') return bad();
      p.bad = 0;
      return res;
    }
    return bad();
  }

  // ── Live races: one at a time, in memory (the shell persists it) ──
  /** The grid in slot order, names as the room knows them now. */
  grid() {
    if (!this.race) return [];
    return [...this.race.entrants].map(([id, e]) => ({ id, name: this.players.get(id)?.name ?? e.name, slot: e.slot })).sort((a, b) => a.slot - b.slot);
  }
  raceView() { const r = this.race; return { t: 'race.open', id: r.id, host: r.host, name: r.hostName, startsAt: r.startsAt, grid: this.grid() }; }
  /** Race pressed: a new race with this player in slot 1, or a join if one is open. */
  openRace(id, now) {
    const p = this.players.get(id);
    if (p.zone !== 'hub') return { out: [msg(id, RACE_ZONE_ERR)] };
    if (this.race && this.race.state === 'open') return this.joinRace(id, now);
    if (this.race && this.race.state !== 'done') return { out: [msg(id, { t: 'err', error: 'race_running' })] };
    this.race = { id: crypto.randomUUID().slice(0, 8), host: id, hostName: p.name, state: 'open', openedAt: now, startsAt: now + RACE_JOIN_MS, entrants: new Map([[id, { slot: 1, name: p.name, cps: [], fin: null, dnf: false }]]), firstFinAt: null, endedAt: null };
    return { out: this.raceCast(this.raceView()), raceChanged: true };
  }
  joinRace(id) {
    const r = this.race, p = this.players.get(id);
    if (p.zone !== 'hub') return { out: [msg(id, RACE_ZONE_ERR)] };
    if (!r || r.state === 'done') return { out: [msg(id, { t: 'err', error: 'race_none' })] };
    if (r.state !== 'open') return { out: [msg(id, { t: 'err', error: 'race_running' })] };
    if (r.entrants.has(id)) return { out: [] };
    const used = new Set([...r.entrants.values()].map(e => e.slot));
    let slot = 1; while (used.has(slot)) slot++;
    if (slot > RACE_GRID) return { out: [msg(id, { t: 'err', error: 'race_full' })] };
    r.entrants.set(id, { slot, name: p.name, cps: [], fin: null, dnf: false });
    return { out: this.raceCast({ t: 'race.grid', id: r.id, grid: this.grid() }), raceChanged: true };
  }
  /** Off the grid before Go (the slot is freed); a DNF once running. */
  leaveRace(id, now = 0) {
    const r = this.race;
    if (!r || !r.entrants.has(id)) return { out: [] };
    if (r.state === 'open' || r.state === 'countdown') {
      r.entrants.delete(id);
      if (r.state === 'countdown' && r.entrants.size === 0) { this.race = null; return { out: this.raceCast({ t: 'race.cancel', id: r.id, why: 'Nobody left' }), raceChanged: true }; }
      return { out: this.raceCast({ t: 'race.grid', id: r.id, grid: this.grid() }), raceChanged: true };
    }
    const e = r.entrants.get(id);
    if (r.state === 'running' && !e.fin && !e.dnf) {
      e.dnf = true;
      const done = [...r.entrants.values()].every(x => x.fin || x.dnf);
      return { out: done ? this.endRace(now) : this.raceCast({ t: 'race.pos', id: r.id, order: this.order() }), raceChanged: true };
    }
    return { out: [] };
  }
  /** The race as plain data for the shell to persist (entrants as pairs), and back. */
  raceState() { const r = this.race; return r ? { ...r, entrants: [...r.entrants] } : null; }
  restoreRace(st, now = Date.now()) {
    this.race = st && typeof st === 'object' && Array.isArray(st.entrants) ? { ...st, entrants: new Map(st.entrants) } : null;
    const r = this.race;
    if (!r || r.state === 'done') return { out: [] };
    // After a restart nobody keeps their socket id: entrants who have not come back are out of the race
    for (const [id, e] of r.entrants) if (!this.players.get(id)?.joined) { if (r.state === 'running') e.dnf = true; else r.entrants.delete(id); }
    if (r.state === 'running' && [...r.entrants.values()].every(e => e.fin || e.dnf)) return { out: this.endRace(now) };
    if (r.state !== 'running' && r.entrants.size === 0) { this.race = null; return { out: [] }; }
    return { out: [] };
  }

  /** When the shell's alarm should next call timers(): the go/cancel moment, the start, the close after the first
   * finisher, or when a done race is forgotten. */
  due() {
    const r = this.race;
    if (!r) return null;
    if (r.state === 'open') return r.startsAt - RACE_GO_LEAD_MS;
    if (r.state === 'countdown') return r.startsAt;
    if (r.state === 'running') return Math.min(r.startsAt + RACE_MAX_RUN_MS, r.firstFinAt == null ? Infinity : r.firstFinAt + RACE_CLOSE_MS);
    return r.endedAt + RACE_KEEP_MS;
  }
  /** Run every timer due by `now`. A field of one is cancelled when its countdown would have started. */
  timers(now) {
    const out = [];
    let raceChanged = false;
    for (let guard = 0; guard < 8; guard++) {
      const d = this.due(), r = this.race;
      if (d == null || d > now) break;
      raceChanged = true;
      if (r.state === 'open') {
        if (r.entrants.size < 2) { out.push(...this.raceCast({ t: 'race.cancel', id: r.id, why: 'Nobody joined' })); this.race = null; }
        else { r.state = 'countdown'; out.push(...this.raceCast({ t: 'race.go', id: r.id, startsAt: r.startsAt })); }
      } else if (r.state === 'countdown') {
        if (r.entrants.size === 0) { out.push(...this.raceCast({ t: 'race.cancel', id: r.id, why: 'Nobody left' })); this.race = null; }
        else r.state = 'running';
      }
      else if (r.state === 'running') out.push(...this.endRace(now));
      else this.race = null;
    }
    return { out, raceChanged };
  }
  endRace(now) {
    const r = this.race;
    r.state = 'done'; r.endedAt = now;
    for (const e of r.entrants.values()) if (!e.fin) e.dnf = true;
    return this.raceCast({ t: 'race.end', id: r.id, order: this.order(), dnf: [...r.entrants].filter(([, e]) => e.dnf).map(([id]) => id) });
  }
  /** A checkpoint from an entrant: only the next one counts; repeats and skips are ignored (lag, a backed-over gate). */
  checkpoint(id, i, now) {
    const r = this.race;
    if (!r || !r.entrants.has(id)) return 'bad';
    const e = r.entrants.get(id);
    if (r.state !== 'running' || e.fin || e.dnf) return { out: [] };
    if (!Number.isInteger(i) || i !== e.cps.length + 1 || i > RACE_CHECKPOINTS) return { out: [] };
    e.cps.push(now - r.startsAt);
    return { out: this.raceCast({ t: 'race.pos', id: r.id, order: this.order() }), raceChanged: true };
  }
  /** The finish line, after every checkpoint. `ms` is the lap time the car measured, for the card only; the order
   * is by the server's receive time. The race ends at once when nobody is left on track. */
  finish(id, ms, now) {
    const r = this.race;
    if (!r || !r.entrants.has(id)) return 'bad';
    const e = r.entrants.get(id);
    if (r.state !== 'running' || e.fin || e.dnf || e.cps.length < RACE_CHECKPOINTS) return { out: [] };
    e.fin = { at: now - r.startsAt, ms: Number.isFinite(ms) && ms > 0 && ms <= 600_000 ? Math.round(ms) : null };
    if (r.firstFinAt == null) r.firstFinAt = now;
    const done = [...r.entrants.values()].every(x => x.fin || x.dnf);
    return { out: done ? this.endRace(now) : this.raceCast({ t: 'race.pos', id: r.id, order: this.order() }), raceChanged: true };
  }
  /** Running order: finishers first by the server clock, then the furthest checkpoint, earliest first; DNFs last.
   * Finishes within RACE_DEAD_HEAT_MS of the one ahead share its position. */
  order() {
    const r = this.race;
    if (!r) return [];
    const rows = [...r.entrants].map(([id, e]) => ({ id, name: this.players.get(id)?.name ?? e.name, cp: e.cps.length, at: e.fin ? e.fin.at : (e.cps.at(-1) ?? null), ms: e.fin?.ms ?? null, fin: !!e.fin, dnf: e.dnf, slot: e.slot }));
    rows.sort((a, b) => (a.dnf - b.dnf) || (b.fin - a.fin) || (a.fin ? a.at - b.at : (b.cp - a.cp) || ((a.at ?? Infinity) - (b.at ?? Infinity)) || (a.slot - b.slot)));
    let lead = null; // the first finisher of the current dead-heat group
    rows.forEach((x, i) => {
      if (x.fin && lead && x.at - lead.at <= RACE_DEAD_HEAT_MS) x.pos = lead.pos;
      else { x.pos = i + 1; lead = x.fin ? x : null; }
    });
    return rows.map(({ slot, ...x }) => x);
  }

  /** Send the held snapshots (movers since the last one): one per zone that has movers, to that zone's players only.
   * The movers are grouped by zone in one pass over `dirty`; nothing per zone is kept between flushes. */
  flush(now) {
    if (!this.dirty.size) return { out: [] };
    const snaps = new Map(); // zone → { t: 's', now, p }
    for (const id of this.dirty) {
      const q = this.players.get(id);
      if (!q?.pose) continue;
      const row = [q.id, q.pose.x, q.pose.z, q.pose.h, q.pose.s, q.pose.j ? 1 : 0];
      const s = snaps.get(q.zone);
      if (s) s.p.push(row); else snaps.set(q.zone, { t: 's', now, p: [row] });
    }
    this.dirty.clear();
    this.lastSnap = now;
    const out = [];
    for (const o of this.players.values()) { const s = o.joined && snaps.get(o.zone); if (s) out.push(msg(o.id, s)); }
    return { out };
  }

  /** A socket went away. */
  close(id, now = Date.now()) {
    const p = this.players.get(id);
    if (!p) return { out: [] };
    const race = p.joined ? this.leaveRace(id, now) : { out: [] }; // off the grid, or a DNF, before the roster forgets them
    this.players.delete(id);
    this.dirty.delete(id);
    if (!p.joined) return { out: [] };
    return { out: [...race.out.filter(([to]) => to !== id), ...this.broadcast({ t: 'leave', id }), ...this.broadcast(this.count())], raceChanged: !!race.raceChanged };
  }

  /** Drop sockets nothing has been heard from for WORLD_IDLE_MS: browsers killed without a close frame. The shell closes them. */
  reap(now) {
    const dead = [...this.players.values()].filter(p => now - p.lastMsg > WORLD_IDLE_MS).map(p => p.id);
    const out = [];
    for (const id of dead) out.push(...this.close(id, now).out);
    return { closed: dead, out };
  }

  /** An announcement from the race worker (a new #1 lap): everyone joined hears it, for the fireworks. */
  announce(m) {
    if (!m || typeof m !== 'object' || m.t !== 'record') return { ok: false, out: [] };
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    const ms = Number(m.ms), track = typeof m.track === 'string' ? m.track.slice(0, 40) : '';
    if (!name || name.length > 20 || !Number.isFinite(ms) || ms <= 0) return { ok: false, out: [] };
    const trackName = typeof m.trackName === 'string' && m.trackName.length <= 40 ? m.trackName : null;
    return { ok: true, out: this.broadcast({ t: 'record', name, ms: Math.round(ms), track, ...(trackName ? { trackName } : {}) }) };
  }

  /** For the admin: who's here (no addresses). */
  who() { return this.joined().map(p => ({ id: p.id, name: p.name, colour: p.colour, zone: p.zone, x: p.pose?.x ?? null, z: p.pose?.z ?? null, since: p.since })); }

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
