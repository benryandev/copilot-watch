// Race tracks for the time-trial leaderboard, shared by the server checks and their tests.
// The registry is src/tracks.json, a COPY of copilot-check ecosystem/tracks/tracks.json: edits belong in copilot-check,
// then `pnpm sync-tracks` (as core/ is a copy of copilot-check/core).
// checkpoints: cumulative distance in metres from the start line to each checkpoint, in order; length: the full lap.
// A track is open for ranked laps only when it carries all of checkpoints, length, minMs, maxSpeed and segMaxSpeed.
import tracks from './tracks.json' with { type: 'json' };

const posNum = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
function isOpen(t) {
  if (!t || typeof t !== 'object') return false;
  const { checkpoints: cps, length } = t;
  if (!Number.isInteger(length) || length <= 0 || !Number.isInteger(t.minMs) || t.minMs <= 0) return false;
  if (!posNum(t.maxSpeed) || !posNum(t.segMaxSpeed)) return false;
  if (!Array.isArray(cps) || !cps.length) return false;
  return cps.every((c, i) => Number.isInteger(c) && c > 0 && c < length && (i === 0 || c > cps[i - 1]));
}
/** The open entries of a registry JSON, each reduced to { name, checkpoints, length, minMs, maxSpeed, segMaxSpeed }. */
export function openTracks(json) {
  const out = {};
  for (const [id, t] of Object.entries(json ?? {})) {
    if (isOpen(t)) out[id] = { name: t.name, checkpoints: t.checkpoints, length: t.length, minMs: t.minMs, maxSpeed: t.maxSpeed, segMaxSpeed: t.segMaxSpeed };
  }
  return out;
}
export const RACE_TRACKS = openTracks(tracks);
export function raceTrack(id) { return Object.hasOwn(RACE_TRACKS, id) ? RACE_TRACKS[id] : null; }
/** Slowest lap kept: 30 minutes. */
export const RACE_MAX_MS = 30 * 60 * 1000;
