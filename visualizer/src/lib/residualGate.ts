// Residual gate — the INTERPRETATION-side post-pass over the drift-corrected
// frames (PR B of Jingyi's split; Zheng's rulings on the residual class,
// 2026-09-03: "corrected view only, raw stays audit", "our new rules should
// apply to pre-grasp"). tactileSeries.applyAdaptiveBaseline only re-zeroes;
// this pass REFUSES, frame by frame, sensor output that cannot be contact:
// the stuck taxels and bursts a Paxini pad keeps emitting after an object
// leaves (rule 1), and the single-taxel vocabulary rule 2 shares with the
// detector's exit clause. One implementation for the detector and the
// corrected display (eventDetection.applyAdaptiveBaseline composes the two
// passes); the raw display never sees it.

import { measureQuantumN, type GripperSeries } from "./tactileSeries";

/** Single-taxel floor (Zheng's rule 2, 2026-09-03): ONE loaded taxel at no
 * more than ~1 force quantum cannot be holding anything, so it counts as
 * "below the exit level" even when the summed force sits at/above
 * contactExitN. Provenance — sotac ep37 f1: the ball leaves at 10.832 s
 * (10 of 11 taxels zero in one frame) but taxel #1 stays stuck at one
 * quantum (0.2 N); after the baseline half-absorbs it the sum reads
 * exactly 0.10 N = the exit line, so contact held until 11.38 s and the
 * real release was renamed sensor_residual. Post-release census: stuck
 * single taxels on 7/124 finger-windows, all finger 1, same taxels
 * (#1, #3). 1.5 quanta = one stuck taxel with float/absorption margin,
 * still below any two-taxel contact (2 quanta). Contrast kept: a real
 * graze is many taxels (ep54: 12 taxels × 1 quantum for 4 frames). */
export const SINGLE_TAXEL_QUANTA = 1.5;
/** Post-release residual gate (Zheng's rule 1, 2026-09-03; applied by
 * applyResidualGate so the detector AND the corrected display see it;
 * the raw display stays the audit view). Mechanism (sotac ep37 f1 and
 * 14 more finger-windows, all finger 1): after the object leaves, the pad
 * keeps 1-3 taxels stuck at one quantum plus sub-0.3 s bursts of 6-12
 * taxels on the just-released set; a real graze is waveform-identical
 * (ep54: 2.4 N, 12 taxels, 4 frames), so only CONTEXT separates them.
 * The gate ARMS only after a hold (a sustained load >= quiet margin for
 * >= RESIDUAL_GATE_SUSTAIN_S) has EXITED: force at the exit level, or at
 * most RESIDUAL_GATE_STUCK_TAXELS raw-loaded taxels carrying no more than
 * that many quanta, for >= RESIDUAL_GATE_SUSTAIN_S (retroactive to the
 * run start). A mid-hold DIP is not an exit: ep49 drops from 7 N to
 * under 1 N for 0.47 s during a violent slip and re-grips; the first
 * version armed on any sub-margin stretch and renamed that re-grip a
 * phantom. While gated the finger reports nothing until a SUSTAINED
 * load (real re-contact, unmasked from its first frame) or the jaw
 * closes again by RESIDUAL_GATE_JAW_RECLOSE_U from its running max and a
 * sustained load confirms the grab within RESIDUAL_GATE_RETRY_CONFIRM_S.
 * Stuck taxels never reach the margin; bursts never last; both vanish.
 * PRE-GRASP form (Zheng: "our new rules should apply to pre-grasp"):
 * before the first hold there is no exit to arm on and no burst/duration
 * machinery may run — the same waveforms there are pre-grasp grazes =
 * attempts (ep16 @2.64, ep54 @2.37/@3.37, video-verified; a full gate
 * erased ep54's attempt). So only the residual SHAPE is refused, frame by
 * frame: at most RESIDUAL_GATE_STUCK_TAXELS raw-loaded taxels at no more
 * than that many quanta (the carried-over stuck taxel: ep25 f1 1.3-1.8 s,
 * ep36 f1 1.2-3.1 s, both 0.2 N; ep43 f0's settled offset), and never
 * while the jaw is closing from its running max (a grab's first frames
 * can be 1-3 taxels). Grazes (>= 4 taxels or > 3 quanta) pass untouched.
 * Non-causal (run lookahead), like the plateau median. Not a
 * subtraction: a refuse-to-believe rule. */
// RESIDUAL_GATE_QUIET_N -> RigCalibration.quietMarginN (rigProfile.ts)
const RESIDUAL_GATE_SUSTAIN_S = 0.3; // = EXIT_MIN_S
// RESIDUAL_GATE_JAW_RECLOSE_U -> RigCalibration.jawRecloseU (rigProfile.ts)
/** Exit criterion for ARMING the gate. Jaw-free forms: force under the
 * exit level, or rule 2's single-taxel floor (drops leave residue too).
 * Multi-taxel form: at most this many raw-loaded taxels carrying at most
 * this many quanta in total (ep25 tail: 2 stuck, ep28: 3 stuck at 0.2 N
 * each) AND the jaw has opened RESIDUAL_GATE_JAW_RECLOSE_U above the
 * hold's tightest position — a thin 3-taxel hold with the jaw still
 * closed is a real (dipping) grip, not an exit. */
const RESIDUAL_GATE_STUCK_TAXELS = 3;
const RESIDUAL_GATE_EXIT_N = 0.1; // = DEFAULT_THRESHOLDS.contactExitN
/** A re-close AFTER a hold counts as a new grab only if a sustained load
 * follows within this window (lookahead): the post-task jaw reset closes
 * slowly back toward rest (ep22: 83 -> 43 units over 1.4 s, ep23: 74 ->
 * 55) with nothing in hand and would otherwise re-open the gate onto the
 * residual. Window: attempt rule = jaw re-opens within 2.5 s of the
 * drop, retry close + new contact follow; 3 s covers the corpus. */
const RESIDUAL_GATE_RETRY_CONFIRM_S = 3.0;

/** The two rig numbers the gate reads (Tier 2, from the rig profile). */
export interface ResidualGateOptions {
  /** idle margin (N) — a sustained load at/above it is a hold */
  quietMarginN: number;
  /** jaw travel (units) that counts as a re-close / an opening */
  jawRecloseU: number;
}

/**
 * Rule 1 (post-release residual gate) plus its pre-grasp form, applied IN
 * PLACE to `out` (applyAdaptiveBaseline's output for `frames`, same length
 * and shape). Returns `out`. Non-causal (run lookahead), like the plateau
 * median. Not a subtraction: a refuse-to-believe rule.
 */
export function applyResidualGate(
  out: number[][][][],
  frames: unknown[],
  timestamps: number[],
  gripper: GripperSeries | null | undefined,
  opts: ResidualGateOptions,
): number[][][][] {
  const first = frames[0] as number[][][] | undefined;
  if (!first || !Array.isArray(first[0])) return out;
  const nFingers = first.length;
  const nTaxels = first[0].length;
  const n = Math.min(frames.length, timestamps.length, out.length);
  const t = timestamps;
  {
    const RESIDUAL_GATE_QUIET_N = opts.quietMarginN;
    const RESIDUAL_GATE_JAW_RECLOSE_U = opts.jawRecloseU;
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
    const dtEnd = n > 1 ? t[n - 1] - t[n - 2] : 0;
    // force quantum on the RAW frames (see TactileSeries.quantumN)
    const quantum = measureQuantumN(frames, n) ?? Infinity;
    const stuckMaxN = Number.isFinite(quantum)
      ? RESIDUAL_GATE_STUCK_TAXELS * quantum
      : 0;
    type Run = { start: number; end: number; on: boolean };
    const segment = (flag: (i: number) => boolean): [Int32Array, Run[]] => {
      const runOf = new Int32Array(n);
      const runs: Run[] = [];
      for (let i = 0; i < n; ) {
        const on = flag(i);
        let j = i + 1;
        while (j < n && flag(j) === on) j++;
        runs.push({ start: i, end: j, on });
        for (let k = i; k < j; k++) runOf[k] = runs.length - 1;
        i = j;
      }
      return [runOf, runs];
    };
    const sustained = (r: Run): boolean =>
      (r.end < n ? t[r.end] : t[n - 1] + dtEnd) - t[r.start] >=
      RESIDUAL_GATE_SUSTAIN_S;
    for (let f = 0; f < nFingers; f++) {
      const sum = new Float64Array(n);
      const rawLoaded = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const row = out[i][f];
        let s = 0;
        for (let k = 0; k < row.length; k++) s += row[k][2];
        sum[i] = s;
        const rawTaxels = (frames[i] as number[][][] | undefined)?.[f];
        if (rawTaxels) {
          for (let k = 0; k < nTaxels; k++) {
            if (Math.abs(rawTaxels[k]?.[2] ?? 0) > 1e-6) rawLoaded[i]++;
          }
        }
      }
      const [loadRunOf, loadRuns] = segment(
        (i) => sum[i] >= RESIDUAL_GATE_QUIET_N,
      );
      // jaw opened since the latest sustained hold's tightest position
      const jawOpened = new Uint8Array(n);
      if (gripper) {
        let minJaw = Infinity;
        let curRun = -1;
        for (let i = 0; i < n; i++) {
          if (loadRunOf[i] !== curRun) {
            curRun = loadRunOf[i];
            const r = loadRuns[curRun];
            if (r.on && sustained(r)) minJaw = Infinity; // new hold
          }
          const jp = jawPosAt(t[i]);
          const r = loadRuns[curRun];
          if (r.on && sustained(r) && jp < minJaw) minJaw = jp;
          jawOpened[i] =
            Number.isFinite(minJaw) &&
            jp >= minJaw + RESIDUAL_GATE_JAW_RECLOSE_U
              ? 1
              : 0;
        }
      }
      const exited = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const s = sum[i];
        const single =
          Number.isFinite(quantum) &&
          rawLoaded[i] <= 1 &&
          s <= SINGLE_TAXEL_QUANTA * quantum;
        const fewStuck =
          jawOpened[i] === 1 &&
          rawLoaded[i] <= RESIDUAL_GATE_STUCK_TAXELS &&
          s <= stuckMaxN;
        exited[i] = s < RESIDUAL_GATE_EXIT_N || single || fewStuck ? 1 : 0;
      }
      const [exitRunOf, exitRuns] = segment((i) => exited[i] === 1);
      // lookahead: index where the next SUSTAINED loaded run starts
      const nextLoad = new Int32Array(n).fill(-1);
      {
        let nxt = -1;
        for (let i = n - 1; i >= 0; i--) {
          const r = loadRuns[loadRunOf[i]];
          if (r.on && r.start === i && sustained(r)) nxt = i;
          nextLoad[i] = nxt;
        }
      }
      let gated = false;
      let held = false; // a sustained load seen since the gate last opened
      let everHeld = false;
      let jawMax = -Infinity;
      let jawRunMax = -Infinity; // over the whole episode so far (pre-grasp)
      let curLoad = -1;
      let curExit = -1;
      for (let i = 0; i < n; i++) {
        if (!everHeld) {
          // pre-grasp form: refuse residual-shaped frames while the jaw is
          // not closing; a hold (sustained load) ends this phase for good
          const r = loadRuns[loadRunOf[i]];
          if (r.on && sustained(r)) {
            everHeld = true;
          } else {
            let closing = false;
            if (gripper) {
              const jp = jawPosAt(t[i]);
              if (jp > jawRunMax) jawRunMax = jp;
              closing = jp <= jawRunMax - RESIDUAL_GATE_JAW_RECLOSE_U;
            }
            if (
              !closing &&
              rawLoaded[i] <= RESIDUAL_GATE_STUCK_TAXELS &&
              sum[i] <= stuckMaxN
            ) {
              const row = out[i][f];
              for (let k = 0; k < row.length; k++) row[k] = [0, 0, 0];
              continue;
            }
          }
        }
        if (loadRunOf[i] !== curLoad) {
          curLoad = loadRunOf[i];
          const r = loadRuns[curLoad];
          if (r.on && sustained(r)) {
            gated = false; // real (sustained) load: believe the pad
            held = true;
          }
        }
        if (exitRunOf[i] !== curExit) {
          curExit = exitRunOf[i];
          const r = exitRuns[curExit];
          if (r.on && held && !gated && sustained(r)) {
            // the hold has exited: refuse residual until a new grab or a
            // new sustained load
            gated = true;
            held = false;
            jawMax = -Infinity;
          }
        }
        if (gated && gripper) {
          const jp = jawPosAt(t[i]);
          if (jp > jawMax) jawMax = jp;
          if (jp <= jawMax - RESIDUAL_GATE_JAW_RECLOSE_U) {
            const confirmed =
              nextLoad[i] >= 0 &&
              t[nextLoad[i]] - t[i] <= RESIDUAL_GATE_RETRY_CONFIRM_S;
            if (confirmed) {
              gated = false; // a new grab: believe the pad again
            } else {
              jawMax = jp; // post-task reset: keep refusing, re-check later
            }
          }
        }
        if (gated) {
          const row = out[i][f];
          for (let k = 0; k < row.length; k++) row[k] = [0, 0, 0];
        }
      }
    }
  }
  return out;
}
