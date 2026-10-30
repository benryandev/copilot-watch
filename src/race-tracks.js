// Race tracks for the time-trial leaderboard, shared by the server checks and their tests.
// checkpoints: cumulative distance in metres from the start line to each checkpoint, in order; length: the full lap.
// PLACEHOLDER numbers until the game supplies the real RealFi track; swap them in here, the tests derive from them.
export const RACE_TRACKS = {
  'realfi-v1': { checkpoints: [130, 260, 390, 520, 650], length: 780 },
};
/** Fastest believable speed in m/s (the car tops out at 24 m/s); any segment run faster than this is refused. */
export const RACE_MAX_SPEED = 30;
/** Slowest lap kept: 30 minutes. */
export const RACE_MAX_MS = 30 * 60 * 1000;
