// Signal screen: is a terminal event's raw-signal window consistent with a
// real contact event, or does it look like BACKGROUND (nothing happening)?
//
// Mechanism (validated offline first in scripts/slip_and_residual_screen.py,
// leave-episode-out): featurize a ±0.35 s window of the finger's raw stream
// around the event, find the 7 nearest windows in a reference corpus of
// PUBLISHED event windows + sampled background windows, and count how many
// neighbors are background. A real place/release/drop lives among other
// terminal windows; a sensor residual or phantom — force that exists only as
// un-re-zeroed discharge — lives among background windows (Python study:
// caught 4/5 phantom + 3/5 sensor_residual at ≤5.6% false-alarm on real
// terminals; the one residual that mimics a real place, ep36 @8.46, is
// invisible to any signal-level screen BY CONSTRUCTION and stays the context
// rules' job — this screen is the second layer, not a replacement).
//
// The reference corpus is a PROFILE artifact (rigProfile.ts): the sotac
// registry profile carries screen-reference.json, a dataset-side profile
// names its own file (screenReferencePath), the template has none — and
// without a reference the detector does not call the screen. This module
// holds no reference of its own: the caller must pass one (there is no
// silent sotac default). The corpus is built by
// scripts/build-screen-reference.ts (workspace, not the Space) IN THIS
// FEATURE SPACE from the local sotac mirror — regenerating it per rig is
// the portability protocol (a Tier-2 calibration artifact, like every
// threshold). Same-episode reference vectors are excluded at query time
// when the caller knows the episode index, so corpus replays don't vote
// for themselves.
//
// Feature recipe (must match build-screen-reference.ts — both call
// terminalWindowFeatures): channels fnRaw / fsRaw / active / hfProxy, each
// linearly resampled to 16 points over the window, plus 4 scalars
// (pre-mean, post-mean, delta of fnRaw; max hfProxy) = 68 dims, z-scored
// with the scaler stored alongside the reference. hfProxy is the rolling
// 10-sample mean of |Δ fnRaw| — per-SAMPLE, so the screen only runs on the
// ~91 Hz raw path (rateHz > 60); 30 Hz table windows would distort it.

import type { TactileSeries } from "./eventDetection";

export interface ScreenReference {
  scaler: { mean: number[]; std: number[] };
  vectors: Array<{ ep: number; label: string; v: number[] }>;
}

export const SCREEN_HALF_S = 0.35;
export const SCREEN_RESAMPLE = 16;
export const SCREEN_DIMS = 4 * SCREEN_RESAMPLE + 4;
export const SCREEN_K = 7;
/** neighbors that must be background to call the window artifact-like —
 * 4/7 splits the Python study's adjudicated artifacts (votes 4-7) from
 * every surviving real terminal's typical 0-3. */
export const SCREEN_VOTE_MIN = 4;
const HF_WIN = 10; // samples, ~0.11 s at 91 Hz — matches the offline study
const MIN_REFERENCE = 50; // placeholder/empty reference disables the screen

function interpAt(t: Float64Array, y: ArrayLike<number>, tq: number): number {
  let lo = 0;
  let hi = t.length - 1;
  if (tq <= t[0]) return Number(y[0]);
  if (tq >= t[hi]) return Number(y[hi]);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= tq) lo = mid;
    else hi = mid;
  }
  const f = (tq - t[lo]) / Math.max(t[hi] - t[lo], 1e-9);
  return Number(y[lo]) + f * (Number(y[hi]) - Number(y[lo]));
}

/** 68-dim window feature vector, or null when the window falls outside the
 * series (same ±0.05 s tolerance as the offline study) or the series lacks
 * the screen channels. */
export function terminalWindowFeatures(
  series: TactileSeries,
  finger: number,
  tEv: number,
): number[] | null {
  const fg = series.fingers[finger];
  if (!fg?.fsRaw || !fg.active) return null;
  const { t } = series;
  const n = t.length;
  if (n < HF_WIN + 2) return null;
  if (tEv - SCREEN_HALF_S < t[0] - 0.05) return null;
  if (tEv + SCREEN_HALF_S > t[n - 1] + 0.05) return null;

  // hfProxy: rolling HF_WIN-sample mean of |Δ fnRaw|
  const hf = new Float64Array(n);
  let acc = 0;
  const diffs = new Float64Array(n);
  for (let i = 1; i < n; i++)
    diffs[i] = Math.abs(fg.fnRaw[i] - fg.fnRaw[i - 1]);
  for (let i = 0; i < n; i++) {
    acc += diffs[i];
    if (i >= HF_WIN) acc -= diffs[i - HF_WIN];
    hf[i] = acc / Math.min(i + 1, HF_WIN);
  }

  const vec: number[] = [];
  const grid: number[] = [];
  for (let g = 0; g < SCREEN_RESAMPLE; g++) {
    grid.push(
      tEv - SCREEN_HALF_S + (2 * SCREEN_HALF_S * g) / (SCREEN_RESAMPLE - 1),
    );
  }
  const channels: ArrayLike<number>[] = [fg.fnRaw, fg.fsRaw, fg.active, hf];
  const normalPts: number[] = [];
  let hfMax = -Infinity;
  for (const ch of channels) {
    for (const tq of grid) {
      const v = interpAt(t, ch, tq);
      vec.push(v);
      if (ch === fg.fnRaw) normalPts.push(v);
      if (ch === hf) hfMax = Math.max(hfMax, v);
    }
  }
  const half = SCREEN_RESAMPLE / 2;
  const pre = normalPts.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const post = normalPts.slice(half).reduce((a, b) => a + b, 0) / half;
  vec.push(pre, post, post - pre, hfMax);
  return vec;
}

/** Background votes among the SCREEN_K nearest reference windows, or null
 * when the window can't be featurized or the reference is unusable. The
 * reference is required: it comes from the rig profile, never from here. */
export function screenBackgroundVotes(
  series: TactileSeries,
  finger: number,
  tEv: number,
  excludeEpisode: number | undefined,
  ref: ScreenReference,
): number | null {
  if (!ref.vectors || ref.vectors.length < MIN_REFERENCE) return null;
  const feat = terminalWindowFeatures(series, finger, tEv);
  if (!feat) return null;
  const { mean, std } = ref.scaler;
  if (mean.length !== feat.length) return null;
  const q = feat.map((v, i) => (v - mean[i]) / Math.max(std[i], 1e-9));

  // 7 nearest by Euclidean distance in z-space (brute force; ~1200 rows)
  const bestD: number[] = [];
  const bestBg: boolean[] = [];
  for (const row of ref.vectors) {
    if (excludeEpisode !== undefined && row.ep === excludeEpisode) continue;
    let d = 0;
    for (let i = 0; i < q.length; i++) {
      const z = (row.v[i] - mean[i]) / Math.max(std[i], 1e-9) - q[i];
      d += z * z;
      if (bestD.length === SCREEN_K && d >= bestD[SCREEN_K - 1]) break;
    }
    if (bestD.length < SCREEN_K || d < bestD[SCREEN_K - 1]) {
      let at = bestD.length;
      while (at > 0 && bestD[at - 1] > d) at--;
      bestD.splice(at, 0, d);
      bestBg.splice(at, 0, row.label === "background");
      if (bestD.length > SCREEN_K) {
        bestD.pop();
        bestBg.pop();
      }
    }
  }
  if (bestD.length < SCREEN_K) return null;
  return bestBg.filter(Boolean).length;
}
