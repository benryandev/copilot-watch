// Race tracks for the time-trial leaderboard, shared by the server checks and their tests.
// checkpoints: cumulative distance in metres from the start line to each checkpoint, in order; length: the full lap.
// Same numbers as RACE_TRACK in copilot-check ecosystem/js (measured along the centreline, 642.157 m, rounded down).
export const RACE_TRACKS = {
  'realfi-v1': { checkpoints: [211, 300, 420, 500, 550], length: 642 },
};
/** Fastest believable speed in m/s (the car tops out at 24 m/s); any segment run faster than this is refused. */
export const RACE_MAX_SPEED = 30;
/** Slowest lap kept: 30 minutes. */
export const RACE_MAX_MS = 30 * 60 * 1000;
