// copilot-watch's way to the leaderboards' writer (copilot-world src/boards-do.js, 6 Nov 2026). With BOARD_WRITER = "do"
// (wrangler.toml [vars]) every board read and change goes over the WORLD service binding to that board's Durable Object;
// without it (tests, local dev, the off switch in README) race.js and arcade.js use KV as before. A failure here never
// falls back to KV, which would bring back the lost writes: it throws 'board_busy' and the route answers 503.
import { RACE_ADMIN_HEADER } from './race.js';

export const BOARD_BUSY = 'board_busy';
export const boardsOn = env => env?.BOARD_WRITER === 'do' && !!env.WORLD?.fetch && !!env.RACE_ADMIN_TOKEN;

export function remoteBoards(env) {
  const op = async (name, key, args) => {
    let res;
    try {
      res = await env.WORLD.fetch('https://copilot-world/board/op', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RACE_ADMIN_HEADER]: env.RACE_ADMIN_TOKEN },
        body: JSON.stringify({ op: name, key, args }),
      });
    } catch { throw new Error(BOARD_BUSY); }
    if (!res.ok) throw new Error(BOARD_BUSY);
    return res.json();
  };
  return {
    read: key => op('read', key, {}),
    raceAdd: (entry, now) => op('raceAdd', `race:top:${entry.track}`, { entry, now }),
    raceRemove: async (track, q) => (await op('raceRemove', `race:top:${track}`, { track, ...q })).removed,
    arcadeAdd: (entry, now) => op('arcadeAdd', `arcade:top:${entry.game}`, { entry, now }),
    arcadeRemove: async (game, q) => (await op('arcadeRemove', `arcade:top:${game}`, { game, ...q })).removed,
  };
}
