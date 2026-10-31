// copilot-world: the multiplayer room for the Strike ecosystem map (strike.benryan.com.au/ecosystem).
// Its own worker, apart from copilot-watch, so a bad deploy or a Durable Object migration here can never touch the
// trading alerts. One Durable Object ("main") holds everyone connected; src/world.js is the logic, this file the plumbing.
import { Room, WORLD_OFF_KEY, WORLD_IDLE_MS, offChecker } from './world.js';
import { RACE_ORIGINS, RACE_ADMIN_HEADER } from './race.js';
import { safeEqual } from './telegram.js';

const ROOM = 'main';

const cors = origin => (RACE_ORIGINS.includes(origin)
  ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': `content-type, ${RACE_ADMIN_HEADER}`, 'access-control-max-age': '600' }
  : {});
const json = (v, status, origin, extra = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(origin), ...extra } });
const isAdmin = (req, env) => !!env.RACE_ADMIN_TOKEN && safeEqual(req.headers.get(RACE_ADMIN_HEADER), env.RACE_ADMIN_TOKEN);
const room = env => env.WORLD.get(env.WORLD.idFromName(ROOM));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('origin') || '';
    const { pathname } = url;
    if (req.method === 'OPTIONS') return new Response(null, { status: RACE_ORIGINS.includes(origin) ? 204 : 403, headers: cors(origin) });
    if (pathname === '/ws') {
      if (!RACE_ORIGINS.includes(origin)) return json({ error: 'origin' }, 403, origin);
      if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'upgrade' }, 426, origin);
      if ((await env.KV.get(WORLD_OFF_KEY)) != null) return json({ error: 'off' }, 503, origin);
      return room(env).fetch(req);
    }
    if (pathname === '/presence' && req.method === 'GET') {
      const r = await room(env).fetch(req);
      return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(origin) } });
    }
    if ((pathname === '/who' && req.method === 'GET') || (pathname === '/kick' && req.method === 'POST')) {
      if (!isAdmin(req, env)) return json({ error: 'forbidden' }, 403, origin);
      return room(env).fetch(req);
    }
    if (pathname === '/health') return new Response('ok');
    if (pathname === '/') return new Response('copilot-world: the multiplayer room for strike.benryan.com.au/ecosystem', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response('Not found', { status: 404 });
  },
};

const enc = new TextEncoder();
async function ipKeyOf(ip, salt) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(`${salt}|${ip}`));
  return [...new Uint8Array(d)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The room. Hibernating websockets; the roster is rebuilt from socket attachments after a wake-up. */
export class World {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sockets = new Map(); // id → WebSocket
    this.flushTimer = null;
    this.paused = offChecker(() => env.KV.get(WORLD_OFF_KEY)); // one KV read per 30 s, not one per pose
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const blocks = (await ctx.storage.get('blocks')) || {};
      let guests = {};
      try { guests = env.WORLD_GUEST_TOKENS ? JSON.parse(env.WORLD_GUEST_TOKENS) : {}; } catch { console.warn('WORLD_GUEST_TOKENS is not JSON'); }
      this.room = new Room({ ownerToken: env.WORLD_OWNER_TOKEN || null, guests, blocks });
      const joined = [], now = Date.now();
      for (const ws of ctx.getWebSockets()) {
        const a = ws.deserializeAttachment();
        if (!a?.id) continue;
        this.sockets.set(a.id, ws);
        if (a.name) joined.push(a);
        else if (this.room.open(a.id, { ipKey: a.ipKey }, now).ok) this.room.players.get(a.id).lastMsg = a.since ?? now; // never said hi: ages from when it arrived
      }
      this.room.restore(joined, now);
      if (this.sockets.size) await this.armReaper();
    });
  }

  /** One alarm a minute while anyone is connected: it drops sockets that have gone silent (see Room.reap). */
  async armReaper() {
    if (this.reaperArmed) return;
    this.reaperArmed = true;
    await this.ctx.storage.setAlarm(Date.now() + WORLD_IDLE_MS);
  }

  async alarm() {
    await this.ready;
    this.reaperArmed = false;
    const k = this.room.reap(Date.now());
    this.deliver(k.out);
    for (const id of k.closed) { try { this.sockets.get(id)?.close(1001, 'idle'); } catch { /* gone */ } this.sockets.delete(id); }
    if (this.sockets.size) await this.armReaper();
  }

  deliver(out) {
    for (const [to, m] of out) {
      const ws = this.sockets.get(to);
      if (!ws) continue;
      try { ws.send(JSON.stringify(m)); } catch { /* closing */ }
    }
  }

  flushLater(ms) {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.deliver(this.room.flush(Date.now()).out); }, ms);
  }

  async fetch(req) {
    await this.ready;
    const { pathname } = new URL(req.url);
    const now = Date.now();
    if (pathname === '/ws') {
      const ipKey = await ipKeyOf(req.headers.get('cf-connecting-ip') || '', this.env.RACE_ADMIN_TOKEN || 'dev');
      const id = crypto.randomUUID().slice(0, 8);
      const r = this.room.open(id, { ipKey }, now);
      if (!r.ok) return json({ error: r.error }, 403, req.headers.get('origin') || '');
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ id, ipKey, since: now });
      this.sockets.set(id, server);
      await this.armReaper();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (pathname === '/presence') return json({ online: this.room.online() }, 200, '');
    if (pathname === '/who') return json({ online: this.room.online(), who: this.room.who() }, 200, '');
    if (pathname === '/kick') {
      let body = {};
      try { body = await req.json(); } catch { /* empty */ }
      const k = this.room.kick({ id: body.id, name: body.name }, body.minutes, now);
      await this.ctx.storage.put('blocks', k.blocks);
      this.deliver(k.out);
      for (const id of k.closed) { try { this.sockets.get(id)?.close(1008, 'kicked'); } catch { /* gone */ } this.sockets.delete(id); }
      return json({ closed: k.closed, until: k.closed.length ? k.blocks['s:' + k.closed[0]] : null }, 200, '');
    }
    return new Response('Not found', { status: 404 });
  }

  idOf(ws) { return ws.deserializeAttachment()?.id; }

  async webSocketMessage(ws, message) {
    await this.ready;
    const id = this.idOf(ws);
    if (!id) return ws.close(1008, 'unknown');
    if (await this.paused(Date.now())) return this.pauseAll();
    const res = this.room.onMessage(id, typeof message === 'string' ? message : '', Date.now());
    this.deliver(res.out);
    const a = this.room.attachment(id), cur = ws.deserializeAttachment();
    // Stored on first hi, on every rename, and every 30 s of messages (so the last-heard time survives hibernation)
    if (a && (cur?.name !== a.name || a.heardAt - (cur?.heardAt ?? 0) > 30_000)) ws.serializeAttachment(a);
    if (res.flushIn) this.flushLater(res.flushIn);
    if (res.close) { this.deliver(this.room.close(id).out); this.sockets.delete(id); ws.close(1008, res.close); }
  }

  /** The kill switch is on: close every socket; the worker refuses new ones until the key is gone. */
  pauseAll() {
    for (const [id, ws] of this.sockets) { this.room.close(id); try { ws.close(1001, 'paused'); } catch { /* gone */ } }
    this.sockets.clear();
  }

  async webSocketClose(ws) { await this.ready; const id = this.idOf(ws); if (id) { this.deliver(this.room.close(id).out); this.sockets.delete(id); } }
  async webSocketError(ws) { return this.webSocketClose(ws); }
}
