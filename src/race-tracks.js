// Race tracks for the time-trial leaderboard, shared by the server checks and their tests.
// checkpoints: cumulative distance in metres from the start line to each checkpoint, in order; length: the full lap.
// Same numbers as RACE_TRACK in copilot-check ecosystem/js (measured along the centreline, 642.157 m, rounded down).
export const RACE_TRACKS = {
  'realfi-v1': { checkpoints: [211, 300, 420, 500, 550], length: 642 },
};
/** Fastest believable lap average in m/s over the centreline length. The car tops out at 24 m/s (28 for a moment after a
 * clean jump), but a good line cuts inside the centreline, so real laps read higher: Ben's 23.720 reads 27.1.
 * Was 30 until 1 Nov 2026, when a 21.954 s lap driven at 34 m/s (a console-pinned speed) got through. */
export const RACE_MAX_SPEED = 29;
// Per segment. Checkpoint distances run along the centreline and a good line cuts the corners, so a short segment can
// read well above the car's top speed (Ben's fastest real lap tripped 30 on the 50 m segment before the last checkpoint).
export const RACE_SEG_MAX_SPEED = 36;
/** Slowest lap kept: 30 minutes. */
export const RACE_MAX_MS = 30 * 60 * 1000;
