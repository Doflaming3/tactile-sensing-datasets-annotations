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
// the builders live in tactileSeries.ts (instrument layer, PR A) and are
// wrapped below with the residual gate (residualGate.ts) inserted.

import type { RigProfile } from "./rigProfile";
import type { LanguageAtom } from "@/types/language.types";

import { applyResidualGate, SINGLE_TAXEL_QUANTA } from "./residualGate";
import { screenBackgroundVotes, SCREEN_VOTE_MIN } from "./signalScreen";
import {
  applyAdaptiveBaseline as applyBaselineCore,
  buildSeriesFromCorrectedFrames,
  derivative,
  parseRawCsvs,
  relStd,
  type ArmMotionSeries,
  type GripperSeries,
  type RawCsvOptions,
  type TactileSeries,
} from "./tactileSeries";

// The series types and the instrument-level utilities live in
// tactileSeries.ts (PR A of Jingyi's split); they are re-exported here so
// every existing import keeps working.
export type {
  ArmMotionSeries,
  FingerSeries,
  GripperSeries,
  TactileSeries,
} from "./tactileSeries";
export {
  buildTableToRawClockMap,
  clipSeries,
  remapGripperClock,
} from "./tactileSeries";

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

/** Time-span findings (Jingyi's PR #1 review, blocker 3: structured, and
 * each carrying the finger it belongs to). `flags` still carries their
 * string form (`kind@A-Bs`) for display and logs; consumers that need the
 * span itself — the review cards, the timeline lane, the recording filter
 * — read `spans` and never parse strings. */
export type SpanKind =
  | "failed_attempt"
  | "weak_contact"
  | "air_grasp"
  | "post_task_contact"
  | "short_transport";

export interface DetectedSpan {
  kind: SpanKind;
  startS: number;
  endS: number;
  /** finger the span belongs to; null = hand-level (a bout both fingers
   * took part in, or a jaw-only finding such as an air miss) */
  finger: number | null;
  /** peak raw normal force inside the span (N), where measured */
  peakN?: number;
}

/** The flag string a span renders as (0.1 s resolution, as always). */
export function spanFlag(s: DetectedSpan): string {
  return `${s.kind}@${s.startS.toFixed(1)}-${s.endS.toFixed(1)}s`;
}

export interface AutoLabelResult {
  subtasks: DetectedSubtask[];
  events: DetectedEvent[];
  flags: string[]; // e.g. "no_contact", "unlabeled_transition@7.2s"
  spans: DetectedSpan[];
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
// SINGLE_TAXEL_QUANTA (rule 2's quantum vocabulary) and the RESIDUAL_GATE_*
// constants (rule 1) live in residualGate.ts.

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
/** Weak-attempt line (Tier 2): a pre-grasp bout peaking below this is a
 * phantom/graze (`weak_contact`), at or above it a failed grab. Calibrated
 * on 7 video verdicts — every false bout peaks <= 2.2 N, every real grab
 * >= 2.4 N (eps 25/42/9 pads-in-air); ep35's 3.8 N motion phantom later
 * broke the margin from above. Re-derive as verdicts grow. */
// WEAK_ATTEMPT_MAX_N -> RigCalibration.weakAttemptMaxN (rigProfile.ts)
/** Brief touches are REPORTED from this far below the weak line
 * (reconciles the former independent 2.0 N bar with the 2.3 N line —
 * Jingyi's blocker 3): the band [line - margin, line) is "visible but not
 * counted", where ep9's and ep23's 2.2 N grazes live, video-verified as
 * weak contacts; everything reported at or above the line is an attempt
 * candidate. Raising the bar to the line would erase those two. */
// BRIEF_REPORT_MARGIN_N -> RigCalibration.briefReportMarginN (rigProfile.ts)
const BRIEF_CONTACT_MIN_S = 0.03;
// on the 1 mN grid: the raw difference is 1.9999999999999998 in floating
// point, and a graze of exactly ten 0.2 N quanta sums to the same value, so
// the derived bar would silently admit what the literal 2.0 rejected
// (ep27 @4.5 s). Values sitting ON the bar are a float question the quantum
// grid should settle deliberately, not by accident.
// BRIEF_CONTACT_STRONG_N -> derived per profile in detectEvents (weak line - margin, on the 1 mN grid)
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
// RELEASE_TRAVEL_MIN -> RigCalibration.releaseTravelMinU (rigProfile.ts)
const RELEASE_WIN_BEFORE_S = 0.5;
const RELEASE_WIN_AFTER_S = 1.0;
// RELEASE_CLOSING_VETO -> RigCalibration.releaseClosingVetoU (rigProfile.ts)

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
 *    ahead — THIN margin, re-derive on new rigs). Since 2026-09-04 the
 *    veto also requires the hand's load to be leaving (see
 *    SLIDE_VETO_RETENTION): ep48's escape has a template place ahead
 *    but its load rises, so it stays.
 * Survivors: ep23 @10.2 (ball slides 2.5 mm as jaw opens +5.1 — Zheng's
 * verified loosening slide) and ep48 @11.3 (cup rotating out of the
 * jaws 0.7 s before its tauZ spike — verified escape precursor). */
const SLIDE_WIN_S = 1.0;
// SLIDE_MIN_MM -> RigCalibration.slideMinMm (rigProfile.ts)
// SLIDE_JAW_OPEN_MIN -> RigCalibration.slideJawOpenMinU (rigProfile.ts)
const SLIDE_SQUEEZE_LOOKBACK_S = 1.5;
// SLIDE_SQUEEZE_VETO_U -> RigCalibration.slideSqueezeVetoU (rigProfile.ts)
const SLIDE_TERMINAL_VETO_S = 1.0;
/** Load-retention condition on the terminal veto (Zheng's ruling,
 * 2026-09-04, replacing the outcome switch). The veto exists because
 * unloading at a placement is not an in-grip slide; but a placement-type
 * exit ahead is not enough on its own — ep48's escape (the cup rotating
 * out) is followed by template "place"/"release" markers too. The general
 * fact is load transfer: a placement takes the hand's load AWAY while the
 * object moves; an in-grip slide moves the object while the hand KEEPS its
 * load. Retention = the hand's total normal force over the last
 * SLIDE_RETENTION_EDGE_S of the slide window / over its first, window
 * [tc - SLIDE_RETENTION_PRE_S, tc + SLIDE_RETENTION_POST_S]. Corpus
 * (scripts/load_transfer_stats.py, analysis/exit-signature/report.md §7):
 * 118 in-grip micro-slips retain median 1.03 (p5 0.53, min 0.33); 106
 * placements retain median 0.00 (p95 0.18, max 0.60, a failure episode's
 * dubious place); AUC 0.999. The four sustained slides: ep23 0.88 (keep),
 * ep48 2.88 (the load RISES while the cup moves — keep), ep50 0.12 and
 * ep53 0.38 (veto). The condition can only rescue slides, never add a
 * veto; exposure = the 0.9% of placements above the line. */
const SLIDE_VETO_RETENTION = 0.5;
const SLIDE_RETENTION_PRE_S = 0.5;
const SLIDE_RETENTION_POST_S = 1.0;
const SLIDE_RETENTION_EDGE_S = 0.2;
// SLIDE_LOAD_MIN_N -> RigCalibration.slideLoadMinN (rigProfile.ts)
const SLIDE_MED_HALF_S = 0.15;
const SLIDE_MERGE_GAP_S = 1.0;

/** Hesitation: the episode moved slower than the task required at multiple
 * stages, with no retry or failure to blame (Zheng's ep50 ruling — see the
 * pass in detectEvents). Corpus p90 stage durations, seconds, in
 * approach / grasp / transport / place order — 2026-08-31 census over 62
 * episodes (scripts scratch: stage_durations census; medians 4.20 / 1.07 /
 * 3.13 / 0.23). Tier-2 numbers: re-derive per rig AND per task tempo.
 * The strong gate is what separates video-verified hesitation from "not
 * that obvious": ep50 fires at 1.23x/1.28x p90 and ep25's place runs 2.2x;
 * ep28 peaks at 1.16x across three marginal stages and stays silent —
 * 1.16 vs 1.23 is a THIN margin, re-derive as verdicts accumulate. */
// HESITATION_P90_S -> RigCalibration.hesitationP90S (rigProfile.ts)

/** Short transport: a wrong-location failure can be tactilely complete
 * (ep39: grasp, carry, real release — but the arm never went to the bowl;
 * Zheng: vision territory, EXCEPT the transport stage is "amazingly
 * short"). Corpus census 2026-08-31: ep39's transport = 0.78 s, the
 * minimum by nearly 2x (next ep16 1.46 s, p5 1.55 s) — 1.0 s splits the
 * gap with wide margins. Fires a review flag; the panel renders it as a
 * human-check card (never auto-counts as an attempt). */
// SHORT_TRANSPORT_MIN_S -> RigCalibration.shortTransportMinS (rigProfile.ts)

/** Combine function for failed_attempt spans (Zheng's ep54 verdict: one
 * finger nudges the cup onto the other finger, still graspable, one grab
 * finishes it — that chain is ONE attempt, not two). Discriminator is his
 * own attempt definition (an attempt = a grab-and-miss CYCLE): merge
 * adjacent spans only when the jaw never re-opened between them. Census:
 * ep54's gap reopens 0.1 units (merge); ep31's 17.4 and ep45's 17.2
 * (real retry cycles — keep separate). Threshold 5 units = the existing
 * jaw-reopen vocabulary; margins are wide on both sides. */
// ATTEMPT_MERGE_REOPEN_U -> RigCalibration.attemptMergeReopenU (rigProfile.ts)

/** Pure merge decision over chronologically sorted attempt spans —
 * exported for tests. `reopenBetween[k]` = max jaw reopen (units) between
 * span k and span k+1. */
export function mergeAttemptSpans(
  spans: Array<[number, number]>,
  reopenBetween: number[],
  reopenU: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let k = 0; k < spans.length; k++) {
    const prev = out[out.length - 1];
    if (k > 0 && prev && reopenBetween[k - 1] < reopenU) {
      prev[1] = Math.max(prev[1], spans[k][1]);
    } else {
      out.push([spans[k][0], spans[k][1]]);
    }
  }
  return out;
}
const HESITATION_MIN_SLOW_STAGES = 2;
const HESITATION_STRONG = 1.2;

/** Pure hesitation decision — exported for tests. `stageDurs` in the
 * HESITATION_P90_S stage order; null = stage missing (failure episodes). */
export function computeHesitation(
  stageDurs: Array<number | null>,
  excused: boolean,
  p90S: number[],
): boolean {
  if (excused) return false;
  let over = 0;
  let strong = false;
  for (let i = 0; i < p90S.length; i++) {
    const d = stageDurs[i];
    if (d === null || d === undefined) continue;
    if (d > p90S[i]) over++;
    if (d >= HESITATION_STRONG * p90S[i]) strong = true;
  }
  return over >= HESITATION_MIN_SLOW_STAGES && strong;
}

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

// ---------------------------------------------------------------- builders
//
// Profile-taking wrappers around the instrument layer: the same names and
// signatures every caller used before the split (cycle 7a), composing
// tactileSeries' drift correction with the residual gate. Interpretation
// enters the pipeline exactly here and nowhere else.

/** Drift correction as the DETECTOR and the corrected DISPLAY see it: the
 * per-taxel re-zero (tactileSeries.applyAdaptiveBaseline) followed by the
 * residual gate (rule 1 + pre-grasp form). `residualGate: false` runs the
 * re-zero alone — for A/B probes of the gate itself. */
export function applyAdaptiveBaseline(
  frames: unknown[],
  timestamps: number[],
  gripper: GripperSeries | null | undefined,
  opts: {
    /** rig calibration: idle margin and jaw re-close vocabulary */
    profile: RigProfile;
    /** Rule 1 (post-release residual gate) on by default; off for A/B
     * probes of the gate itself. */
    residualGate?: boolean;
  },
): number[][][][] | null {
  const P = opts.profile.calibration;
  const corrected = applyBaselineCore(frames, timestamps, gripper, {
    quietMarginN: P.quietMarginN,
  });
  if (!corrected || opts.residualGate === false) return corrected;
  return applyResidualGate(corrected, frames, timestamps, gripper, {
    quietMarginN: P.quietMarginN,
    jawRecloseU: P.jawRecloseU,
  });
}

/**
 * Build a TactileSeries from the 30 Hz main-table sensor frames, with the
 * residual gate applied (see applyAdaptiveBaseline above).
 */
export function buildSeriesFromSensorFrames(
  frames: unknown[],
  timestamps: number[],
  layout: [number, number, number][] | null,
  gripper: GripperSeries | null | undefined,
  profile: RigProfile,
): TactileSeries | null {
  if (!frames.length || !timestamps.length) return null;
  const corrected = applyAdaptiveBaseline(frames, timestamps, gripper, {
    profile,
  });
  return buildSeriesFromCorrectedFrames(frames, corrected, timestamps, layout);
}

/**
 * Build from raw sidecar CSV text (91 Hz, company 163-column schema), with
 * the residual gate applied. One CSV per finger; pass texts in finger
 * order. Duplicate-row axes: tactileSeries.RawCsvOptions.
 */
export function buildSeriesFromRawCsvs(
  csvTexts: string[],
  layout: [number, number, number][] | null,
  gripper: GripperSeries | null | undefined,
  opts: RawCsvOptions & {
    /** rig calibration (required — see rigProfile.ts) */
    profile: RigProfile;
  },
): TactileSeries | null {
  const parsed = parseRawCsvs(csvTexts, opts);
  if (!parsed) return null;
  return buildSeriesFromSensorFrames(
    parsed.frames as unknown as unknown[],
    parsed.timestamps,
    layout,
    gripper,
    opts.profile,
  );
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
  thresholds: Partial<DetectionThresholds> | undefined,
  arm: ArmMotionSeries | null | undefined,
  /** Detection context. `episodeIndex` keeps the signal screen from
   * letting a corpus episode's own reference windows vote for it. The
   * recorded OUTCOME is deliberately NOT accepted here (Jingyi's PR #1
   * review): the detector must tell the same story on an unlabeled
   * dataset as on a labeled one, and outcome-vs-story tension is an
   * evaluation question that lives in the offline runner. */
  context: {
    /** rig calibration — required, no default (rigProfile.ts) */
    profile: RigProfile;
    episodeIndex?: number;
  },
): AutoLabelResult {
  const P = context.profile.calibration;
  const th: DetectionThresholds = { ...P.thresholds, ...thresholds };
  // rig-calibrated numbers, by their historical names (provenance in the
  // comments above and in analysis/portability.md)
  const WEAK_ATTEMPT_MAX_N = P.weakAttemptMaxN;
  // on the 1 mN grid: the raw difference of two decimals is not a decimal
  // (2.3 - 0.3 = 1.9999999999999998) and a ten-quanta graze sums to the same
  const BRIEF_CONTACT_STRONG_N = Number(
    (P.weakAttemptMaxN - P.briefReportMarginN).toFixed(3),
  );
  const RELEASE_TRAVEL_MIN = P.releaseTravelMinU;
  const RELEASE_CLOSING_VETO = P.releaseClosingVetoU;
  const SLIDE_MIN_MM = P.slideMinMm;
  const SLIDE_JAW_OPEN_MIN = P.slideJawOpenMinU;
  const SLIDE_SQUEEZE_VETO_U = P.slideSqueezeVetoU;
  const SLIDE_LOAD_MIN_N = P.slideLoadMinN;
  const SHORT_TRANSPORT_MIN_S = P.shortTransportMinS;
  const { t, rateHz, fingers } = series;
  const n = t.length;
  const flags: string[] = [];
  const spans: DetectedSpan[] = [];
  // capability flags: what this dataset could NOT support, stated instead
  // of silently degraded (Jingyi's PR #1 review)
  if (!series.hasLayout) flags.push("no_layout");
  if (!gripper || gripper.t.length < 3) flags.push("no_gripper");
  if (!arm || arm.t.length < 3) flags.push("no_arm");
  // the numbers behind this run were not verified on this rig (template,
  // or a dataset file that says so): say it in every result
  if (!context.profile.verified) flags.push("profile_unverified");
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
      flags: [...flags, "no_contact"],
      spans: [],
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
    // single-taxel floor (see SINGLE_TAXEL_QUANTA); counts loaded taxels on
    // the RAW frames — the corrected 0.15 N `active` line erodes as the idle
    // tracker absorbs a residual, and two stuck taxels would slip under it.
    // Off when the series carries no raw count or no measured quantum.
    const singleTaxelMaxN =
      series.quantumN !== undefined && f.rawLoaded !== undefined
        ? SINGLE_TAXEL_QUANTA * series.quantumN
        : -1;
    const singleTaxelFloor = (i: number, fnNow: number): boolean =>
      singleTaxelMaxN > 0 && f.rawLoaded![i] <= 1 && fnNow <= singleTaxelMaxN;

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
      } else if (
        inContact &&
        (fn < th.contactExitN || singleTaxelFloor(i, fn))
      ) {
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
        spans.push({
          kind: "post_task_contact",
          startS: spanStart,
          endS: spanEnd,
          finger: fi,
        });
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
  const fingerSpans: { startS: number; endS: number; finger: number }[] = [];
  {
    const byFinger = new Map<number, DetectedEvent[]>();
    for (const e of cleaned) {
      if (!byFinger.has(e.finger)) byFinger.set(e.finger, []);
      byFinger.get(e.finger)!.push(e);
    }
    for (const [fi, list] of byFinger) {
      let open = -1;
      for (const e of list) {
        if (e.label === "contact_onset") {
          if (open < 0) open = e.startS;
        } else if (e.label === "release" || e.label === "drop") {
          if (open >= 0) {
            fingerSpans.push({ startS: open, endS: e.startS, finger: fi });
            open = -1;
          }
        }
      }
      if (open >= 0) fingerSpans.push({ startS: open, endS: dur, finger: fi });
    }
  }
  fingerSpans.sort((a, b) => a.startS - b.startS);
  // a bout remembers which fingers took part: a single-finger bout yields a
  // finger-scoped span, a two-finger bout a hand-level one
  const bouts: { startS: number; endS: number; fingers: Set<number> }[] = [];
  for (const s of fingerSpans) {
    const cur = bouts[bouts.length - 1];
    if (cur && s.startS <= cur.endS + 0.5) {
      cur.endS = Math.max(cur.endS, s.endS);
      cur.fingers.add(s.finger);
    } else {
      bouts.push({
        startS: s.startS,
        endS: s.endS,
        fingers: new Set([s.finger]),
      });
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
      const ARM_MOVE_EPS = P.armMoveEpsUps; // summed units/s; jitter ~1-2, slow drift ~5-10
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
      const SQUEEZE_MIN_TRAVEL = P.squeezeMinTravelU; // jaw units; real squeezes are 30-50
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
    // (WEAK_ATTEMPT_MAX_N comes from the rig profile; the brief-contact
    // reporting bar is derived from it at the top of detectEvents)
    // Pads touching EACH OTHER, no object: the jaw bottoms out at its
    // mechanical minimum, which an object between the pads never allows
    // (Zheng's ep0 verdict + corpus survey: the air-close dwells at jaw
    // 0.5 — the ONLY sub-2.0 dwell in all 63 episodes; the nearest real
    // hold crushes the foam ball to 2.8, ep37 — thin margin, re-derive
    // for harder objects). Such a span is a distinct outcome, not an
    // object attempt, and is excluded from attempt counting.
    const AIR_CLOSE_POS = P.airClosePos;
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
    const attemptSpan = (
      startS: number,
      endS: number,
      peakN: number,
      finger: number | null,
    ): DetectedSpan => {
      const kind: SpanKind =
        jawMinIn(startS - 0.3, endS + 0.3) < AIR_CLOSE_POS
          ? "air_grasp"
          : peakN < WEAK_ATTEMPT_MAX_N
            ? "weak_contact"
            : "failed_attempt";
      return { kind, startS, endS, finger, peakN };
    };
    const boutFinger = (b: { fingers: Set<number> }): number | null =>
      b.fingers.size === 1 ? [...b.fingers][0] : null;
    // identity at the 0.1 s resolution the flags always had
    const sameSpan = (a: number, b: number): boolean =>
      spans.some(
        (s) =>
          s.startS.toFixed(1) === a.toFixed(1) &&
          s.endS.toFixed(1) === b.toFixed(1),
      );
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
      spans.push(attemptSpan(b.startS, b.endS, boutPeakN(b), boutFinger(b)));
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
    const HAND_LOSS_N = P.handLossN;
    const HAND_LOSS_MIN_S = 0.35;
    const JAW_RETRY_RISE = P.jawRetryRiseU;
    const JAW_RETRY_WIN_S = 2.5;
    const SQUEEZE_THROUGH_BELOW = P.squeezeThroughBelowU;
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
          if (sameSpan(spanStart, e.startS)) continue;
          spans.push(attemptSpan(spanStart, e.startS, pk, fi));
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
    const AIR_MISS_TRAVEL = P.airMissTravelU;
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
          const prior = spans.find(
            (s) =>
              (s.kind === "failed_attempt" || s.kind === "weak_contact") &&
              Math.abs(peakT - Number(s.endS.toFixed(1))) <= 0.5,
          );
          if (prior) {
            prior.kind = "failed_attempt";
            prior.endS = reopenT;
          } else if (!sameSpan(peakT, reopenT)) {
            spans.push({
              kind: "failed_attempt",
              startS: peakT,
              endS: reopenT,
              finger: null,
            });
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
      spans.some(
        (s) =>
          s.kind === "failed_attempt" &&
          lastTerminal.startS >= Number(s.startS.toFixed(1)) - 0.05 &&
          lastTerminal.startS <= Number(s.endS.toFixed(1)) + 0.05,
      );
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
    const airSpans2: Array<[number, number]> = spans
      .filter((s) => s.kind === "air_grasp")
      .map((s) => [
        Number(s.startS.toFixed(1)) - 0.1,
        Number(s.endS.toFixed(1)) + 0.1,
      ]);
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
    const airSpans: Array<[number, number]> = spans
      .filter((s) => s.kind === "air_grasp")
      .map((s) => [
        Number(s.startS.toFixed(1)) - 0.1,
        Number(s.endS.toFixed(1)) + 0.1,
      ]);
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
        const terminalNear = (tc: number): boolean =>
          cleaned.some(
            (e) =>
              e.finger === f &&
              (e.label === "place" ||
                e.label === "release" ||
                e.label === "finger_unload") &&
              e.startS >= tc - 0.25 &&
              e.startS <= tc + SLIDE_TERMINAL_VETO_S,
          );
        // hand load retained across the slide window (see
        // SLIDE_VETO_RETENTION); NaN when the hand carried < 1 N at the
        // window start, which the slide gate itself excludes
        const loadRetention = (tc: number): number => {
          const a = tc - SLIDE_RETENTION_PRE_S;
          const b = tc + SLIDE_RETENTION_POST_S;
          let s0 = 0;
          let n0 = 0;
          let s1 = 0;
          let n1 = 0;
          for (let i = 0; i < n; i++) {
            if (t[i] < a) continue;
            if (t[i] > b) break;
            let hand = 0;
            for (const g of fingers) hand += g.fn[i];
            if (t[i] <= a + SLIDE_RETENTION_EDGE_S) {
              s0 += hand;
              n0++;
            } else if (t[i] >= b - SLIDE_RETENTION_EDGE_S) {
              s1 += hand;
              n1++;
            }
          }
          if (n0 < 3 || n1 < 3 || s0 / n0 <= 1.0) return NaN;
          return s1 / n1 / (s0 / n0);
        };
        // the placement veto needs both facts: a placement-type exit
        // ahead AND the load actually leaving the hand
        const placingVeto = (tc: number): boolean => {
          if (!terminalNear(tc)) return false;
          const r = loadRetention(tc);
          return !(r >= SLIDE_VETO_RETENTION); // NaN keeps today's veto
        };
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
          if (placingVeto(tc)) continue;
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
      if (!P.screenReference) break; // no per-rig reference: screen off
      const votes = screenBackgroundVotes(
        series,
        e.finger,
        e.startS,
        context.episodeIndex,
        P.screenReference,
      );
      if (votes === null || votes < SCREEN_VOTE_MIN) continue;
      e.data = { ...e.data, scr: votes };
      if (e.label === "place" || e.label === "release" || e.label === "drop") {
        flags.push(`residual_suspect@${e.startS.toFixed(1)}s`);
      }
    }
  }

  // Combine chained failed_attempt spans (see mergeAttemptSpans
  // provenance): no jaw reopen between two spans = still the same grab.
  {
    const failed = spans
      .filter((s) => s.kind === "failed_attempt")
      .sort((a, b) => a.startS - b.startS);
    const ivals: Array<[number, number]> = failed.map((s) => [
      Number(s.startS.toFixed(1)),
      Number(s.endS.toFixed(1)),
    ]);
    if (ivals.length > 1 && gripper) {
      const reopen: number[] = [];
      for (let k = 0; k < ivals.length - 1; k++) {
        let runMin = Infinity;
        let maxRise = 0;
        for (let j = 0; j < gripper.t.length; j++) {
          if (gripper.t[j] < ivals[k][1]) continue;
          if (gripper.t[j] > ivals[k + 1][0]) break;
          runMin = Math.min(runMin, gripper.pos[j]);
          maxRise = Math.max(maxRise, gripper.pos[j] - runMin);
        }
        reopen.push(maxRise);
      }
      const merged = mergeAttemptSpans(ivals, reopen, P.attemptMergeReopenU);
      if (merged.length < ivals.length) {
        for (let i = spans.length - 1; i >= 0; i--) {
          if (spans[i].kind === "failed_attempt") spans.splice(i, 1);
        }
        for (const [a, b] of merged) {
          // a merged span keeps a finger only when every part agrees
          const parts = failed.filter(
            (s) =>
              Number(s.startS.toFixed(1)) >= a - 1e-6 &&
              Number(s.endS.toFixed(1)) <= b + 1e-6,
          );
          const fingers = new Set(parts.map((s) => s.finger));
          const peaks = parts
            .map((s) => s.peakN)
            .filter((v): v is number => v !== undefined);
          spans.push({
            kind: "failed_attempt",
            startS: a,
            endS: b,
            finger: fingers.size === 1 ? parts[0].finger : null,
            peakN: peaks.length ? Math.max(...peaks) : undefined,
          });
        }
      }
    }
  }

  // Short transport → human-check card (see SHORT_TRANSPORT_MIN_S
  // provenance; ep39's wrong-location failure is otherwise invisible).
  {
    const tA = subtasks.find((s2) => s2.label === "transport")?.startS;
    const tB = subtasks.find((s2) => s2.label === "place_release")?.startS;
    if (
      tA !== undefined &&
      tB !== undefined &&
      tB - tA < SHORT_TRANSPORT_MIN_S
    ) {
      spans.push({
        kind: "short_transport",
        startS: tA,
        endS: tB,
        finger: null,
      });
    }
  }

  // Hesitation (Zheng's ep50 video ruling, 2026-08-31: "every step took
  // longer than expected, but no single step failed" — hesitation is NOT
  // an attempt). Detectable from stage durations alone: >= 2 stages above
  // the corpus p90 with at least one >= HESITATION_STRONG x p90, and no
  // retry/failure flag to excuse the time (an episode slow because it
  // retried is retrying, not hesitating — ep31/ep47/ep48 are excused).
  // Runs AFTER the result flag so the excuse check sees it.
  {
    const seq: SubtaskLabel[] = [
      "approach",
      "grasp",
      "transport",
      "place_release",
    ];
    // last labeled instant, matching the calibration census (max atom
    // timestamp) — series dur overshoots on episodes with long tails
    let lastS = 0;
    for (const s2 of subtasks) lastS = Math.max(lastS, s2.startS);
    for (const e of cleaned) {
      if (!deletedPlaces.has(e)) lastS = Math.max(lastS, e.endS);
    }
    const stageDurs: Array<number | null> = seq.map((label, i) => {
      const a = subtasks.find((s2) => s2.label === label)?.startS;
      if (a === undefined) return null;
      const b =
        i + 1 < seq.length
          ? subtasks.find((s2) => s2.label === seq[i + 1])?.startS
          : lastS;
      return b === undefined ? null : b - a;
    });
    // excused only by signal-side evidence of a retry; the recorded
    // outcome no longer reaches the detector (it excuses in the runner)
    const excused = spans.some((s) => s.kind === "failed_attempt");
    if (computeHesitation(stageDurs, excused, P.hesitationP90S)) {
      flags.push("hesitation");
    }
  }

  // flags in chronological order — they are appended in pipeline-pass
  // order, which put ep45's air-miss after its later squeeze-through
  const flagTime = (fl: string): number => {
    const m = /@([\d.]+)/.exec(fl);
    return m ? Number(m[1]) : Infinity;
  };
  spans.sort((a, b) => a.startS - b.startS);
  const allFlags = [...flags, ...spans.map(spanFlag)];
  allFlags.sort((a, b) => flagTime(a) - flagTime(b));

  return {
    subtasks,
    events: cleaned.filter((e) => !deletedPlaces.has(e)),
    flags: allFlags,
    spans,
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
  // Decided on the EVENTS (which carry their finger), then serialized —
  // never by parsing atom text. A span deletes only its own finger's
  // events (Jingyi's blocker 3: a one-finger span must not swallow the
  // partner's real atoms by timestamp); a hand-level span (finger null)
  // covers both. post_task_contact spans drop only the gate-downgraded
  // LOW events (ep25: f0's real release at 14.18 sits inside f1's
  // phantom span and survives). weak_contact spans are phantom by
  // calibration (every video-verified false bout peaks <= 2.2 N) and
  // their events are NOT downgraded (ep25's graze exits as a medium
  // "release" at 1.83 s), so everything of that finger inside them goes.
  const covers = (s: DetectedSpan, e: DetectedEvent): boolean =>
    (s.finger === null || s.finger === e.finger) &&
    e.startS >= Number(s.startS.toFixed(1)) - 0.05 &&
    e.startS <= Number(s.endS.toFixed(1)) + 0.05;
  const kept = result.events.filter((e) => {
    // real-name pass: phantom and sensor_residual are not real contact
    // (finger_unload IS real signal and stays)
    if (e.label === "phantom" || e.label === "sensor_residual") return false;
    for (const s of result.spans) {
      if (s.kind === "weak_contact" && covers(s, e)) return false;
      if (
        s.kind === "post_task_contact" &&
        e.confidence === "low" &&
        covers(s, e)
      ) {
        return false;
      }
    }
    return true;
  });
  return resultToAtoms({ ...result, events: kept });
}
