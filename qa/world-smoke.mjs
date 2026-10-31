// Smoke test for copilot-world: two sockets join, one moves, the other sees it; a reserved name falls back.
// Usage: node qa/world-smoke.mjs [ws://localhost:8787/ws]   (env WORLD_WS overrides the default)
const URL_ = process.argv[2] || process.env.WORLD_WS || 'ws://localhost:8787/ws';
const ORIGIN = 'http://localhost:8766';
const fail = m => { console.log(`FAIL world smoke: ${m}`); process.exit(1); };
const timer = setTimeout(() => fail('timed out after 8 s'), 8000);

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_, { headers: { origin: ORIGIN } });
    const got = [];
    const waiters = [];
    ws.addEventListener('message', e => { const m = JSON.parse(e.data); got.push(m); waiters.forEach(w => w(m)); });
    ws.addEventListener('error', e => reject(new Error(`socket error ${e.message || ''}`)));
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'hi', v: 1, name }));
      const until = (pred, ms = 2000) => new Promise((res, rej) => { const hit = got.find(pred); if (hit) return res(hit); const t = setTimeout(() => rej(new Error(`no frame matched in ${ms} ms; saw ${JSON.stringify(got.map(m => m.t))}`)), ms); waiters.push(m => { if (pred(m)) { clearTimeout(t); res(m); } }); });
      resolve({ ws, got, until, send: m => ws.send(JSON.stringify(m)) });
    });
  });
}

try {
  const a = await connect('Smoke A'), b = await connect('Smoke B');
  const okA = await a.until(m => m.t === 'ok'), okB = await b.until(m => m.t === 'ok');
  if (okA.name !== 'Smoke A' || okB.name !== 'Smoke B') fail(`names ${okA.name} / ${okB.name}`);
  if (okA.colour === okB.colour) fail('same colour');
  if (!okB.peers.some(p => p.id === okA.id)) fail('B did not get A in peers');
  await b.until(m => m.t === 'join' && m.id === okA.id).catch(() => null); // A joined before B: fine either way
  a.send({ t: 'p', x: 12.3, z: -40, h: 1.2, s: 8 });
  const s = await b.until(m => m.t === 's' && m.p.some(p => p[0] === okA.id), 1000);
  const row = s.p.find(p => p[0] === okA.id);
  if (row[1] !== 12.3 || row[2] !== -40) fail(`pose ${JSON.stringify(row)}`);
  b.send({ t: 'name', name: 'BenRyan' });
  const named = await b.until(m => m.t === 'named');
  if (!named.name.startsWith('Driver ')) fail(`reserved name let through: ${named.name}`);
  await a.until(m => m.t === 'rename' && m.id === okB.id);
  a.ws.close(); await b.until(m => m.t === 'leave' && m.id === okA.id); b.ws.close();
  clearTimeout(timer);
  console.log('ok   world smoke');
} catch (e) { fail(e.message); }
