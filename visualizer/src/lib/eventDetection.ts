// Automatic tactile event detection for the Annotations tab.
//
// Pure module (no React, no fetch): takes tactile time series + gripper
// trajectory, returns subtask segments (level 1) and tactile events (level 2,
// 9-class taxonomy from the group dataset supplement, Table VIII).
//
// Method summary (see annotation_pipeline_technical.md in the project notes):
// - hysteresis thresholds on smoothed signals (enter/exit pairs, no chatter)
// - binary-segmentation changepoints on [Fn, Fs]; a threshold event within
//   AGREE_WINDOW_S of a changepoint is upgraded to high confidence
// - incipient slip via the PapillArray criterion (arXiv:2307.04011): edge
//   taxels' shear rate diverges from center taxels while grasp holds
// - a state machine drops impossible event orders
//
// Works at 30 Hz (main-table sensorFrames) or ~91 Hz (raw sidecar CSVs);
// builders for both input shapes are provided.

/* eslint-disable @typescript-eslint/no-non-null-assertion */

import type { LanguageAtom } from "@/types/language.types";

// ---------------------------------------------------------------- types

export type EventLabel =
  | "contact_onset"
  | "grasp_stable"
  | "lift"
  | "incipient_slip"
  | "slip"
  | "rotation"
  | "place"
  | "release"
  | "drop";

export type SubtaskLabel = "approach" | "grasp" | "transport" | "place_release";

export type Confidence = "high" | "medium" | "low";

export interface DetectedEvent {
  label: EventLabel;
  startS: number;
  endS: number; // === startS for instantaneous events
  finger: number; // -1 = merged/any
  confidence: Confidence;
  info?: string;
}

export interface DetectedSubtask {
  label: SubtaskLabel;
  startS: number;
  endS: number;
}

export interface AutoLabelResult {
  subtasks: DetectedSubtask[];
  events: DetectedEvent[];
  flags: string[]; // e.g. "no_contact", "unlabeled_transition@7.2s"
}

/** Per-finger derived signals, one value per sample. */
export interface FingerSeries {
  fn: Float64Array; // sum of taxel fz (N), median-5 smoothed
  fnRaw: Float64Array; // same, UNsmoothed — brief-contact recovery only
  // (median-5 flattens 3-4-sample grazes below every threshold)
  fs: Float64Array; // |sum of taxel (fx, fy)| (N)
  tauZ: Float64Array; // spin torque proxy about CoP normal (N*mm)
  slipDiv: Float64Array; // edge/center shear-direction divergence, 0..1
  edgeRateRatio: Float64Array; // edge vs center shear-rate ratio
  hf: Float64Array; // high-frequency shear energy (N/s RMS)
}

export interface TactileSeries {
  t: Float64Array; // episode-relative seconds, ascending
  rateHz: number;
  fingers: FingerSeries[];
}

export interface GripperSeries {
  t: number[]; // seconds
  pos: number[]; // arbitrary units; only derivative sign is used
}

// ---------------------------------------------------------------- thresholds

export interface DetectionThresholds {
  /** Fn crossing that marks contact (enter) and its release/exit level (N). */
  contactEnterN: number;
  contactExitN: number;
  /** grasp_stable: Fn above this and relative std below stableRelStd. */
  stableMinN: number;
  stableRelStd: number;
  stableWindowS: number;
  /** lift: dFn/dt above this (N/s) for liftMinS while gripper static. */
  liftRateNps: number;
  liftMinS: number;
  /** slip: hf energy above enter (exit at hfExit) and |dFs/dt| above rate. */
  hfEnter: number;
  hfExit: number;
  slipShearRateNps: number;
  /** incipient slip: divergence + edge/center rate ratio. */
  slipDivEnter: number;
  edgeRateRatioEnter: number;
  incipientMinS: number;
  /** rotation: |tauZ| (N*mm) sustained for rotationMinS. */
  rotationTauNmm: number;
  rotationMinS: number;
  /** place: Fn drop fraction within placeWindowS while gripper static. */
  placeDropFrac: number;
  placeWindowS: number;
  /** gripper motion epsilon (units/s) separating static vs moving jaw. */
  gripperVelEps: number;
  /** changepoint agreement window (s) and penalty knobs. */
  agreeWindowS: number;
  minEventS: number;
}

/** Contact exit must persist this long before a drop/release fires —
 * filters single-frame zero dropouts from the recording path. */
const EXIT_MIN_S = 0.3;

/** Contact entry must persist this long before contact_onset fires —
 * momentary brushes during approach otherwise spam contact/drop pairs. */
const ENTER_MIN_S = 0.2;

/** ...unless the contact is STRONG: the entry debounce exists for weak
 * near-threshold brushes, but a failed-grab graze on the pad's edge can
 * put >3 N on the taxels for under 0.2 s (sotac ep16 at 2.64 s) and must
 * not vanish. A sub-debounce run still yields a (low-confidence)
 * contact+drop pair when it lasts BRIEF_CONTACT_MIN_S and peaks above
 * BRIEF_CONTACT_STRONG_N — judged by the tactile data itself. The floor is
 * 3 raw frames: sotac ep54's second failed grab is 2.4 N over 12 taxels
 * for 0.044 s (video-verified), and start-up artifacts stay excluded by
 * the strength bar, not the duration. */
const BRIEF_CONTACT_MIN_S = 0.03;
const BRIEF_CONTACT_STRONG_N = 2.0;
/** Ignore brief contacts this close to t=0 — the sensor settles and the
 * arm is still parked; sotac ep58 has a 2.2 N start-up spike at 0.25 s. */
const BRIEF_CONTACT_SKIP_START_S = 0.5;

export const DEFAULT_THRESHOLDS: DetectionThresholds = {
  contactEnterN: 0.15,
  contactExitN: 0.1,
  stableMinN: 0.3,
  stableRelStd: 0.15,
  stableWindowS: 0.3,
  liftRateNps: 1.5,
  liftMinS: 0.1,
  // hf is heavy-tailed: p90 ~ 3-5, p99 ~ 50 on sotac (30 Hz). Enter well
  // above p90 so slip means a genuine transient, not routine motion.
  hfEnter: 15,
  hfExit: 6,
  slipShearRateNps: 8.0,
  slipDivEnter: 0.35,
  edgeRateRatioEnter: 3.0,
  incipientMinS: 0.08,
  rotationTauNmm: 25,
  rotationMinS: 0.25,
  placeDropFrac: 0.2,
  placeWindowS: 0.3,
  gripperVelEps: 0.5,
  agreeWindowS: 0.12,
  minEventS: 0.033,
};

// ---------------------------------------------------------------- helpers

function median5(x: Float64Array): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  const buf = new Float64Array(5);
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
      buf[k++] = x[j];
    }
    const s = Array.from(buf.subarray(0, k)).sort((a, b) => a - b);
    out[i] = s[Math.floor(k / 2)];
  }
  return out;
}

function movingRms(x: Float64Array, win: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += x[i] * x[i];
    if (i >= win) acc -= x[i - win] * x[i - win];
    out[i] = Math.sqrt(Math.max(acc, 0) / Math.min(i + 1, win));
  }
  return out;
}

function derivative(x: Float64Array, t: Float64Array): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dt = t[i] - t[i - 1];
    out[i] = dt > 1e-9 ? (x[i] - x[i - 1]) / dt : 0;
  }
  if (n > 1) out[0] = out[1];
  return out;
}

/** Windowed relative std of x (std/mean), NaN-safe. */
function relStd(x: Float64Array, i0: number, i1: number): number {
  let s = 0;
  let s2 = 0;
  const n = i1 - i0;
  if (n <= 1) return Infinity;
  for (let i = i0; i < i1; i++) {
    s += x[i];
    s2 += x[i] * x[i];
  }
  const mean = s / n;
  if (Math.abs(mean) < 1e-9) return Infinity;
  const varr = Math.max(s2 / n - mean * mean, 0);
  return Math.sqrt(varr) / Math.abs(mean);
}

// ---------------------------------------------------------------- builders

/**
 * Build a TactileSeries from the 30 Hz main-table sensor frames.
 * `frames[i]` is a nested array of shape [nFingers][nTaxels][3] (fx, fy, fz).
 * `layout` gives per-taxel [x, y, z] mm positions (finger long axis = +Y).
 */
export function buildSeriesFromSensorFrames(
  frames: unknown[],
  timestamps: number[],
  layout: [number, number, number][] | null,
): TactileSeries | null {
  if (!frames.length || !timestamps.length) return null;
  const first = frames[0] as number[][][];
  if (!Array.isArray(first) || !Array.isArray(first[0])) return null;
  const nFingers = first.length;
  const nTaxels = first[0].length;
  const n = Math.min(frames.length, timestamps.length);
  const t = Float64Array.from(timestamps.slice(0, n));
  const dur = t[n - 1] - t[0];
  const rateHz = dur > 0 ? (n - 1) / dur : 30;

  const fingers: FingerSeries[] = [];
  for (let f = 0; f < nFingers; f++) {
    const fn = new Float64Array(n);
    const fs = new Float64Array(n);
    const tauZ = new Float64Array(n);
    const slipDiv = new Float64Array(n);
    const edgeRateRatio = new Float64Array(n);
    let prevShear: Float64Array | null = null; // [nTaxels*2]
    const curShear = new Float64Array(nTaxels * 2);

    for (let i = 0; i < n; i++) {
      const frame = frames[i] as number[][][];
      const taxels = frame?.[f];
      if (!taxels) continue;
      let sfx = 0;
      let sfy = 0;
      let sfz = 0;
      let cx = 0;
      let cy = 0;
      for (let k = 0; k < nTaxels; k++) {
        const fx = taxels[k]?.[0] ?? 0;
        const fy = taxels[k]?.[1] ?? 0;
        const fz = taxels[k]?.[2] ?? 0;
        sfx += fx;
        sfy += fy;
        sfz += fz;
        curShear[k * 2] = fx;
        curShear[k * 2 + 1] = fy;
        if (layout && fz > 0.05) {
          cx += fz * layout[k][0];
          cy += fz * layout[k][1];
        }
      }
      fn[i] = sfz;
      fs[i] = Math.hypot(sfx, sfy);
      const copValid = layout && sfz > 0.2;
      const copX = copValid ? cx / sfz : 0;
      const copY = copValid ? cy / sfz : 0;

      // torque proxy + edge/center split need layout
      if (layout) {
        let tz = 0;
        // classify taxels by distance from CoP among active ones
        const dists: number[] = [];
        for (let k = 0; k < nTaxels; k++) {
          const fz = taxels[k]?.[2] ?? 0;
          if (fz > 0.05) {
            dists.push(Math.hypot(layout[k][0] - copX, layout[k][1] - copY));
          }
        }
        dists.sort((a, b) => a - b);
        const splitD =
          dists.length >= 5 ? dists[Math.floor(dists.length * 0.6)] : Infinity;

        let edgeRate = 0;
        let edgeN = 0;
        let centerRate = 0;
        let centerN = 0;
        let edgeUx = 0;
        let edgeUy = 0;
        let centerUx = 0;
        let centerUy = 0;
        const dt = i > 0 ? t[i] - t[i - 1] : 1 / rateHz;
        for (let k = 0; k < nTaxels; k++) {
          const fx = curShear[k * 2];
          const fy = curShear[k * 2 + 1];
          const fz = taxels[k]?.[2] ?? 0;
          if (fz > 0.05 && copValid) {
            const rx = layout[k][0] - copX;
            const ry = layout[k][1] - copY;
            tz += rx * fy - ry * fx;
            const m = Math.hypot(fx, fy);
            const rate =
              prevShear && dt > 1e-9
                ? Math.hypot(fx - prevShear[k * 2], fy - prevShear[k * 2 + 1]) /
                  dt
                : 0;
            const d = Math.hypot(rx, ry);
            if (d >= splitD) {
              edgeRate += rate;
              edgeN++;
              if (m > 1e-6) {
                edgeUx += fx / m;
                edgeUy += fy / m;
              }
            } else {
              centerRate += rate;
              centerN++;
              if (m > 1e-6) {
                centerUx += fx / m;
                centerUy += fy / m;
              }
            }
          }
        }
        tauZ[i] = tz;
        if (edgeN >= 2 && centerN >= 2) {
          const eAvg = edgeRate / edgeN;
          const cAvg = centerRate / centerN;
          edgeRateRatio[i] = cAvg > 1e-6 ? eAvg / cAvg : eAvg > 1e-3 ? 10 : 0;
          const eMag = Math.hypot(edgeUx, edgeUy) / edgeN;
          const cMag = Math.hypot(centerUx, centerUy) / centerN;
          if (eMag > 1e-6 && cMag > 1e-6) {
            const dot =
              ((edgeUx / edgeN) * (centerUx / centerN) +
                (edgeUy / edgeN) * (centerUy / centerN)) /
              (eMag * cMag);
            slipDiv[i] = 1 - Math.abs(Math.max(-1, Math.min(1, dot)));
          }
        }
      }
      prevShear = prevShear ?? new Float64Array(nTaxels * 2);
      prevShear.set(curShear);
    }

    const fnS = median5(fn);
    const fsS = median5(fs);
    const dFs = derivative(fsS, t);
    const hf = movingRms(dFs, Math.max(3, Math.round(rateHz * 0.11)));
    fingers.push({
      fn: fnS,
      fnRaw: fn,
      fs: fsS,
      tauZ: median5(tauZ),
      slipDiv,
      edgeRateRatio,
      hf: hf.map((v) => v / Math.max(rateHz / 30, 1)) as Float64Array,
    });
  }
  return { t, rateHz, fingers };
}

/**
 * Build from raw sidecar CSV text (91 Hz, company 163-column schema).
 * One CSV per finger; pass texts in finger order.
 */
export function buildSeriesFromRawCsvs(
  csvTexts: string[],
  layout: [number, number, number][] | null,
): TactileSeries | null {
  const parsed = csvTexts.map(parseRawCsv).filter((p) => p !== null) as Array<{
    t: Float64Array;
    taxels: Float64Array; // [n][nTaxels*3] flattened
    nTaxels: number;
  }>;
  if (!parsed.length) return null;
  const n = Math.min(...parsed.map((p) => p.t.length));
  const base = parsed[0];
  // reconstruct nested frames [i][finger][taxel][3] lazily via accessor
  const frames: number[][][][] = new Array(n);
  for (let i = 0; i < n; i++) {
    frames[i] = parsed.map((p) => {
      const row: number[][] = new Array(p.nTaxels);
      for (let k = 0; k < p.nTaxels; k++) {
        row[k] = [
          p.taxels[i * p.nTaxels * 3 + k * 3],
          p.taxels[i * p.nTaxels * 3 + k * 3 + 1],
          p.taxels[i * p.nTaxels * 3 + k * 3 + 2],
        ];
      }
      return row;
    });
  }
  return buildSeriesFromSensorFrames(
    frames as unknown as unknown[],
    Array.from(base.t.subarray(0, n)),
    layout,
  );
}

/** Truncate a series to t <= tMax. Raw sidecar CSVs keep recording through
 * the inter-episode reset period, so they can be much longer than the
 * episode's main table; detection must only see the episode window. */
export function clipSeries(s: TactileSeries, tMax: number): TactileSeries {
  let n = s.t.length;
  while (n > 0 && s.t[n - 1] > tMax) n--;
  if (n === s.t.length || n < 5) return s;
  return {
    t: s.t.slice(0, n),
    rateHz: s.rateHz,
    fingers: s.fingers.map((f) => ({
      fn: f.fn.slice(0, n),
      fnRaw: f.fnRaw.slice(0, n),
      fs: f.fs.slice(0, n),
      tauZ: f.tauZ.slice(0, n),
      slipDiv: f.slipDiv.slice(0, n),
      edgeRateRatio: f.edgeRateRatio.slice(0, n),
      hf: f.hf.slice(0, n),
    })),
  };
}

function parseRawCsv(text: string): {
  t: Float64Array;
  taxels: Float64Array;
  nTaxels: number;
} | null {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 3) return null;
  const header = lines[0].replace(/^﻿/, "").split(",");
  const iTs = header.indexOf("timestamp_ns");
  if (iTs < 0) return null;
  const iFx = header.indexOf("fx");
  const iFy = header.indexOf("fy");
  const iFz = header.indexOf("fz");
  const triples: [number, number, number][] = [];
  for (let c = 0; c < header.length; c++) {
    if (/^p_\d+_fx$/.test(header[c])) {
      const base = header[c].slice(0, -3);
      const iy = header.indexOf(base + "_fy");
      const iz = header.indexOf(base + "_fz");
      if (iy >= 0 && iz >= 0) triples.push([c, iy, iz]);
    }
  }
  const nTaxels = triples.length;
  const n = lines.length - 1;
  const t = new Float64Array(n);
  const taxels = new Float64Array(n * nTaxels * 3);
  let t0 = NaN;
  for (let r = 0; r < n; r++) {
    const cols = lines[r + 1].split(",");
    const ts = Number(cols[iTs]);
    if (Number.isNaN(t0)) t0 = ts;
    t[r] = (ts - t0) / 1e9;
    for (let k = 0; k < nTaxels; k++) {
      const [ix, iy, iz] = triples[k];
      taxels[r * nTaxels * 3 + k * 3] = Number(cols[ix]);
      taxels[r * nTaxels * 3 + k * 3 + 1] = Number(cols[iy]);
      taxels[r * nTaxels * 3 + k * 3 + 2] = Number(cols[iz]);
    }
    // Sample-and-hold over distributed-data dropouts: some auto-push frames
    // carry a valid firmware resultant but an all-zero taxel block (seen on
    // sotac raw ep6 finger 0). If the taxel block is all zero while the
    // frame's own resultant reports real force, reuse the previous frame's
    // taxels instead of injecting a false contact loss.
    if (r > 0 && iFx >= 0 && iFy >= 0 && iFz >= 0) {
      let absSum = 0;
      for (let q = 0; q < nTaxels * 3; q++) {
        absSum += Math.abs(taxels[r * nTaxels * 3 + q]);
      }
      if (absSum < 1e-6) {
        const resMag = Math.hypot(
          Number(cols[iFx]) || 0,
          Number(cols[iFy]) || 0,
          Number(cols[iFz]) || 0,
        );
        if (resMag > 0.2) {
          taxels.copyWithin(
            r * nTaxels * 3,
            (r - 1) * nTaxels * 3,
            r * nTaxels * 3,
          );
        }
      }
    }
  }
  return { t, taxels, nTaxels };
}

/**
 * Build a piecewise-linear map from main-table time to raw-stream time.
 *
 * Every table frame's tactile field is a sample-and-hold snapshot of the
 * latest raw row at capture, so matching frames to rows BY CONTENT recovers
 * (tableT, rawT) anchor pairs directly — no clock model needed. On sotac
 * the two clocks agree to ~2 ms (verified with this map), so there this is
 * a per-episode alignment CHECK. It matters for real on per-episode-folder
 * company-format data, whose raw stream is only first-sample-alignable
 * (~1 s error) — there the map supplies the missing alignment.
 *
 * Returns null when too few frames match (e.g. no raw sidecar, or an
 * episode with almost no contact). Matching uses finger 0 only and skips
 * near-zero frames (every all-zero row matches every other one).
 */
export function buildTableToRawClockMap(
  frames: unknown[],
  tableTs: number[],
  csvTexts: string[],
): ((t: number) => number) | null {
  if (!csvTexts.length) return null;
  const parsed = parseRawCsv(csvTexts[0]);
  if (!parsed) return null;
  const { t: rawT, taxels, nTaxels } = parsed;
  const nRaw = rawT.length;
  const n = Math.min(frames.length, tableTs.length);
  const tt: number[] = [];
  const rt: number[] = [];
  let r = 0;
  for (let i = 0; i < n; i++) {
    const fr = (frames[i] as number[][][])?.[0];
    if (!fr || fr.length !== nTaxels) continue;
    let l1 = 0;
    for (let k = 0; k < nTaxels; k++) {
      l1 +=
        Math.abs(fr[k]?.[0] ?? 0) +
        Math.abs(fr[k]?.[1] ?? 0) +
        Math.abs(fr[k]?.[2] ?? 0);
    }
    if (l1 < 1.0) continue; // ambiguous: near-zero frames match everywhere
    let found = -1;
    for (let rr = r; rr < nRaw; rr++) {
      let ok = true;
      const base = rr * nTaxels * 3;
      for (let k = 0; k < nTaxels && ok; k++) {
        // 0.051 tolerance: values are 0.1 N-quantized; float32 (parquet)
        // vs %.1f text (CSV) round-trips differ only far below that
        if (
          Math.abs(taxels[base + k * 3] - (fr[k]?.[0] ?? 0)) > 0.051 ||
          Math.abs(taxels[base + k * 3 + 1] - (fr[k]?.[1] ?? 0)) > 0.051 ||
          Math.abs(taxels[base + k * 3 + 2] - (fr[k]?.[2] ?? 0)) > 0.051
        ) {
          ok = false;
        }
      }
      if (ok) {
        found = rr;
        break;
      }
    }
    if (found < 0) continue;
    r = found; // next frame may hold the same row — do not skip past it
    // monotone guard: receipt jitter can briefly reorder matches
    if (rt.length && rawT[found] <= rt[rt.length - 1]) continue;
    tt.push(tableTs[i]);
    rt.push(rawT[found]);
  }
  if (tt.length < 5) return null;
  return (t: number): number => {
    if (t <= tt[0]) return rt[0] + (t - tt[0]);
    if (t >= tt[tt.length - 1])
      return rt[rt.length - 1] + (t - tt[tt.length - 1]);
    let lo = 0;
    let hi = tt.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tt[mid] <= t) lo = mid;
      else hi = mid;
    }
    const f = (t - tt[lo]) / Math.max(tt[hi] - tt[lo], 1e-9);
    return rt[lo] + f * (rt[hi] - rt[lo]);
  };
}

/** Re-clock a gripper trajectory (main-table time) onto the raw-stream time
 * base using a map from buildTableToRawClockMap. Identity when map is null. */
export function remapGripperClock(
  gripper: GripperSeries | null,
  map: ((t: number) => number) | null,
): GripperSeries | null {
  if (!gripper || !map) return gripper;
  return { t: gripper.t.map(map), pos: gripper.pos };
}

// ---------------------------------------------------------------- changepoints

/**
 * Greedy binary segmentation on the summed normalized [Fn, Fs] signal.
 * Returns changepoint times (s). L2 cost; stops when gain falls below
 * `penalty * global variance` or maxSegments reached.
 */
export function binsegChangepoints(
  series: TactileSeries,
  maxSegments = 14,
  penalty = 0.02,
): number[] {
  const n = series.t.length;
  if (n < 10) return [];
  // combined signal: normalized Fn + Fs across fingers
  const sig = new Float64Array(n);
  for (const f of series.fingers) {
    let mx = 1e-9;
    for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(f.fn[i]), f.fs[i]);
    for (let i = 0; i < n; i++) sig[i] += (f.fn[i] + f.fs[i]) / mx;
  }
  // prefix sums for O(1) segment cost
  const ps = new Float64Array(n + 1);
  const ps2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    ps[i + 1] = ps[i] + sig[i];
    ps2[i + 1] = ps2[i] + sig[i] * sig[i];
  }
  const segCost = (a: number, b: number): number => {
    const m = b - a;
    if (m <= 0) return 0;
    const s = ps[b] - ps[a];
    return ps2[b] - ps2[a] - (s * s) / m;
  };
  const globalVar = segCost(0, n) / n;
  const minSize = Math.max(3, Math.round(series.rateHz * 0.1));
  const bounds: number[] = [0, n];
  for (let iter = 0; iter < maxSegments; iter++) {
    let bestGain = 0;
    let bestIdx = -1;
    let bestPos = -1;
    for (let b = 0; b < bounds.length - 1; b++) {
      const a = bounds[b];
      const c = bounds[b + 1];
      if (c - a < 2 * minSize) continue;
      const base = segCost(a, c);
      for (let p = a + minSize; p <= c - minSize; p++) {
        const gain = base - segCost(a, p) - segCost(p, c);
        if (gain > bestGain) {
          bestGain = gain;
          bestIdx = b;
          bestPos = p;
        }
      }
    }
    if (bestPos < 0 || bestGain < penalty * globalVar * n) break;
    bounds.splice(bestIdx + 1, 0, bestPos);
  }
  return bounds.slice(1, -1).map((i) => series.t[i]);
}

// ---------------------------------------------------------------- detection

interface RawEvent extends DetectedEvent {
  order: number;
}

export function detectEvents(
  series: TactileSeries,
  gripper: GripperSeries | null,
  thresholds?: Partial<DetectionThresholds>,
): AutoLabelResult {
  const th: DetectionThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const { t, rateHz, fingers } = series;
  const n = t.length;
  const flags: string[] = [];
  const events: RawEvent[] = [];
  const dur = n ? t[n - 1] : 0;

  // gripper velocity resampled onto series time base. The gripper's
  // timestamps must be ON that base — when the series comes from raw CSVs
  // whose clock may differ from the main table's (company-format data),
  // callers re-clock it first via buildTableToRawClockMap +
  // remapGripperClock. On sotac the clocks agree to ~2 ms.
  const gvel = new Float64Array(n);
  if (gripper && gripper.t.length > 2) {
    let j = 1;
    for (let i = 0; i < n; i++) {
      while (j < gripper.t.length - 1 && gripper.t[j] < t[i]) j++;
      const dt = gripper.t[j] - gripper.t[j - 1];
      gvel[i] = dt > 1e-9 ? (gripper.pos[j] - gripper.pos[j - 1]) / dt : 0;
    }
  }

  const maxFn = Math.max(...fingers.map((f) => Math.max(...Array.from(f.fn))));
  if (maxFn < th.contactEnterN) {
    return {
      subtasks: dur > 0 ? [{ label: "approach", startS: 0, endS: dur }] : [],
      events: [],
      flags: ["no_contact"],
    };
  }

  // ---- per-finger threshold pass
  fingers.forEach((f, fi) => {
    let inContact = false;
    let contactStart = -1;
    let stableMarked = false;
    let slipActive = -1;
    let incActive = -1;
    let rotActive = -1;
    let liftActive = -1;
    let lastPlaceEnd = -Infinity;
    let belowSince = -1;
    let aboveSince = -1;
    const dFn = derivative(f.fn, t);
    const dFs = derivative(f.fs, t);
    const stableWin = Math.max(3, Math.round(th.stableWindowS * rateHz));

    for (let i = 0; i < n; i++) {
      const fn = f.fn[i];
      // contact enter/exit with hysteresis, both edges debounced
      if (!inContact && fn > th.contactEnterN) {
        if (aboveSince < 0) aboveSince = i;
        if (t[i] - t[aboveSince] >= ENTER_MIN_S) {
          inContact = true;
          contactStart = aboveSince;
          stableMarked = false;
          events.push({
            label: "contact_onset",
            startS: t[aboveSince],
            endS: t[aboveSince],
            finger: fi,
            confidence: "medium",
            order: events.length,
          });
          aboveSince = -1;
        }
      } else if (!inContact) {
        aboveSince = -1;
      } else if (inContact && fn < th.contactExitN) {
        // Debounced exit: require the force to stay below the exit level for
        // a minimum duration. Single-frame zero dropouts (recording-path
        // artifacts, e.g. sotac raw ep6 finger 0) otherwise chatter into
        // drop / contact_onset / slip triplets.
        if (belowSince < 0) belowSince = i;
        if (t[i] - t[belowSince] >= EXIT_MIN_S) {
          inContact = false;
          const exitIdx = belowSince;
          belowSince = -1;
          const opening =
            gvel[exitIdx] > th.gripperVelEps || gvel[i] > th.gripperVelEps;
          events.push({
            label: opening ? "release" : "drop",
            startS: t[exitIdx],
            endS: t[exitIdx],
            finger: fi,
            confidence: opening
              ? "medium"
              : f.hf[i] > th.hfExit
                ? "medium"
                : "low",
            order: events.length,
          });
          slipActive = incActive = rotActive = liftActive = -1;
        }
      } else if (inContact) {
        belowSince = -1;
      }
      if (!inContact) continue;

      // grasp_stable: first window after contact where Fn is high & flat
      if (
        !stableMarked &&
        i - contactStart >= stableWin &&
        fn > th.stableMinN &&
        relStd(f.fn, i - stableWin, i) < th.stableRelStd &&
        f.slipDiv[i] < th.slipDivEnter
      ) {
        stableMarked = true;
        events.push({
          label: "grasp_stable",
          startS: t[i],
          endS: t[i],
          finger: fi,
          confidence: "medium",
          order: events.length,
        });
      }

      // lift: dFn/dt spike while jaw static
      if (
        stableMarked &&
        Math.abs(gvel[i]) < th.gripperVelEps &&
        dFn[i] > th.liftRateNps
      ) {
        if (liftActive < 0) liftActive = i;
        else if (t[i] - t[liftActive] >= th.liftMinS) {
          events.push({
            label: "lift",
            startS: t[liftActive],
            endS: t[i],
            finger: fi,
            confidence: "medium",
            order: events.length,
          });
          liftActive = -2; // fired once per contact
        }
      } else if (liftActive >= 0) liftActive = -1;

      // gross slip — only meaningful under real grasp force
      const slipNow =
        fn > th.stableMinN &&
        f.hf[i] > th.hfEnter &&
        Math.abs(dFs[i]) > th.slipShearRateNps;
      if (slipActive < 0 && slipNow) slipActive = i;
      else if (slipActive >= 0 && f.hf[i] < th.hfExit) {
        events.push({
          label: "slip",
          startS: t[slipActive],
          endS: t[i],
          finger: fi,
          confidence: "medium",
          order: events.length,
        });
        slipActive = -1;
      }

      // incipient slip (always low confidence pending C6)
      const incNow =
        f.slipDiv[i] > th.slipDivEnter &&
        f.edgeRateRatio[i] > th.edgeRateRatioEnter;
      if (incActive < 0 && incNow) incActive = i;
      else if (incActive >= 0 && !incNow) {
        if (t[i] - t[incActive] >= th.incipientMinS) {
          events.push({
            label: "incipient_slip",
            startS: t[incActive],
            endS: t[i],
            finger: fi,
            confidence: "low",
            info: `slipDiv max ${f.slipDiv[incActive].toFixed(2)}`,
            order: events.length,
          });
        }
        incActive = -1;
      }

      // rotation
      const rotNow = Math.abs(f.tauZ[i]) > th.rotationTauNmm;
      if (rotActive < 0 && rotNow) rotActive = i;
      else if (rotActive >= 0 && !rotNow) {
        if (t[i] - t[rotActive] >= th.rotationMinS) {
          events.push({
            label: "rotation",
            startS: t[rotActive],
            endS: t[i],
            finger: fi,
            confidence: "medium",
            order: events.length,
          });
        }
        rotActive = -1;
      }

      // place: Fn drops by placeDropFrac within window while jaw static,
      // AND the drop persists. Grasp settling and slips also produce brief
      // force dips; a genuine place transfers the object's weight to the
      // surface, so the force must stay low afterwards instead of
      // recovering. Without this check the detector mislabels grasp-phase
      // dips as "place" (seen on sotac ep grasp at ~6.5s).
      const win = Math.max(2, Math.round(th.placeWindowS * rateHz));
      if (
        stableMarked &&
        i >= win &&
        Math.abs(gvel[i]) < th.gripperVelEps &&
        f.fn[i - win] > th.stableMinN &&
        fn < f.fn[i - win] * (1 - th.placeDropFrac)
      ) {
        // Persistence: force must not recover above 50% of the pre-drop
        // level within the next ~0.7s (re-grips and slip recoveries do).
        const refFn = f.fn[i - win];
        const holdN = Math.max(2, Math.round(0.7 * rateHz));
        let recovered = false;
        for (let j = i + 1; j < Math.min(f.fn.length, i + holdN); j++) {
          if (f.fn[j] > refFn * 0.5) {
            recovered = true;
            break;
          }
        }
        if (!recovered && t[i] - lastPlaceEnd >= 0.5) {
          events.push({
            label: "place",
            startS: t[i - win],
            endS: t[i],
            finger: fi,
            confidence: "medium",
            order: events.length,
          });
        }
        if (!recovered) lastPlaceEnd = t[i];
      }
    }

    // place backfill: in real demos the object is often set down in the
    // same motion as the gripper opening, so the jaw-static gate above
    // never fires (the final force drop and the release coincide). If this
    // finger has a release but no place in the preceding 2 s, recover the
    // onset of the final force drop and label it as the place.
    const releases = events.filter(
      (e) => e.finger === fi && e.label === "release",
    );
    for (const rel of releases) {
      const hasPlace = events.some(
        (e) =>
          e.finger === fi &&
          e.label === "place" &&
          rel.startS - e.endS <= 2 &&
          e.endS <= rel.startS + 1e-6,
      );
      if (hasPlace) continue;
      let relIdx = 0;
      while (relIdx < n - 1 && t[relIdx] < rel.startS) relIdx++;
      const back = Math.max(0, relIdx - Math.round(1.5 * rateHz));
      let plateau = 0;
      for (let j = back; j <= relIdx; j++) plateau = Math.max(plateau, f.fn[j]);
      if (plateau < th.stableMinN) continue;
      let onset = relIdx;
      while (onset > back && f.fn[onset] < plateau * 0.6) onset--;
      if (onset >= relIdx) continue;
      events.push({
        label: "place",
        startS: t[onset],
        endS: rel.startS,
        finger: fi,
        confidence: "medium",
        info: "inferred",
        order: events.length,
      });
    }
  });

  // ---- brief strong contacts the entry debounce erased (failed grabs on
  // the pad's edge — see BRIEF_CONTACT_*). Evaluated on the UNFILTERED
  // force: median-5 flattens a 3-4-sample graze (ep54's 2.4 N / 0.044 s
  // second attempt) below every threshold. Only before the finger's first
  // held contact — later sub-debounce spikes are settling/impact
  // transients, not attempts.
  fingers.forEach((f, fi) => {
    let firstRealS = Infinity;
    for (const e of events) {
      if (
        e.finger === fi &&
        e.label === "contact_onset" &&
        e.startS < firstRealS
      ) {
        firstRealS = e.startS;
      }
    }
    let start = -1;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      if (f.fnRaw[i] > th.contactEnterN) {
        if (start < 0) {
          start = i;
          peak = 0;
        }
        if (f.fnRaw[i] > peak) peak = f.fnRaw[i];
      } else if (start >= 0) {
        const durS = t[i - 1] - t[start];
        if (
          t[start] >= BRIEF_CONTACT_SKIP_START_S &&
          t[start] < firstRealS &&
          durS >= BRIEF_CONTACT_MIN_S &&
          durS < ENTER_MIN_S &&
          peak >= BRIEF_CONTACT_STRONG_N
        ) {
          events.push({
            label: "contact_onset",
            startS: t[start],
            endS: t[start],
            finger: fi,
            confidence: "low",
            info: `brief ${peak.toFixed(1)}N`,
            order: events.length,
          });
          events.push({
            label: "drop",
            startS: t[i - 1],
            endS: t[i - 1],
            finger: fi,
            confidence: "low",
            order: events.length,
          });
        }
        start = -1;
      }
    }
  });

  // ---- changepoint agreement
  const cps = binsegChangepoints(series);
  for (const ev of events) {
    const near = cps.some((c) => Math.abs(c - ev.startS) <= th.agreeWindowS);
    if (near && ev.confidence === "medium") ev.confidence = "high";
  }
  for (const c of cps) {
    const near = events.some(
      (e) => Math.abs(e.startS - c) <= th.agreeWindowS * 2,
    );
    if (!near) flags.push(`unlabeled_transition@${c.toFixed(1)}s`);
  }

  // ---- state machine cleanup (per finger)
  const ORDER: Record<EventLabel, number> = {
    contact_onset: 0,
    grasp_stable: 1,
    lift: 2,
    incipient_slip: 2,
    slip: 2,
    rotation: 2,
    place: 3,
    release: 4,
    drop: 4,
  };
  const cleaned: DetectedEvent[] = [];
  const perFinger = new Map<number, RawEvent[]>();
  for (const e of events) {
    if (!perFinger.has(e.finger)) perFinger.set(e.finger, []);
    perFinger.get(e.finger)!.push(e);
  }
  for (const list of perFinger.values()) {
    list.sort((a, b) => a.startS - b.startS || a.order - b.order);
    let phase = -1;
    for (const e of list) {
      const o = ORDER[e.label];
      // mid-phase events (2) legal only after grasp; terminal events reset
      if (o === 0) phase = 0;
      else if (o === 1 && phase < 0) continue;
      else if (o === 2 && phase < 1 && e.label !== "slip") continue;
      if (o === 1) phase = 1;
      if (o >= 4) phase = -1;
      if (e.endS - e.startS > 0 && e.endS - e.startS < th.minEventS) continue;
      cleaned.push(e);
    }
  }
  cleaned.sort((a, b) => a.startS - b.startS);

  // ---- contact bouts = grasp trials
  // Per finger, a contact_onset opens a span and the next release/drop on
  // that finger closes it; overlapping or near spans across fingers merge
  // into one hand-level bout = one physical trial. The bout holding the
  // LAST grasp_stable is the grasp that counts; every bout before it is a
  // failed trial. Keying on the FIRST stability instead mistakes a failed
  // trial's brief false stability (squeezing the object against the
  // surface) for the grasp and starts transport mid-failure — sotac ep56,
  // video-verified: trial 1 holds 5.1-6.8 s and is lost, the real grasp
  // only begins at 9.0 s.
  const fingerSpans: { startS: number; endS: number }[] = [];
  {
    const byFinger = new Map<number, DetectedEvent[]>();
    for (const e of cleaned) {
      if (!byFinger.has(e.finger)) byFinger.set(e.finger, []);
      byFinger.get(e.finger)!.push(e);
    }
    for (const list of byFinger.values()) {
      let open = -1;
      for (const e of list) {
        if (e.label === "contact_onset") {
          if (open < 0) open = e.startS;
        } else if (e.label === "release" || e.label === "drop") {
          if (open >= 0) {
            fingerSpans.push({ startS: open, endS: e.startS });
            open = -1;
          }
        }
      }
      if (open >= 0) fingerSpans.push({ startS: open, endS: dur });
    }
  }
  fingerSpans.sort((a, b) => a.startS - b.startS);
  const bouts: { startS: number; endS: number }[] = [];
  for (const s of fingerSpans) {
    const cur = bouts[bouts.length - 1];
    if (cur && s.startS <= cur.endS + 0.5) {
      cur.endS = Math.max(cur.endS, s.endS);
    } else {
      bouts.push({ ...s });
    }
  }
  const lastStable = [...cleaned]
    .reverse()
    .find((e) => e.label === "grasp_stable");
  let graspBout = bouts.length ? bouts[bouts.length - 1] : null;
  if (lastStable) {
    const holding = bouts.find(
      (b) =>
        lastStable.startS >= b.startS - 1e-6 &&
        lastStable.startS <= b.endS + 1e-6,
    );
    if (holding) graspBout = holding;
  }

  // ---- subtasks from gripper trajectory
  const subtasks: DetectedSubtask[] = [];
  if (gripper && gripper.t.length > 2 && dur > 0) {
    const firstStable = cleaned.find((e) => e.label === "grasp_stable");
    const sustain = Math.max(2, Math.round(0.15 * rateHz));
    let run = 0;
    // sustained CLOSING runs; the grasp anchor must pick among ALL bouts,
    // not the first one — approach-phase jaw motion otherwise starts the
    // grasp segment seconds before the object is touched
    const closeRuns: number[] = []; // start index of each sustained closing bout
    const closeRunEnds: number[] = []; // last closing index of the same bout
    // sustained OPENING runs (symmetric with closing: jitter never counts)
    const openRuns: number[] = []; // start index of each sustained opening bout
    let openRun = 0;
    for (let i = 0; i < n; i++) {
      if (gvel[i] < -th.gripperVelEps) {
        run++;
        if (run === sustain) closeRuns.push(i - run + 1);
      } else {
        if (run >= sustain) closeRunEnds.push(i - 1);
        run = 0;
      }
      if (gvel[i] > th.gripperVelEps) {
        openRun++;
        if (openRun === sustain) {
          const start = i - openRun + 1;
          if (!firstStable || t[start] > firstStable.startS) {
            openRuns.push(start);
          }
        }
      } else openRun = 0;
    }
    // place_release starts at the opening bout that leads to the FINAL
    // release/drop (not the first twitch after grasp). Fallback: last bout.
    const lastTerminal = [...cleaned]
      .reverse()
      .find((e) => e.label === "release" || e.label === "drop");
    let openStart = -1;
    if (openRuns.length > 0) {
      if (lastTerminal) {
        // latest opening bout that starts at/before the terminal event
        // (small slack: release fires slightly after opening begins)
        const cands = openRuns.filter(
          (s) => t[s] <= lastTerminal.startS + 0.05,
        );
        openStart = cands.length
          ? cands[cands.length - 1]
          : openRuns[openRuns.length - 1];
      } else {
        openStart = openRuns[openRuns.length - 1];
      }
    }
    // grasp starts at the closing motion that LEADS TO the grasp's contact
    // (mirrors how place_release anchors to the final release below). Using
    // the first closing bout instead fires during approach on ~40% of
    // episodes — the single most frequent hand-correction in the published
    // annotations. Two guards: the contact reference is the contact
    // preceding the first stable grasp (approach brushes also emit
    // contact_onset), and connected closing bouts are walked back as one
    // motion (a staged close pauses; an approach twitch is seconds apart).
    if (run >= sustain) closeRunEnds.push(n - 1);
    // the grasp anchors to the closing motion leading to the GRASP BOUT's
    // first contact (never a failed trial's)
    const contactRefS = graspBout ? graspBout.startS : null;
    const prevBoutEndS = graspBout
      ? (bouts[bouts.indexOf(graspBout) - 1]?.endS ?? -Infinity)
      : -Infinity;
    let closeStart = -1;
    if (closeRuns.length > 0) {
      if (contactRefS !== null) {
        // latest closing bout starting at/before the contact (small slack:
        // contact_onset fires only after the debounced force crossing) ...
        let k = -1;
        for (let j = 0; j < closeRuns.length; j++) {
          if (t[closeRuns[j]] <= contactRefS + 0.05) k = j;
        }
        if (k < 0) k = 0;
        // ... then back through bouts separated by sub-second pauses, never
        // crossing into the previous failed trial
        const CHAIN_GAP_S = 1.0;
        while (
          k > 0 &&
          t[closeRuns[k]] - t[closeRunEnds[k - 1]] <= CHAIN_GAP_S &&
          t[closeRuns[k - 1]] > prevBoutEndS
        ) {
          k--;
        }
        closeStart = closeRuns[k];
      } else {
        closeStart = closeRuns[0];
      }
    }
    let tClose = closeStart >= 0 ? t[closeStart] : dur * 0.25;
    // a failed trial belongs to approach, not grasp
    if (tClose < prevBoutEndS) tClose = prevBoutEndS;
    // transport starts when the grasp is READY — every finger's grip has
    // stabilized — not at the first finger's stability: her hand-corrected
    // transport boundaries sit 0.5–1.9 s after first-stability, 12 of 12
    // later. A second finger stabilizing more than SETTLE_CAP_S after the
    // first is a re-grip, not settling, and must not delay transport
    // (sotac ep24). The ideal anchor would be the lift event, but the lift
    // detector never fires on sotac — the foam ball's weight transfer
    // stays under liftRateNps — a defect of its own.
    const SETTLE_CAP_S = 1.5;
    const firstStableByFinger = new Map<number, number>();
    for (const e of cleaned) {
      if (
        e.label === "grasp_stable" &&
        e.startS >= tClose &&
        !firstStableByFinger.has(e.finger)
      ) {
        firstStableByFinger.set(e.finger, e.startS);
      }
    }
    let tStableRaw = tClose + 1;
    if (firstStableByFinger.size > 0) {
      const firsts = [...firstStableByFinger.values()];
      tStableRaw = Math.min(
        Math.max(...firsts),
        Math.min(...firsts) + SETTLE_CAP_S,
      );
    }
    const tStable = Math.min(Math.max(tStableRaw, tClose), dur);
    const tOpen = Math.max(openStart >= 0 ? t[openStart] : dur * 0.9, tStable);
    subtasks.push({ label: "approach", startS: 0, endS: tClose });
    subtasks.push({ label: "grasp", startS: tClose, endS: tStable });
    subtasks.push({ label: "transport", startS: tStable, endS: tOpen });
    subtasks.push({ label: "place_release", startS: tOpen, endS: dur });
  }

  // failed grasp trials: every contact bout before the grasp bout —
  // "gripped, lost it (dropped or slid out), tried again". Surfaced as
  // flags only: the Table VIII taxonomy has no retry class, so nothing is
  // added to the event stream until that question is settled with its
  // owner. Validated against episode metadata's hand-recorded attempt
  // count (which itself undercounts — sotac ep54, video-verified).
  if (graspBout) {
    for (const b of bouts) {
      if (b === graspBout) break;
      flags.push(`failed_attempt@${b.startS.toFixed(1)}-${b.endS.toFixed(1)}s`);
    }
  }

  return { subtasks, events: cleaned, flags };
}

// ---------------------------------------------------------------- atoms

/** Serialize a result into v3.1 language atoms for the annotations editor. */
export function resultToAtoms(result: AutoLabelResult): LanguageAtom[] {
  const atoms: LanguageAtom[] = [];
  for (const s of result.subtasks) {
    atoms.push({
      role: "assistant", // matches the editor's subtask convention
      content: s.label,
      style: "subtask",
      timestamp: s.startS,
      camera: null,
      tool_calls: null,
    });
  }
  for (const e of result.events) {
    const span = e.endS > e.startS ? ` ${(e.endS - e.startS).toFixed(2)}s` : "";
    const finger = e.finger >= 0 ? ` f${e.finger}` : "";
    atoms.push({
      role: "user",
      content: `[auto:${e.confidence}] ${e.label}${finger}${span}${""}`,
      style: "interjection",
      timestamp: e.startS,
      camera: null,
      tool_calls: null,
    });
  }
  return atoms.sort((a, b) => a.timestamp - b.timestamp);
}
