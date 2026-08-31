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

import type { LanguageAtom } from "@/types/language.types";

import { screenBackgroundVotes, SCREEN_VOTE_MIN } from "./signalScreen";

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
  | "drop"
  // real names (Zheng's marker-honesty pass): assigned by the rename
  // pass at the END of detection, purely output-semantic — every
  // anchor, bout, flag and gate is computed before any rename.
  | "finger_unload" // real force exit while the HAND still holds
  | "sensor_residual" // terminal lagging the hand's release: sensor discharge
  | "phantom"; // post-task-gate classified, video-verified not-contact

export type SubtaskLabel = "approach" | "grasp" | "transport" | "place_release";

export type Confidence = "high" | "medium" | "low";

export interface DetectedEvent {
  label: EventLabel;
  startS: number;
  endS: number; // === startS for instantaneous events
  finger: number; // -1 = merged/any
  confidence: Confidence;
  info?: string;
  /** Measured quantities behind the marker (Zheng: "fill in the data
   * info together with the marker" — the upstream code dropped its info
   * suffixes and never replaced them). Serialized as a compact suffix
   * in the atom content: n = force (N), jaw = net jaw travel (units),
   * hf = high-frequency shear energy, div = slip divergence, tau =
   * spin torque (N*mm). */
  data?: Record<string, number>;
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
  /** fz-weighted center of pressure along the finger long axis (mm, +Y
   * of the taxel layout); NaN when unloaded (< 0.2 N) or without layout.
   * Motion of this point is object motion RELATIVE TO THE PAD — the
   * signal grip force cannot carry (ep23: force decays 2.6→1.2 N while
   * CoP slides 4 mm down the finger; a static hold decays force too,
   * but its CoP stays put). */
  copY?: Float64Array;
  /** |sum of taxel (fx, fy)| UNsmoothed — the signal-screen featurizer
   * (signalScreen.ts) needs the same channels its reference corpus was
   * built from, without median-5 phase distortion. */
  fsRaw?: Float64Array;
  /** count of taxels with |fz| > 0.15 N (above the 0.1 N/LSB floor) —
   * contact-patch size channel for the signal screen. */
  active?: Float64Array;
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

/** ARM joint positions (everything except the jaw), per sample. Carries
 * the facts fingertip force cannot: whether the arm is moving, and —
 * via NET displacement — whether that motion goes anywhere. Carrying
 * accumulates net joint rotation; in-place grasp adjustment jiggles with
 * little net progress. Transport anchors to this — a light object's
 * weight transfer is invisible in grip force (the lift detector never
 * fires on sotac), but a carrying arm is unmissable. */
export interface ArmMotionSeries {
  t: number[]; // seconds
  joints: number[][]; // per sample: non-gripper joint positions (units)
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

/** Release vs drop is decided by NET jaw-opening travel in a window
 * around the force exit, not by instantaneous velocity, and never by
 * place context (that was circular: place is backfilled FROM releases).
 * Corpus audit of all 150 terminals: the old two-instant velocity test
 * missed 11 real releases whose opening bout fell between its samples
 * (ep48: twin fingers exit 0.02 s apart, one caught, one missed), and
 * the place-context rescue produced video-verified false releases on
 * ep24 (approach fumble at 5.23 s, jaw CLOSING 16 units) and ep21.
 * Window is asymmetric — placement transfers weight before the jaw
 * opens (ep33: exit 0.52 s before opening), adhesion unloads after it
 * (ep50: opening 0.78 s before exit). NET travel keeps attempt churn
 * as drops: the jaw jiggles open near a fumbled graze but is closing
 * overall (ep16 −13, ep22 −15, ep49 −7 units). Threshold sits between
 * the largest churn travel (+0.7, ep40) and the smallest real-release
 * travel (+2.8, ep48).
 *
 * Closing veto: opening in the FORWARD half only counts if the jaw was
 * not actively closing when the force exited. A squeeze-out — the
 * object escaping while the jaw clamps — is followed within a second by
 * the retry's pre-open, which the forward window would otherwise read
 * as a release (ep47 @4.575, video-verified: ball escapes with the jaw
 * 5.7 units into a closing motion, retry opens +22.8 right after). */
const RELEASE_TRAVEL_MIN = 2.0;
const RELEASE_WIN_BEFORE_S = 0.5;
const RELEASE_WIN_AFTER_S = 1.0;
const RELEASE_CLOSING_VETO = -1.0;

/** Sustained loosening slide (Zheng's ep23 video finding, 2026-08-31):
 * the object sliding through an ESTABLISHED grip while the jaw loosens —
 * the reflex-relevant precursor a controller could correct by re-closing.
 * Detected on CoP travel, not force: >= SLIDE_MIN_MM of fz-weighted CoP
 * motion along the finger within SLIDE_WIN_S, while the jaw net-opened
 * >= SLIDE_JAW_OPEN_MIN over the same window. Corpus census (69 slide
 * events >= 2 mm/1 s): 62 happen under a CLOSING jaw (-10..-35 units) =
 * grasp-formation seating (ep30 video-verified normal) and die on the
 * jaw-opening gate alone. The 7 jaw-opening survivors were all
 * video-adjudicated, giving two vetoes:
 *  - squeeze rebound: foam pressed hard springs the jaw back open while
 *    grip HOLDS (ep22 @6.6, ep31 @9.8, ep56 @5.7 — all preceded by a
 *    >= 5-unit close within 1.5 s; real slides: ep48 -0.3, ep23 +7.8).
 *  - terminal mechanics: unloading at a place/release is not an in-grip
 *    slide (ep53 @9.7, place 0.46 s ahead; ep23's own place is 1.48 s
 *    ahead — THIN margin, re-derive on new rigs).
 * Survivors: ep23 @10.2 (ball slides 2.5 mm as jaw opens +5.1 — Zheng's
 * verified loosening slide) and ep48 @11.3 (cup rotating out of the
 * jaws 0.7 s before its tauZ spike — verified escape precursor). */
const SLIDE_WIN_S = 1.0;
const SLIDE_MIN_MM = 2.0;
const SLIDE_JAW_OPEN_MIN = 1.0;
const SLIDE_SQUEEZE_LOOKBACK_S = 1.5;
const SLIDE_SQUEEZE_VETO_U = -5.0;
const SLIDE_TERMINAL_VETO_S = 1.0;
const SLIDE_LOAD_MIN_N = 1.0;
const SLIDE_MED_HALF_S = 0.15;
const SLIDE_MERGE_GAP_S = 1.0;

/** Staggered peel-offs: release is a HAND action but fingers exit
 * staggered — the gel can let go while the partner still holds and the
 * jaw only opens later (ep25 f1 peels off the placed ball at 11.68 s,
 * jaw opens 2.5 s later; video-verified), or lag after the jaw already
 * opened (ep41 f1 unloads 1.3 s after f0's jaw-visible release). Such
 * exits are upgraded drop -> release when the finger was HOLDING in
 * that very bout and does not re-contact right away (a fumble re-grabs
 * immediately — ep24). Decay shape was tried and rejected: measured
 * peel exits cliff in 0.01 s while real drops can fade over 1.2 s. */
const PEEL_RECONTACT_S = 1.5;
const PEEL_EARLY_MAX_S = 3.0;
const PEEL_LATE_MAX_S = 1.5;

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
 * Remove the wandering per-taxel zero from a `[frame][finger][taxel][3]`
 * sequence. The firmware zeroes only once per SESSION (at connect); gel
 * relaxation + thermal drift leave phantom force in later episodes AND
 * keep wandering within an episode — sotac ep43 starts at 1.8 N standing
 * and drifts back over the contact threshold by 2.1 s (video-verified:
 * pad in the air; her episode note says "tactile baseline noise on finger
 * 0 at episode start"). The baseline initializes from the first 0.4 s and
 * then TRACKS the signal (tau ~1.5 s) whenever the finger is idle — total
 * force within QUIET_MARGIN_N — and freezes the moment real contact loads
 * the pad, so grip force is never absorbed. Cost: contacts that ramp in
 * slower than the tracker and stay under ~1 N are absorbed as drift; fast
 * onsets keep the full 0.15 N sensitivity.
 *
 * ONE implementation for detection AND display: the series builder feeds
 * the detector from this, and the tactile panels render it, so the force
 * arrows a reviewer sees are exactly what the auto-labeler judged.
 */
export function applyAdaptiveBaseline(
  frames: unknown[],
  timestamps: number[],
  gripper?: GripperSeries | null,
): number[][][][] | null {
  if (!frames.length || !timestamps.length) return null;
  const first = frames[0] as number[][][];
  if (!Array.isArray(first) || !Array.isArray(first[0])) return null;
  const nFingers = first.length;
  const nTaxels = first[0].length;
  const n = Math.min(frames.length, timestamps.length);
  const t = timestamps;
  const dur = t[n - 1] - t[0];
  const rateHz = dur > 0 ? (n - 1) / dur : 30;
  const QUIET_MARGIN_N = 1.0;
  const BASELINE_TAU_S = 1.5;

  // Context-gated re-zero (Zheng): while the jaw still sits at its
  // STARTING openness, nothing has been gripped yet — so the initial
  // per-taxel zero is the median over that whole approach plateau, not
  // just the first 0.4 s. This catches what the idle tracker cannot: an
  // offset that SETTLES IN mid-approach and crosses the contact
  // threshold locks itself in as "contact" and freezes the tracker
  // forever (ep47 f0: settles at 1.41 s with the jaw untouched until
  // ~3.7 s — present for >60% of the plateau, so the median absorbs
  // it; previously it never exited, welded every trial into one bout
  // and corrupted the grasp anchor to 3.71 s). The median is immune to
  // brief real grazes during approach. Two live-tracking alternatives
  // were tried and REVERTED: a fast-tau tracker over open-jaw windows
  // absorbed half of every transient graze and poisoned the baseline
  // for the rest of the episode (ep24 place_release slid 10.97 ->
  // 9.61), and a max-open post-release window ate the tail of real
  // releases. Post-release residuals stay handled by the post-task
  // gate until the recorder-side per-episode re-zero. Assumes episodes
  // START jaw-open (true for sotac; re-check for company data).
  // The plateau ends at the first meaningful closing from the jaw's
  // RUNNING MAXIMUM, not from its start position: episodes can begin
  // with the jaw mid-closed from the previous episode's reset (ep47
  // starts at 18, opens to 39 at 1.5 s) — measured against the start
  // position such an episode never "closes" and the window would
  // silently become the whole episode, putting real grip force under
  // the median.
  let baseWinSecs = 0.4;
  if (gripper && gripper.t.length > 2) {
    let runMax = -Infinity;
    for (let j = 0; j < gripper.t.length; j++) {
      if (gripper.pos[j] > runMax) runMax = gripper.pos[j];
      if (gripper.pos[j] < runMax - 2) {
        baseWinSecs = Math.max(0.4, gripper.t[j] - t[0]);
        break;
      }
    }
  }
  const baseWin = Math.min(n, Math.max(3, Math.round(rateHz * baseWinSecs)));

  const out: number[][][][] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = new Array(nFingers);
  }
  for (let f = 0; f < nFingers; f++) {
    const base = new Float64Array(nTaxels * 3);
    {
      const buf: number[] = new Array(baseWin);
      for (let k = 0; k < nTaxels; k++) {
        for (let ax = 0; ax < 3; ax++) {
          let m = 0;
          for (let i = 0; i < baseWin; i++) {
            const v = (frames[i] as number[][][])?.[f]?.[k]?.[ax];
            if (typeof v === "number") buf[m++] = v;
          }
          if (m > 0) {
            const s = buf.slice(0, m).sort((a, b) => a - b);
            base[k * 3 + ax] = s[Math.floor(m / 2)];
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const taxels = (frames[i] as number[][][])?.[f];
      const row: number[][] = new Array(nTaxels);
      let sfx = 0;
      let sfy = 0;
      let sfz = 0;
      for (let k = 0; k < nTaxels; k++) {
        const fx = (taxels?.[k]?.[0] ?? 0) - base[k * 3];
        const fy = (taxels?.[k]?.[1] ?? 0) - base[k * 3 + 1];
        const fz = (taxels?.[k]?.[2] ?? 0) - base[k * 3 + 2];
        row[k] = [fx, fy, fz];
        sfx += fx;
        sfy += fy;
        sfz += fz;
      }
      out[i][f] = row;
      // idle → track the wandering zero; loaded → freeze
      if (
        taxels &&
        Math.abs(sfz) < QUIET_MARGIN_N &&
        Math.hypot(sfx, sfy) < QUIET_MARGIN_N
      ) {
        const dt = i > 0 ? t[i] - t[i - 1] : 1 / rateHz;
        const alpha = Math.min(1, dt / BASELINE_TAU_S);
        for (let k = 0; k < nTaxels; k++) {
          for (let ax = 0; ax < 3; ax++) {
            const raw = taxels[k]?.[ax] ?? 0;
            base[k * 3 + ax] += alpha * (raw - base[k * 3 + ax]);
          }
        }
      }
    }
  }
  return out;
}

/**
 * Build a TactileSeries from the 30 Hz main-table sensor frames.
 * `frames[i]` is a nested array of shape [nFingers][nTaxels][3] (fx, fy, fz).
 * `layout` gives per-taxel [x, y, z] mm positions (finger long axis = +Y).
 */
export function buildSeriesFromSensorFrames(
  frames: unknown[],
  timestamps: number[],
  layout: [number, number, number][] | null,
  gripper?: GripperSeries | null,
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

  // one implementation of the drift correction, shared with the display
  const corrected = applyAdaptiveBaseline(frames, timestamps, gripper);
  const src: unknown[] = corrected ?? frames;

  const fingers: FingerSeries[] = [];
  for (let f = 0; f < nFingers; f++) {
    const fn = new Float64Array(n);
    const fs = new Float64Array(n);
    const tauZ = new Float64Array(n);
    const slipDiv = new Float64Array(n);
    const edgeRateRatio = new Float64Array(n);
    const copYSeries = new Float64Array(n).fill(NaN);
    const active = new Float64Array(n);
    let prevShear: Float64Array | null = null; // [nTaxels*2]
    const curShear = new Float64Array(nTaxels * 2);

    for (let i = 0; i < n; i++) {
      const frame = src[i] as number[][][];
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
        if (Math.abs(fz) > 0.15) active[i]++;
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
      if (copValid) copYSeries[i] = copY;

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
      copY: copYSeries,
      fsRaw: fs,
      active,
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
  gripper?: GripperSeries | null,
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
    gripper,
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
      copY: f.copY?.slice(0, n),
      fsRaw: f.fsRaw?.slice(0, n),
      active: f.active?.slice(0, n),
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
  arm?: ArmMotionSeries | null,
  context?: { result?: string; episodeIndex?: number },
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

  // jaw position sample-and-hold on the gripper's own clock, and the net
  // opening travel around a timestamp (see RELEASE_TRAVEL_MIN)
  const jawPosAt = (tq: number): number => {
    if (!gripper || gripper.t.length === 0) return 0;
    if (tq <= gripper.t[0]) return gripper.pos[0];
    let lo = 0;
    let hi = gripper.t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (gripper.t[mid] <= tq) lo = mid;
      else hi = mid - 1;
    }
    return gripper.pos[lo];
  };
  // release evidence at a force exit: net jaw opening over the window,
  // vetoed when the jaw was actively closing AT the exit (squeeze-out —
  // see RELEASE_CLOSING_VETO)
  const jawReleaseAt = (tq: number): boolean => {
    const back = jawPosAt(tq) - jawPosAt(tq - RELEASE_WIN_BEFORE_S);
    if (back <= RELEASE_CLOSING_VETO) return false;
    const fwd = jawPosAt(tq + RELEASE_WIN_AFTER_S) - jawPosAt(tq);
    return back + fwd >= RELEASE_TRAVEL_MIN;
  };

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
            data: { n: fn },
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
          const releasing = jawReleaseAt(t[exitIdx]);
          let exitPlateau = 0;
          for (let k = exitIdx; k >= 0 && t[exitIdx] - t[k] <= 1.0; k--) {
            if (f.fn[k] > exitPlateau) exitPlateau = f.fn[k];
          }
          events.push({
            label: releasing ? "release" : "drop",
            startS: t[exitIdx],
            endS: t[exitIdx],
            finger: fi,
            confidence: releasing
              ? "medium"
              : f.hf[i] > th.hfExit
                ? "medium"
                : "low",
            data: {
              n: exitPlateau,
              jaw:
                jawPosAt(t[exitIdx] + RELEASE_WIN_AFTER_S) -
                jawPosAt(t[exitIdx] - RELEASE_WIN_BEFORE_S),
            },
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
          data: { n: fn },
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
        let hfPk = 0;
        for (let k = slipActive; k <= i; k++) {
          if (f.hf[k] > hfPk) hfPk = f.hf[k];
        }
        events.push({
          label: "slip",
          startS: t[slipActive],
          endS: t[i],
          finger: fi,
          confidence: "medium",
          data: { hf: hfPk },
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
            data: { div: f.slipDiv[incActive] },
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
          let tauPk = 0;
          for (let k = rotActive; k <= i; k++) {
            if (Math.abs(f.tauZ[k]) > tauPk) tauPk = Math.abs(f.tauZ[k]);
          }
          events.push({
            label: "rotation",
            startS: t[rotActive],
            endS: t[i],
            finger: fi,
            confidence: "medium",
            data: { tau: tauPk },
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
            data: { n: refFn },
            order: events.length,
          });
        }
        if (!recovered) lastPlaceEnd = t[i];
      }
    }
  });

  // ---- staggered peel-off upgrade (see PEEL_* constants): a drop whose
  // finger was holding in that very bout, does not re-contact, and sits
  // next to the partner finger's jaw-visible release is a peel, i.e. a
  // release. Cross-finger, so it must run after every finger's pass.
  {
    const terms = events.filter(
      (e) => e.label === "release" || e.label === "drop",
    );
    for (const e of terms) {
      if (e.label !== "drop") continue;
      const tEx = e.startS;
      let boutOnset = -1;
      for (const c of events) {
        if (
          c.finger === e.finger &&
          c.label === "contact_onset" &&
          c.startS < tEx &&
          c.startS > boutOnset
        ) {
          boutOnset = c.startS;
        }
      }
      // the finger must have HELD in this bout — its last grasp_stable
      // lies inside it (a 0.8 N post-place graze never qualifies: ep33)
      const heldThisBout = events.some(
        (s) =>
          s.finger === e.finger &&
          s.label === "grasp_stable" &&
          s.startS < tEx &&
          s.startS >= boutOnset,
      );
      if (!heldThisBout) continue;
      // a peel is final — an immediate re-grab means a fumble (ep24)
      const recontacts = events.some(
        (c) =>
          c.finger === e.finger &&
          c.label === "contact_onset" &&
          c.startS > tEx &&
          c.startS - tEx <= PEEL_RECONTACT_S,
      );
      if (recontacts) continue;
      let peel = false;
      for (const p of terms) {
        if (p.finger === e.finger) continue;
        const dt = p.startS - tEx;
        // early peel (ep25): partner still holding at this exit, its own
        // jaw-visible release follows within PEEL_EARLY_MAX_S
        if (dt >= 0 && dt <= PEEL_EARLY_MAX_S && jawReleaseAt(p.startS)) {
          let lastOn = -1;
          let lastEx = -1;
          for (const c of events) {
            if (c.finger !== p.finger || c.startS >= tEx) continue;
            if (c.label === "contact_onset" && c.startS > lastOn) {
              lastOn = c.startS;
            }
            if (
              (c.label === "release" || c.label === "drop") &&
              c.startS > lastEx
            ) {
              lastEx = c.startS;
            }
          }
          if (lastOn >= 0 && lastOn > lastEx) peel = true;
        }
        // late peel (ep41): partner's jaw-visible release preceded this
        // exit by <= PEEL_LATE_MAX_S while this finger was already in
        // contact (a contact STARTING after the release is post-task
        // noise, never a peel)
        if (
          dt <= 0 &&
          -dt <= PEEL_LATE_MAX_S &&
          jawReleaseAt(p.startS) &&
          boutOnset >= 0 &&
          boutOnset <= p.startS
        ) {
          peel = true;
        }
        if (peel) break;
      }
      if (peel) {
        e.label = "release";
        e.confidence = "medium";
        e.info = "peel";
      }
    }
  }

  // ---- place backfill: in real demos the object is often set down in
  // the same motion as the gripper opening, so the jaw-static place gate
  // never fires (the final force drop and the release coincide). If a
  // finger has a release but no place in the preceding 2 s, recover the
  // onset of the final force drop and label it as the place. Runs AFTER
  // the peel upgrade so it keys on the final release set — the dependency
  // is one-way: place derives from release, never the reverse.
  fingers.forEach((f, fi) => {
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
        data: { n: plateau },
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
            info: "brief",
            data: { n: peak },
            order: events.length,
          });
          events.push({
            label: "drop",
            startS: t[i - 1],
            endS: t[i - 1],
            finger: fi,
            confidence: "low",
            data: { n: peak },
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
    // rename-pass labels — never present during cleanup (assigned at
    // the very end), listed only for Record completeness
    finger_unload: 4,
    sensor_residual: 4,
    phantom: 4,
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

  // ---- post-task phantom contacts
  // A new contact on a finger AFTER that finger already placed-and-
  // released its object cannot be a grasp — nothing re-enters the grip
  // without the jaw closing again, and a real re-grab is a new approach.
  // Video-verified phantom on ep25: 0.2–0.8 N over 1–4 taxels wandering
  // for 3 s after the carry ended, producing a fake contact/stable/drop
  // chain. Downgrade every event of such a span to low confidence and
  // flag it. (Multi-cycle tasks with real re-grabs would need a
  // jaw-closing check here before this gate is applied to them.)
  // Gate-classified events are renamed to "phantom" by the rename pass
  // at the END (renaming here would corrupt bout building).
  const phantomEvents = new Set<DetectedEvent>();
  {
    const taskDoneByFinger = new Map<number, number>();
    // The finger's FINAL place must be computed over the full list before
    // pairing it with a terminal. Using the running "last place so far"
    // let an early false place + an attempt-churn terminal mark the
    // finger done at ~5 s and silently downgrade the REAL grasp/carry to
    // low (ep21, ep24, ep47, ep56 — caught by the release-decoupling
    // audit).
    const finalPlaceEndByFinger = new Map<number, number>();
    for (const e of cleaned) {
      if (e.label === "place") finalPlaceEndByFinger.set(e.finger, e.endS);
    }
    for (const e of cleaned) {
      if (
        (e.label === "release" || e.label === "drop") &&
        finalPlaceEndByFinger.has(e.finger) &&
        e.startS >= (finalPlaceEndByFinger.get(e.finger) ?? Infinity) - 0.2 &&
        !taskDoneByFinger.has(e.finger)
      ) {
        taskDoneByFinger.set(e.finger, e.startS);
      }
    }
    for (const [fi, doneS] of taskDoneByFinger) {
      let spanStart: number | null = null;
      let spanEnd = -1;
      for (const e of cleaned) {
        if (e.finger !== fi || e.startS <= doneS) continue;
        if (e.label === "contact_onset" && spanStart === null) {
          spanStart = e.startS;
        }
        if (spanStart !== null) {
          e.confidence = "low";
          phantomEvents.add(e);
          spanEnd = Math.max(spanEnd, e.endS);
        }
      }
      if (spanStart !== null) {
        flags.push(
          `post_task_contact@${spanStart.toFixed(1)}-${spanEnd.toFixed(1)}s`,
        );
      }
    }
  }

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
    // place_release starts at the opening bout that leads to the terminal
    // event ENDING THE CARRY: the first release/drop after the last place.
    // Anchoring to the last terminal overall instead lets a post-place
    // re-touch (ep25, video-verified: a finger re-contacts the placed ball
    // and loses it 2.4 s later) drag place_release seconds late and
    // stretch transport. Fallback: last terminal, then last opening bout.
    const lastPlace = [...cleaned].reverse().find((e) => e.label === "place");
    let lastTerminal = lastPlace
      ? cleaned.find(
          (e) =>
            (e.label === "release" || e.label === "drop") &&
            e.startS >= lastPlace.endS - 0.2,
        )
      : undefined;
    if (!lastTerminal) {
      lastTerminal = [...cleaned]
        .reverse()
        .find((e) => e.label === "release" || e.label === "drop");
    }
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
    // The grasp anchors to the closing motion leading to the REAL grasp
    // trial's contact — the latest contact_onset (any finger) at/before
    // the deciding stable — NOT the bout's first contact: a standing
    // phantom span welds the bout open episodes earlier (ep47: f0's
    // phantom "contact" never exits, the bout starts at 0.26 s, and the
    // bout-start reference made the selector latch onto the FAILED
    // squeeze's closing at 3.7 s, pulling the flagged attempt inside
    // the grasp segment — Zheng's catch). The latest-onset reference is
    // immune to one welded finger: the healthy finger dates the trial.
    // Per finger: the latest non-LOW contact_onset at/before the stable
    // (low = gate-downgraded phantoms — ep25's post-task chain otherwise
    // drags the anchor to 13.8 s). The trial's start is the EARLIEST of
    // those candidates, but a candidate more than 2 s older than the
    // newest is a weld-suspect and is discarded (normal two-finger
    // stagger is sub-second; ep47's phantom finger is 8 s early).
    let contactRefS: number | null = null;
    if (graspBout && lastStable) {
      const perFinger = new Map<number, number>();
      for (const e of cleaned) {
        if (
          e.label === "contact_onset" &&
          e.confidence !== "low" &&
          e.startS <= lastStable.startS + 1e-6
        ) {
          const cur = perFinger.get(e.finger);
          if (cur === undefined || e.startS > cur) {
            perFinger.set(e.finger, e.startS);
          }
        }
      }
      const cands = [...perFinger.values()];
      if (cands.length > 0) {
        const newest = Math.max(...cands);
        contactRefS = Math.min(...cands.filter((c) => c >= newest - 2.0));
      }
    }
    if (contactRefS === null && graspBout) contactRefS = graspBout.startS;
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
    // Arm-driven contact fallback: when the chosen closing motion sits far
    // ahead of the contact, the jaw was PRE-POSITIONED and the arm
    // descended onto the object — the "closing" the selector latched onto
    // is a micro settle invisible on video (sotac ep30, video-verified:
    // anchor sat on a 2-unit jaw drift at 0.5 s while grasping begins just
    // before the 6.0 s contact; a real squeeze can also START only after
    // the contact and is then ineligible). Anchor a short lead before the
    // contact instead — her hand-set boundaries lead it by 0.2–1.5 s.
    const ARM_DRIVEN_MAX_LEAD_S = 2.0;
    const ARM_DRIVEN_FALLBACK_LEAD_S = 0.3;
    if (
      contactRefS !== null &&
      closeStart >= 0 &&
      contactRefS - t[closeStart] > ARM_DRIVEN_MAX_LEAD_S
    ) {
      closeStart = -1;
    }
    let tClose =
      closeStart >= 0
        ? t[closeStart]
        : contactRefS !== null
          ? Math.max(contactRefS - ARM_DRIVEN_FALLBACK_LEAD_S, 0)
          : dur * 0.25;
    // a failed trial belongs to approach, not grasp
    if (tClose < prevBoutEndS) tClose = prevBoutEndS;
    // transport starts when the ARM starts carrying: first sustained arm
    // motion at/after the grasp's first stability. Grip-force statistics
    // cannot mark this boundary — first-stability is 0.5–1.9 s early on
    // her 12 hand-corrected episodes (settling), but waiting for the
    // second finger overshoots when the operator lifts with one grip
    // still fluctuating (sotac ep2, video-verified: ball airborne at
    // 6.9 s, second finger's flat-force test only passes at 8.5 s). A
    // light object's weight transfer is equally invisible in force, so
    // the moving arm is the only reliable lift-off signal. Falls back to
    // first-stability when no arm data is supplied.
    const stableAfterClose = cleaned.find(
      (e) => e.label === "grasp_stable" && e.startS >= tClose,
    );
    const firstStableS = stableAfterClose ? stableAfterClose.startS : null;
    let tStableRaw = firstStableS ?? tClose + 1;
    if (arm && arm.t.length > 2 && firstStableS !== null) {
      const ARM_MOVE_EPS = 12; // summed units/s; jitter ~1-2, slow drift ~5-10
      const moveSustainS = 0.15;
      const nJoints = arm.joints[0]?.length ?? 0;
      const speedAt: number[] = new Array(arm.t.length).fill(0);
      for (let g = 1; g < arm.t.length; g++) {
        const dt = arm.t[g] - arm.t[g - 1];
        if (dt <= 1e-9) continue;
        let s = 0;
        for (let k = 0; k < nJoints; k++) {
          s += Math.abs(arm.joints[g][k] - arm.joints[g - 1][k]) / dt;
        }
        speedAt[g] = s;
      }
      // Substantial jaw closing still AHEAD of the candidate postpones it
      // — the arm was repositioning while the operator worked the
      // (re)grip, not carrying (ep31, video-verified: 40-unit squeeze at
      // 9.1-9.8 s, her boundary 9.9 s). Ongoing squeeze tails and
      // mid-carry micro tightens (≤ ~5 units) do not postpone (ep2,
      // ep24). KNOWN LIMIT: carrying that overlaps a fresh hard squeeze
      // is postponed too — net joint displacement cannot separate the two
      // (ep31's repositioning is itself directional, measured ≥16 units);
      // separating them needs SIGNED lift-direction motion, which needs a
      // per-robot sign convention.
      const SQUEEZE_LOOKAHEAD_S = 1.0;
      const SQUEEZE_MIN_TRAVEL = 8; // jaw units; real squeezes are 30-50
      const jawCloseAhead = (fromS: number): number => {
        if (!gripper) return 0;
        let start: number | null = null;
        let minPos = Infinity;
        for (let g = 0; g < gripper.t.length; g++) {
          const ts = gripper.t[g];
          if (ts < fromS) continue;
          if (ts > fromS + SQUEEZE_LOOKAHEAD_S) break;
          if (start === null) start = gripper.pos[g];
          if (gripper.pos[g] < minPos) minPos = gripper.pos[g];
        }
        return start === null || minPos === Infinity ? 0 : start - minPos;
      };
      let resumeFromS = firstStableS - 0.05;
      for (;;) {
        let j = 1;
        let moveStart = -1;
        let candidateS = -1;
        for (let i = 0; i < n; i++) {
          if (t[i] < resumeFromS) continue;
          while (j < arm.t.length - 1 && arm.t[j] < t[i]) j++;
          if (speedAt[j] > ARM_MOVE_EPS) {
            if (moveStart < 0) moveStart = i;
            if (t[i] - t[moveStart] >= moveSustainS) {
              candidateS = t[moveStart];
              break;
            }
          } else {
            moveStart = -1;
          }
        }
        if (candidateS < 0) break;
        if (jawCloseAhead(candidateS) >= SQUEEZE_MIN_TRAVEL) {
          resumeFromS = candidateS + 0.2;
          continue;
        }
        tStableRaw = Math.max(candidateS, firstStableS);
        break;
      }
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
    // Weak pre-grasp bouts are phantom readings, not grabs: video-verified
    // (eps 25/42/9) that the pads were in the AIR — jaw open at 26-82
    // units — while the sensor read light force. Two mechanisms: standing
    // baseline drift (firmware zeroes once per session; handled by the
    // per-episode baseline in the series builders) and motion-coincident
    // phantoms that appear only while the arm moves (mechanism unknown;
    // fz is unsigned by sensor design, so oscillation cannot be checked).
    // Calibration from 7 video verdicts: every false bout peaks <= 2.2 N,
    // every real grab >= 2.4 N. The 2.3 N cut sits in that thin gap —
    // re-derive as verdicts grow.
    const WEAK_ATTEMPT_MAX_N = 2.3;
    // Pads touching EACH OTHER, no object: the jaw bottoms out at its
    // mechanical minimum, which an object between the pads never allows
    // (Zheng's ep0 verdict + corpus survey: the air-close dwells at jaw
    // 0.5 — the ONLY sub-2.0 dwell in all 63 episodes; the nearest real
    // hold crushes the foam ball to 2.8, ep37 — thin margin, re-derive
    // for harder objects). Such a span is a distinct outcome, not an
    // object attempt, and is excluded from attempt counting.
    const AIR_CLOSE_POS = 2.0;
    const jawMinIn = (a: number, b: number): number => {
      if (!gripper) return Infinity;
      let mn = Infinity;
      for (let j = 0; j < gripper.t.length; j++) {
        if (gripper.t[j] < a) continue;
        if (gripper.t[j] > b) break;
        if (gripper.pos[j] < mn) mn = gripper.pos[j];
      }
      return mn;
    };
    const attemptFlag = (
      startS: number,
      endS: number,
      peakN: number,
    ): string => {
      const span = `${startS.toFixed(1)}-${endS.toFixed(1)}s`;
      if (jawMinIn(startS - 0.3, endS + 0.3) < AIR_CLOSE_POS) {
        return `air_grasp@${span}`;
      }
      return peakN < WEAK_ATTEMPT_MAX_N
        ? `weak_contact@${span}`
        : `failed_attempt@${span}`;
    };
    const boutPeakN = (b: { startS: number; endS: number }): number => {
      let pk = 0;
      for (const f of fingers) {
        for (let i = 0; i < n; i++) {
          if (t[i] < b.startS - 0.05) continue;
          if (t[i] > b.endS + 0.05) break;
          if (f.fnRaw[i] > pk) pk = f.fnRaw[i];
        }
      }
      return pk;
    };
    for (const b of bouts) {
      if (b === graspBout) break;
      flags.push(attemptFlag(b.startS, b.endS, boutPeakN(b)));
    }

    // finger-level attempts hidden INSIDE the grasp bout. Zheng's ruling
    // (sweep, video): an attempt requires the HAND to lose the object in
    // a CONTINUOUS chunk — a single finger blinking out is normal grasp
    // life (contact migration while the ball slides into the clamp, one
    // pad unloading while the object is pinched or rests on the bowl)
    // and is NEVER an attempt by itself. Both a partner-in-contact test
    // and a pre-stability+gap test were tried and video-falsified
    // (ep19/22/33/35/40). The shipped rule is fully measured: a span
    // ending in a drop (inside the grasp bout, before the episode's
    // last release) is an attempt iff
    //   1. the hand goes QUIET — total force < HAND_LOSS_N for
    //      HAND_LOSS_MIN_S after the drop (1.0 N sits above ep47's
    //      0.8 N standing phantom and below ep19's 1.4 N immediate
    //      clamp; 0.35 s sits inside ep32's 0.41 s retry gap and past
    //      ep35's phantom resurgence at +0.33 s — thin margins on both
    //      sides, re-derive as verdicts grow), AND
    //   2. the loss is ACTED ON — the jaw re-opens to retry (measured:
    //      +22.8/+24.7 units on real attempts ep47/ep32, 0.0 on every
    //      false case), OR the jaw SQUEEZES THROUGH: within 2.5 s it
    //      closes >= 8 units BELOW the position where this finger was
    //      stably holding, with no force — a hand cannot sit that far
    //      inside its own hold width empty-handed unless the object
    //      left (ep45: holds at ~24, ball escapes, jaw runs to 5 —
    //      video-verified terminal loss the retry test alone missed;
    //      ep40's residual drop is safe: its jaw sits at 62, far ABOVE
    //      its 26-unit hold).
    const HAND_LOSS_N = 1.0;
    const HAND_LOSS_MIN_S = 0.35;
    const JAW_RETRY_RISE = 5.0;
    const JAW_RETRY_WIN_S = 2.5;
    const SQUEEZE_THROUGH_BELOW = 8.0;
    {
      const lastRelease = [...cleaned]
        .reverse()
        .find((e) => e.label === "release");
      const handQuietAfter = (tq: number): boolean => {
        let sawEnd = false;
        for (let i = 0; i < n; i++) {
          if (t[i] < tq) continue;
          if (t[i] > tq + HAND_LOSS_MIN_S) {
            sawEnd = true;
            break;
          }
          let sum = 0;
          for (const f of fingers) sum += f.fn[i];
          if (sum >= HAND_LOSS_N) return false;
        }
        return sawEnd; // window truncated by episode end doesn't count
      };
      const jawReopensAfter = (tq: number): boolean => {
        if (!gripper) return false;
        const base = jawPosAt(tq);
        for (let j = 0; j < gripper.t.length; j++) {
          if (gripper.t[j] <= tq) continue;
          if (gripper.t[j] > tq + JAW_RETRY_WIN_S) break;
          if (gripper.pos[j] - base >= JAW_RETRY_RISE) return true;
        }
        return false;
      };
      const byFinger = new Map<number, DetectedEvent[]>();
      for (const e of cleaned) {
        if (!byFinger.has(e.finger)) byFinger.set(e.finger, []);
        byFinger.get(e.finger)!.push(e);
      }
      for (const [fi, list] of byFinger) {
        if (fi < 0 || fi >= fingers.length) continue;
        let open = -1;
        for (const e of list) {
          if (e.label === "contact_onset") {
            if (open < 0) open = e.startS;
            continue;
          }
          if (e.label !== "release" && e.label !== "drop") continue;
          const spanStart = open;
          open = -1;
          if (spanStart < 0 || e.label !== "drop") continue;
          if (
            spanStart < graspBout.startS - 1e-6 ||
            e.startS > graspBout.endS + 1e-6
          ) {
            continue;
          }
          // attempts happen before the task completes
          if (lastRelease && e.startS >= lastRelease.startS - 1e-6) {
            continue;
          }
          if (!handQuietAfter(e.startS)) continue;
          let squeezeThrough = false;
          if (gripper) {
            const stableInSpan = [...cleaned]
              .reverse()
              .find(
                (s) =>
                  s.finger === fi &&
                  s.label === "grasp_stable" &&
                  s.startS >= spanStart - 1e-6 &&
                  s.startS <= e.startS + 1e-6,
              );
            // a squeeze-through implies the object was genuinely
            // clamped — require a real-hold peak (>= 5 N sits between
            // ep35's 3.8 N motion-phantom "stable" and ep45's 24 N
            // verified hold; re-derive as verdicts grow)
            let spanPk = 0;
            for (let i = 0; i < n; i++) {
              if (t[i] < spanStart - 0.05) continue;
              if (t[i] > e.startS + 0.05) break;
              if (fingers[fi].fnRaw[i] > spanPk) spanPk = fingers[fi].fnRaw[i];
            }
            if (stableInSpan && spanPk >= 5.0) {
              const holdPos = jawPosAt(stableInSpan.startS);
              for (let j = 0; j < gripper.t.length; j++) {
                if (gripper.t[j] <= e.startS) continue;
                if (gripper.t[j] > e.startS + JAW_RETRY_WIN_S) break;
                if (gripper.pos[j] <= holdPos - SQUEEZE_THROUGH_BELOW) {
                  squeezeThrough = true;
                  break;
                }
              }
            }
          }
          if (!jawReopensAfter(e.startS) && !squeezeThrough) continue;
          let pk = 0;
          const f = fingers[fi];
          for (let i = 0; i < n; i++) {
            if (t[i] < spanStart - 0.05) continue;
            if (t[i] > e.startS + 0.05) break;
            if (f.fnRaw[i] > pk) pk = f.fnRaw[i];
          }
          const span = `${spanStart.toFixed(1)}-${e.startS.toFixed(1)}s`;
          if (flags.some((fl) => fl.endsWith(`@${span}`))) continue;
          flags.push(attemptFlag(spanStart, e.startS, pk));
        }
      }
    }

    // AIR-MISS attempts: the jaw closes substantially and reopens with
    // NO tactile contact in between — a grab that missed entirely
    // (ep45's first attempt, video-verified: 27 -> 14 -> 45 at
    // 3.5-4.5 s, zero force on both pads; distinct from the pads-meet
    // air_grasp which bottoms out below 2). Gripper-only detection,
    // before the grasp bout; suppressed while ANY finger span overlaps
    // the cycle (a standing phantom span otherwise reads as "contact").
    const AIR_MISS_TRAVEL = 8.0;
    if (gripper && gripper.t.length > 2) {
      const gt = gripper.t;
      const gp = gripper.pos;
      let peak = gp[0];
      let peakT = gt[0];
      let j = 0;
      while (j < gt.length - 1) {
        j++;
        if (gp[j] >= peak) {
          peak = gp[j];
          peakT = gt[j];
          continue;
        }
        if (peak - gp[j] < AIR_MISS_TRAVEL) continue;
        // a substantial close began at peakT — find the trough and wait
        // for a substantial reopen
        let trough = gp[j];
        let reopenT = -1;
        while (j < gt.length - 1) {
          j++;
          if (gp[j] < trough) trough = gp[j];
          if (gp[j] - trough >= AIR_MISS_TRAVEL) {
            reopenT = gt[j];
            break;
          }
        }
        if (reopenT < 0) break;
        const cycleEndsPreGrasp = reopenT <= graspBout.startS + 1e-6;
        const touched = fingerSpans.some(
          (s) => s.startS <= reopenT && s.endS >= peakT,
        );
        // cycles in the first 2 s are the previous episode's reset
        // motion still settling (ep47 starts mid-open; ep42/ep60 wiggle
        // in the first second), not grab attempts
        const pastReset = peakT >= 2.0;
        if (cycleEndsPreGrasp && !touched && pastReset) {
          // a no-touch close-reopen cycle is a FAILED ATTEMPT, not its
          // own category (Zheng: ep45's air-miss and ep16's edge-whiff
          // are both tries — the signal cannot tell "closed past the
          // ball's edge" from "closed on pure air"). A cycle contiguous
          // (<=0.5 s) with a touch-attempt span is the SAME attempt
          // whiffing on: merge into one span instead of double-flagging
          // (ep16: graze 2.6-2.8 + whiff 3.0-4.1 = one attempt).
          const mIdx = flags.findIndex((fl) => {
            const m = /^(failed_attempt|weak_contact)@([\d.]+)-([\d.]+)s$/.exec(
              fl,
            );
            return m !== null && Math.abs(peakT - Number(m[3])) <= 0.5;
          });
          if (mIdx >= 0) {
            const m = /@([\d.]+)-/.exec(flags[mIdx]);
            if (m) {
              flags[mIdx] = `failed_attempt@${m[1]}-${reopenT.toFixed(1)}s`;
            }
          } else {
            const span = `${peakT.toFixed(1)}-${reopenT.toFixed(1)}s`;
            if (!flags.some((fl) => fl.endsWith(`@${span}`))) {
              flags.push(`failed_attempt@${span}`);
            }
          }
        }
        peak = gp[j];
        peakT = gt[j];
      }
    }
  }

  // Result-aware failure override, signal-side: an episode with NO
  // release anywhere, whose final loss is itself flagged as a failed
  // attempt, never completed a task — the success template
  // (grasp/transport/place_release) is false there (Zheng, ep45: two
  // failed attempts and nothing else). Approach spans the episode; the
  // attempts stay visible as flags. A sensor-blind success that is also
  // release-less (ep40: the carry is invisible at 0.1 N) is protected:
  // its residual drop is not flagged as an attempt.
  const anyRelease = cleaned.some((e) => e.label === "release");
  if (!anyRelease && subtasks.length > 1) {
    const lastTerminal = [...cleaned].reverse().find((e) => e.label === "drop");
    const lossFlagged =
      lastTerminal !== undefined &&
      flags.some((fl) => {
        const m = /^failed_attempt@([\d.]+)-([\d.]+)s$/.exec(fl);
        return (
          m !== null &&
          lastTerminal.startS >= Number(m[1]) - 0.05 &&
          lastTerminal.startS <= Number(m[2]) + 0.05
        );
      });
    if (lossFlagged) {
      subtasks.length = 0;
      subtasks.push({ label: "approach", startS: 0, endS: dur });
    }
  }

  // ---- place hygiene (Zheng's precision item; census of all 130
  // corpus places). A real placement sits at the place_release anchor,
  // never regains grip, and its finger next releases or unloads. Five
  // artifact classes are DELETED — places are detector interpretations,
  // not raw sensor truth, so removing false ones is honest:
  //  D1 same-finger overlapping duplicates — main path and backfill
  //     both firing on one placement (~18 corpus events)
  //  D2 settling dips: grip recovers >=25% of its pre-place level and
  //     the carry continues >1.5 s more (ep36 @5.41; ep56 @6.7 with
  //     706% recovery; margins: real staged placements max gap 1.43 s
  //     (ep50), false min 1.7 s (ep38) — thin, re-derive with verdicts)
  //  D3 place-then-drop: the finger's next terminal is a drop — a dip
  //     before LOSING the object is not a placement (ep21 @4.15,
  //     ep24 @4.93, ep40, ep45's loss-overlap)
  //  D4 inside an air_grasp span: nothing was held (ep0 @2.70)
  //  D5 starting >1.5 s after the place_release anchor: post-task
  //     artifact (ep28 @15.0, ep40 @8.7)
  //  D6 ending before the grasp bout: the object was never carried, so
  //     nothing could be placed (ep56 @6.62 — trial-1's jaw-open decay
  //     backfilled as a "place"; Zheng video-verified)
  //  D7 no jaw opening around the place AND the hold continues >=1 s:
  //     a real placement either unloads the finger promptly (weight
  //     transferred: ep25/ep33) or coincides with the jaw starting to
  //     open (release beginning: measured +4.2 on ep50's real staged
  //     place, +15.3 on ep24); a dip with the jaw closed and the carry
  //     continuing is grip fluctuation (ep20 @4.40: jaw net -0.6,
  //     Zheng video: still holding the ball)
  const deletedPlaces = new Set<DetectedEvent>();
  {
    const placeRelSub = subtasks.find((s) => s.label === "place_release");
    const airSpans2: Array<[number, number]> = [];
    for (const fl of flags) {
      const m = /^air_grasp@([\d.]+)-([\d.]+)s$/.exec(fl);
      if (m) airSpans2.push([Number(m[1]) - 0.1, Number(m[2]) + 0.1]);
    }
    const idxAt = (tq: number): number => {
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (t[mid] < tq) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const byF = new Map<number, DetectedEvent[]>();
    for (const p of cleaned) {
      if (p.label !== "place") continue;
      if (!byF.has(p.finger)) byF.set(p.finger, []);
      byF.get(p.finger)!.push(p);
    }
    for (const [fi, list] of byF) {
      list.sort((a, b) => a.startS - b.startS || a.endS - b.endS);
      let cur: DetectedEvent | null = null;
      for (const p of list) {
        if (cur && p.startS <= cur.endS + 1e-6) deletedPlaces.add(p);
        else cur = p;
      }
      const f = fingers[fi];
      if (!f) continue;
      for (const p of list) {
        if (deletedPlaces.has(p)) continue;
        if (airSpans2.some(([s, e2]) => p.startS >= s && p.startS <= e2)) {
          deletedPlaces.add(p);
          continue;
        }
        if (placeRelSub && p.startS > placeRelSub.startS + 1.5) {
          deletedPlaces.add(p);
          continue;
        }
        if (graspBout && p.endS < graspBout.startS - 1e-6) {
          deletedPlaces.add(p);
          continue;
        }
        const nextTerm = cleaned.find(
          (x) =>
            x.finger === fi &&
            (x.label === "release" || x.label === "drop") &&
            x.startS >= p.endS - 0.25,
        );
        if (nextTerm && nextTerm.label === "drop") {
          deletedPlaces.add(p);
          continue;
        }
        if (
          gripper &&
          nextTerm &&
          nextTerm.startS - p.endS >= 1.0 &&
          jawPosAt(p.endS + 0.3) - jawPosAt(p.startS - 0.3) < 1.0
        ) {
          deletedPlaces.add(p);
          continue;
        }
        let plateau = 0;
        for (
          let i = idxAt(p.startS - 1.0);
          i <= idxAt(p.startS) && i < n;
          i++
        ) {
          if (f.fn[i] > plateau) plateau = f.fn[i];
        }
        const termS = nextTerm ? nextTerm.startS : t[n - 1];
        let maxRec = 0;
        for (let i = idxAt(p.endS + 0.2); i <= idxAt(termS) && i < n; i++) {
          if (f.fn[i] > maxRec) maxRec = f.fn[i];
        }
        if (plateau > 0 && maxRec >= 0.25 * plateau && termS - p.endS > 1.5) {
          deletedPlaces.add(p);
        }
      }
    }
  }

  // ---- real names for the markers (Zheng's marker-honesty ruling).
  // Runs LAST: every anchor, bout, flag and gate was computed on the
  // original labels, so renames are output semantics only.
  // 1. Gate-classified post-task chains -> "phantom" (ep25's tail).
  // 2. The HAND's release is the one at the jaw opening — the first
  //    release at/after the place_release anchor. A release well before
  //    it, with the partner still holding, is a FINGER_UNLOAD: real
  //    signal, but the object was not released (ep33 @8.11 — "the
  //    gripper was still holding the ball"; ep25 @11.68; ep50 @12.18,
  //    all video-verified). A terminal well after it whose contact
  //    predates it is a SENSOR_RESIDUAL — the non-re-zeroed sensor
  //    discharging (ep36 @9.61, ep41 @7.34, ep22 @10.76,
  //    video-verified).
  for (const e of cleaned) {
    if (phantomEvents.has(e)) {
      e.info = `was ${e.label}`;
      e.label = "phantom";
    }
  }
  const placeRel = subtasks.find((s) => s.label === "place_release");
  const handRelease = placeRel
    ? cleaned.find(
        (e) => e.label === "release" && e.startS >= placeRel.startS - 0.3,
      )
    : undefined;
  if (handRelease) {
    // pads-meet closes are their own context: "hand still holding" is
    // false there (the pads held each other, ep0) — no renames inside
    const airSpans: Array<[number, number]> = [];
    for (const fl of flags) {
      const m = /^air_grasp@([\d.]+)-([\d.]+)s$/.exec(fl);
      if (m) airSpans.push([Number(m[1]) - 0.1, Number(m[2]) + 0.1]);
    }
    const inAir = (tq: number): boolean =>
      airSpans.some(([s, e]) => tq >= s && tq <= e);
    // the partner holds at tq if its latest engagement-opening precedes
    // tq with no terminal in between
    const partnerHolding = (fi: number, tq: number): boolean => {
      let lastOn = -1;
      let lastEx = -1;
      for (const c of cleaned) {
        if (c.finger === fi || c.startS >= tq) continue;
        if (c.label === "contact_onset") lastOn = Math.max(lastOn, c.startS);
        if (c.label === "release" || c.label === "drop") {
          lastEx = Math.max(lastEx, c.startS);
        }
      }
      return lastOn >= 0 && lastOn > lastEx;
    };
    for (const e of cleaned) {
      if (inAir(e.startS)) continue;
      if (e.label === "release" && e.startS < handRelease.startS - 0.3) {
        if (partnerHolding(e.finger, e.startS)) {
          e.info = "hand still holding";
          e.label = "finger_unload";
        }
      } else if (
        (e.label === "release" || e.label === "drop") &&
        e !== handRelease &&
        e.startS > handRelease.startS + 0.5
      ) {
        let ownOnset = -1;
        for (const c of cleaned) {
          if (
            c.finger === e.finger &&
            c.label === "contact_onset" &&
            c.startS < e.startS &&
            c.startS > ownOnset
          ) {
            ownOnset = c.startS;
          }
        }
        if (ownOnset >= 0 && ownOnset <= handRelease.startS) {
          e.info = "sensor not re-zeroed";
          e.label = "sensor_residual";
        }
      }
    }
    // a PLACE built from that same discharge (the slow decay reads as
    // weight transfer): place at/after the hand's release on a finger
    // that has a sensor_residual — ep36 @8.46, ep41 @6.66
    const residualFingers = new Set(
      cleaned.filter((e) => e.label === "sensor_residual").map((e) => e.finger),
    );
    for (const e of cleaned) {
      if (
        e.label === "place" &&
        residualFingers.has(e.finger) &&
        e.startS >= handRelease.startS - 0.05
      ) {
        e.info = "sensor not re-zeroed";
        e.label = "sensor_residual";
      }
    }
  }

  // Sustained loosening slide (see SLIDE_* provenance). Runs on final
  // renamed events — the terminal veto must see honest place/release
  // labels. Flags-only plus data enrichment of coincident slips: no
  // event class is added (Table VIII is partner-owned).
  {
    const graspAnchorS = subtasks.find((s2) => s2.label === "grasp")?.startS;
    const placeAnchorS =
      subtasks.find((s2) => s2.label === "place_release")?.startS ?? dur;
    if (graspAnchorS !== undefined && gripper && gripper.t.length > 2) {
      for (let f = 0; f < fingers.length; f++) {
        const cop = fingers[f].copY;
        if (!cop) continue;
        const fn = fingers[f].fn;
        // loaded-median CoP in a ±SLIDE_MED_HALF_S window (NaN-skipping;
        // CoP is meaningless below SLIDE_LOAD_MIN_N)
        const copMed = (tc: number): number => {
          const vals: number[] = [];
          for (let i = 0; i < t.length; i++) {
            if (t[i] < tc - SLIDE_MED_HALF_S) continue;
            if (t[i] > tc + SLIDE_MED_HALF_S) break;
            if (fn[i] >= SLIDE_LOAD_MIN_N && Number.isFinite(cop[i])) {
              vals.push(cop[i]);
            }
          }
          if (vals.length < 3) return NaN;
          vals.sort((a, b) => a - b);
          return vals[vals.length >> 1];
        };
        // On a known non-success episode the veto is DISABLED: failure
        // episodes get success-template place/release markers that are
        // really the failure exit itself (Zheng's ep48 ruling; the
        // 45/48-extra-place result-aware segmentation gap), and vetoing
        // on those hides the slide that PRECEDES the loss — ep48's cup
        // rotates out at 11.3 s, "place" 11.875 is the cup escaping.
        const terminalVeto = !context?.result || context.result === "success";
        const terminalNear = (tc: number): boolean =>
          terminalVeto &&
          cleaned.some(
            (e) =>
              e.finger === f &&
              (e.label === "place" ||
                e.label === "release" ||
                e.label === "finger_unload") &&
              e.startS >= tc - 0.25 &&
              e.startS <= tc + SLIDE_TERMINAL_VETO_S,
          );
        let best: { tc: number; dcop: number; djaw: number } | null = null;
        let lastHitS = -Infinity;
        const emitBest = () => {
          if (!best) return;
          flags.push(`sustained_slide@${best.tc.toFixed(1)}s`);
          for (const e of cleaned) {
            if (
              e.label === "slip" &&
              e.finger === f &&
              e.startS >= best.tc - 0.25 &&
              e.startS <= best.tc + SLIDE_WIN_S + 0.25
            ) {
              e.data = { ...e.data, slide: best.dcop, jaw: best.djaw };
            }
          }
          best = null;
        };
        for (
          let tc = graspAnchorS;
          tc + SLIDE_WIN_S <= placeAnchorS;
          tc += 0.1
        ) {
          const c0 = copMed(tc);
          const c1 = copMed(tc + SLIDE_WIN_S);
          if (!Number.isFinite(c0) || !Number.isFinite(c1)) continue;
          const dcop = c1 - c0;
          if (Math.abs(dcop) < SLIDE_MIN_MM) continue;
          const djaw = jawPosAt(tc + SLIDE_WIN_S) - jawPosAt(tc);
          if (djaw < SLIDE_JAW_OPEN_MIN) continue;
          if (
            jawPosAt(tc) - jawPosAt(tc - SLIDE_SQUEEZE_LOOKBACK_S) <=
            SLIDE_SQUEEZE_VETO_U
          ) {
            continue;
          }
          if (terminalNear(tc)) continue;
          if (tc - lastHitS > SLIDE_MERGE_GAP_S) emitBest();
          if (!best || Math.abs(dcop) > Math.abs(best.dcop)) {
            best = { tc, dcop, djaw };
          }
          lastHitS = tc;
        }
        emitBest();
      }
    }
  }

  // Signal screen (second artifact layer, context-free — see
  // signalScreen.ts provenance): every terminal event's raw window is
  // voted against the reference corpus; ≥ SCREEN_VOTE_MIN background
  // neighbors marks it artifact-like. Real terminals renamed by the
  // context rules (sensor_residual/phantom) just get the vote recorded
  // as corroborating data; still-real-labeled place/release/drop
  // additionally raise a residual_suspect flag for review — the screen
  // never renames or deletes (one adjudicated residual mimics a real
  // place and passes any signal screen; renaming stays context-rule
  // territory). Raw path only: the featurizer's per-sample hf channel
  // distorts at table rate.
  if (series.rateHz > 60) {
    for (const e of cleaned) {
      if (deletedPlaces.has(e)) continue;
      if (
        e.label !== "place" &&
        e.label !== "release" &&
        e.label !== "drop" &&
        e.label !== "finger_unload" &&
        e.label !== "sensor_residual" &&
        e.label !== "phantom"
      ) {
        continue;
      }
      const votes = screenBackgroundVotes(
        series,
        e.finger,
        e.startS,
        context?.episodeIndex,
      );
      if (votes === null || votes < SCREEN_VOTE_MIN) continue;
      e.data = { ...e.data, scr: votes };
      if (e.label === "place" || e.label === "release" || e.label === "drop") {
        flags.push(`residual_suspect@${e.startS.toFixed(1)}s`);
      }
    }
  }

  // Recorded outcome (when metadata supplies it) vs our story: a full
  // success template with a non-success outcome is tactilely
  // indistinguishable from success (ep39/ep48: the object was released
  // at the WRONG PLACE — Zheng's ruling: vision-model or human-labeler
  // territory). Flag the tension for review instead of guessing.
  if (
    context?.result &&
    context.result !== "success" &&
    subtasks.some((s2) => s2.label === "place_release")
  ) {
    flags.push(`result_${context.result}`);
  }

  // flags in chronological order — they are appended in pipeline-pass
  // order, which put ep45's air-miss after its later squeeze-through
  const flagTime = (fl: string): number => {
    const m = /@([\d.]+)/.exec(fl);
    return m ? Number(m[1]) : Infinity;
  };
  flags.sort((a, b) => flagTime(a) - flagTime(b));

  return {
    subtasks,
    events: cleaned.filter((e) => !deletedPlaces.has(e)),
    flags,
  };
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
    // the measured quantities behind the marker, as a compact suffix —
    // restores the data info the upstream commit dropped, as numbers
    const parts: string[] = [];
    const d = e.data;
    if (d) {
      if (d.n !== undefined) parts.push(`${d.n.toFixed(1)}N`);
      if (d.slide !== undefined) {
        parts.push(`slide${d.slide >= 0 ? "+" : ""}${d.slide.toFixed(1)}mm`);
      }
      if (d.jaw !== undefined) {
        parts.push(`jaw${d.jaw >= 0 ? "+" : ""}${d.jaw.toFixed(1)}u`);
      }
      if (d.hf !== undefined) parts.push(`hf${d.hf.toFixed(0)}`);
      if (d.div !== undefined) parts.push(`div${d.div.toFixed(2)}`);
      if (d.tau !== undefined) parts.push(`tau${d.tau.toFixed(0)}`);
      if (d.scr !== undefined) parts.push(`scr${d.scr.toFixed(0)}/7`);
    }
    if (e.info) parts.push(`(${e.info})`);
    const suffix = parts.length ? ` ${parts.join(" ")}` : "";
    atoms.push({
      role: "user",
      content: `[auto:${e.confidence}] ${e.label}${finger}${span}${suffix}`,
      style: "interjection",
      timestamp: e.startS,
      camera: null,
      tool_calls: null,
    });
  }
  return atoms.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Atoms to RECORD into the annotation set (Zheng's marker policy,
 * 2026-08-29): the app's panels display every sensor-true marker, but
 * saved annotations keep only the real ones — the events the post-task
 * phantom gate classified (LOW confidence inside a post_task_contact
 * span) are excluded so they cannot contaminate training or evaluation.
 * The finger guard matters: a phantom span can contain the OTHER
 * finger's genuine terminal (ep25: f0's real release at 14.18 sits
 * inside f1's 14.1-16.6 phantom span) — those are medium/high and
 * survive. Offline analysis (the runner, --compare) keeps using
 * resultToAtoms: analysis wants the full record.
 */
export function resultToRecordedAtoms(result: AutoLabelResult): LanguageAtom[] {
  // post-task spans can contain the OTHER finger's genuine terminal
  // (ep25: f0's real release at 14.18 inside f1's phantom span), so only
  // the gate-downgraded LOW events are dropped there. weak_contact spans
  // are phantom by calibration (every video-verified false bout peaks
  // <= 2.2 N) and their events are NOT downgraded (ep25's graze exits as
  // a medium "release" at 1.83 s), so everything inside them is dropped.
  const lowSpans: Array<[number, number]> = [];
  const allSpans: Array<[number, number]> = [];
  for (const fl of result.flags) {
    const m = /^(post_task_contact|weak_contact)@([\d.]+)-([\d.]+)s$/.exec(fl);
    if (!m) continue;
    const span: [number, number] = [Number(m[2]) - 0.05, Number(m[3]) + 0.05];
    (m[1] === "post_task_contact" ? lowSpans : allSpans).push(span);
  }
  const atoms = resultToAtoms(result);
  const inside = (a: LanguageAtom, spans: Array<[number, number]>) =>
    spans.some(([s, e]) => a.timestamp >= s && a.timestamp <= e);
  return atoms.filter((a) => {
    if (a.style !== "interjection") return true;
    if (!a.content?.startsWith("[auto:")) return true;
    // real-name pass: phantom and sensor_residual are not real contact
    // (finger_unload IS real signal and stays)
    if (/\] (phantom|sensor_residual)\b/.test(a.content)) return false;
    if (inside(a, allSpans)) return false;
    return !(a.content.startsWith("[auto:low]") && inside(a, lowSpans));
  });
}
