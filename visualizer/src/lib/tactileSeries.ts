// Tactile series — the INSTRUMENT layer of the auto-annotator (Jingyi's
// PR #1 review: "PR A: clock map, deviceGridHz, copY fix, raw channels,
// display toggle, capability flags").
//
// Everything here turns recorded sensor data into per-finger signals and
// nothing here interprets them: the series types, the per-taxel drift
// correction (the detector's input and a display convenience behind a
// labelled toggle — never stored), the raw-sidecar parser with its two
// duplicate-row axes (dedupFrames, deviceGridHz), the positive-mass
// center of pressure with its on-pad invariant, the raw channels kept
// next to the smoothed ones, the measured force quantum, and the
// table-to-raw clock map. The interpretation layer (eventDetection.ts,
// residualGate.ts — PR B) consumes this module and this module imports
// nothing from it.
//
// Works at 30 Hz (main-table sensorFrames) or ~91 Hz (raw sidecar CSVs);
// builders for both input shapes are provided.

// ---------------------------------------------------------------- types

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
  /** Positive-mass center of pressure along the finger long axis (mm, +Y
   * of the taxel layout): fz-weighted average over taxels with fz > 0.05,
   * numerator and denominator over that same set (fixed per Jingyi's PR #1
   * review). NaN when positive mass < 0.2 N or without layout.
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
  /** count of taxels whose RAW |fz| is non-zero — the physical "loaded
   * taxel" count, immune to baseline erosion (single-taxel exit floor). */
  rawLoaded?: Float64Array;
}

export interface TactileSeries {
  t: Float64Array; // episode-relative seconds, ascending
  rateHz: number;
  fingers: FingerSeries[];
  /** Sensor normal-force resolution (N): the smallest non-zero |fz| in the
   * RAW frames (measured, not assumed — sotac: 0.2 N in all 124 sidecar
   * files, twice the 0.1 N/LSB the datasheet suggests). Undefined when no
   * taxel ever reported force. Used by the single-taxel exit floor. */
  quantumN?: number;
  /** true when a taxel layout was available (CoP-based rules possible) */
  hasLayout?: boolean;
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

// ---------------------------------------------------------------- helpers

export function median5(x: Float64Array): Float64Array {
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

export function movingRms(x: Float64Array, win: number): Float64Array {
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

export function derivative(x: Float64Array, t: Float64Array): Float64Array {
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
export function relStd(x: Float64Array, i0: number, i1: number): number {
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

/** Force resolution of the sensor (N): the smallest non-zero |fz| over the
 * first `n` RAW frames (sotac: 0.2 N in every sidecar file — measured, not
 * the 0.1 N/LSB the datasheet suggests). Undefined when no taxel ever
 * reported force. Measured on UNcorrected frames: correction shifts values
 * off the quantum grid. */
export function measureQuantumN(
  frames: unknown[],
  n: number = frames.length,
): number | undefined {
  let quantum = Infinity;
  for (let i = 0; i < n; i++) {
    const frame = frames[i] as number[][][] | undefined;
    if (!frame) continue;
    for (let f = 0; f < frame.length; f++) {
      const taxels = frame[f];
      if (!taxels) continue;
      for (let k = 0; k < taxels.length; k++) {
        const fz = Math.abs(taxels[k]?.[2] ?? 0);
        if (fz > 1e-6 && fz < quantum) quantum = fz;
      }
    }
  }
  return Number.isFinite(quantum) ? quantum : undefined;
}

// ---------------------------------------------------------------- drift correction

/** Options of the drift correction. */
export interface BaselineOptions {
  /** Idle margin (N): while a finger's total normal AND shear force stay
   * under it the per-taxel zero tracks the signal; above it the zero
   * freezes so grip force is never absorbed. A rig number (Tier 2 in
   * analysis/portability.md): the detector takes it from the rig profile
   * (rigProfile.ts); the display uses DISPLAY_QUIET_MARGIN_N. */
  quietMarginN: number;
}

/** The idle margin the corrected DISPLAY uses when no rig profile is in
 * play (sotac: 1.0 N — the idle-finger noise stays under ~0.3 N on both
 * pads, the lightest real hold reads > 1.5 N). The detector never reads
 * this constant. */
export const DISPLAY_QUIET_MARGIN_N = 1.0;

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
 * This pass only RE-ZEROES and clamps; it never refuses contact. The
 * interpretation layer's refuse-to-believe pass (residualGate.ts) runs on
 * its output.
 */
export function applyAdaptiveBaseline(
  frames: unknown[],
  timestamps: number[],
  gripper: GripperSeries | null | undefined,
  opts: BaselineOptions,
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
  const QUIET_MARGIN_N = opts.quietMarginN;
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
        // (Variant B — base=min(base,rawZ) per sample — was tried here and
        // FALSIFIED 2026-09-02: tracking the running minimum of a noisy
        // signal biases the zero to the noise floor's bottom edge; ep37's
        // exit never fired, ep43's empty hand read 1.5 N. The inequality
        // "raw ceils the true zero" is correct; snapping to it is not.)
        const fx = (taxels?.[k]?.[0] ?? 0) - base[k * 3];
        const fy = (taxels?.[k]?.[1] ?? 0) - base[k * 3 + 1];
        const fz = (taxels?.[k]?.[2] ?? 0) - base[k * 3 + 2];
        // Physical-domain clamp (Zheng's ruling, 2026-09-02): normal force
        // cannot be negative — the firmware reports fz UNSIGNED, so every
        // negative here is subtraction residue (the memorized baseline
        // outliving a drifting signal; ep47 tail: raw all-zero, corrected
        // −0.65 N over 11 ghost taxels). A taxel with no normal force also
        // transmits no friction, so its residual shear is the same ghost —
        // zeroed with it. Shear SIGNS on pressing taxels pass through
        // untouched (direction is real information). The idle tracker
        // below still sees the signed sums: it needs the negative error
        // signal to follow a zero that wandered DOWN. Only the OUTPUT is
        // clamped.
        row[k] = fz > 0 ? [fx, fy, fz] : [0, 0, 0];
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

// ---------------------------------------------------------------- series builders

/**
 * Build a TactileSeries from raw frames and their drift-corrected
 * counterpart. `frames[i]` is a nested array of shape [nFingers][nTaxels][3]
 * (fx, fy, fz); `corrected` is applyAdaptiveBaseline's output (or null:
 * the raw frames are used as-is). `layout` gives per-taxel [x, y, z] mm
 * positions (finger long axis = +Y). The raw channels (fnRaw, fsRaw,
 * rawLoaded, quantumN) are always measured on `frames`.
 */
export function buildSeriesFromCorrectedFrames(
  frames: unknown[],
  corrected: number[][][][] | null,
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

  const src: unknown[] = corrected ?? frames;

  const quantumN = measureQuantumN(frames, n);

  // Layout bounds for the CoP invariant check (Jingyi's PR #1 review): a
  // positive-weight average of taxel positions is a convex combination and
  // cannot leave the pad — if it does, the math upstream is wrong again.
  let copYMin = -Infinity;
  let copYMax = Infinity;
  if (layout) {
    copYMin = Infinity;
    copYMax = -Infinity;
    for (const p of layout) {
      if (p[1] < copYMin) copYMin = p[1];
      if (p[1] > copYMax) copYMax = p[1];
    }
  }

  const fingers: FingerSeries[] = [];
  for (let f = 0; f < nFingers; f++) {
    const fn = new Float64Array(n);
    const fs = new Float64Array(n);
    const tauZ = new Float64Array(n);
    const slipDiv = new Float64Array(n);
    const edgeRateRatio = new Float64Array(n);
    const copYSeries = new Float64Array(n).fill(NaN);
    const active = new Float64Array(n);
    const rawLoaded = new Float64Array(n);
    let prevShear: Float64Array | null = null; // [nTaxels*2]
    const curShear = new Float64Array(nTaxels * 2);

    for (let i = 0; i < n; i++) {
      const frame = src[i] as number[][][];
      const taxels = frame?.[f];
      if (!taxels) continue;
      const rawTaxels = (frames[i] as number[][][] | undefined)?.[f];
      let sfx = 0;
      let sfy = 0;
      let sfz = 0;
      let cx = 0;
      let cy = 0;
      let szPos = 0;
      for (let k = 0; k < nTaxels; k++) {
        const fx = taxels[k]?.[0] ?? 0;
        const fy = taxels[k]?.[1] ?? 0;
        const fz = taxels[k]?.[2] ?? 0;
        sfx += fx;
        sfy += fy;
        sfz += fz;
        // fz is non-negative by construction: raw is firmware-unsigned and
        // applyAdaptiveBaseline clamps its output (no ghost-taxel counting)
        if (fz > 0.15) active[i]++;
        if (Math.abs(rawTaxels?.[k]?.[2] ?? 0) > 1e-6) rawLoaded[i]++;
        curShear[k * 2] = fx;
        curShear[k * 2 + 1] = fy;
        if (layout && fz > 0.05) {
          cx += fz * layout[k][0];
          cy += fz * layout[k][1];
          szPos += fz;
        }
      }
      fn[i] = sfz;
      fs[i] = Math.hypot(sfx, sfy);
      // CoP = positive-mass weighted average: numerator AND denominator
      // over the SAME taxel set (fz > 0.05). The previous denominator was
      // the all-taxel sum, which the adaptive baseline routinely drives
      // partly negative — the ratio became force-dependent and a static
      // contact "traveled" as grip decayed (Jingyi's PR #1 review: static
      // contact at 15 mm read 17→29 mm as force fell 5→1.2 N, past the
      // 19.3 mm pad end; ~5.7 mm fake travel vs SLIDE_MIN_MM 2.0).
      const copValid = layout && szPos > 0.2;
      const copX = copValid ? cx / szPos : 0;
      const copY = copValid ? cy / szPos : 0;
      // invariant: convex combination stays on the pad (small numeric slack)
      if (copValid && copY >= copYMin - 0.01 && copY <= copYMax + 0.01) {
        copYSeries[i] = copY;
      }

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
      rawLoaded,
    });
  }
  return { t, rateHz, fingers, quantumN, hasLayout: layout !== null };
}

/**
 * Build a TactileSeries from the 30 Hz main-table sensor frames: the drift
 * correction, then the series. This is the whole instrument pipeline; the
 * interpretation layer inserts its own passes between the two stages.
 */
export function buildSeriesFromSensorFrames(
  frames: unknown[],
  timestamps: number[],
  layout: [number, number, number][] | null,
  gripper: GripperSeries | null | undefined,
  opts: BaselineOptions,
): TactileSeries | null {
  const corrected = applyAdaptiveBaseline(frames, timestamps, gripper, opts);
  return buildSeriesFromCorrectedFrames(frames, corrected, timestamps, layout);
}

/** Duplicate-row handling of the raw sidecar stream. */
export interface RawCsvOptions {
  /** CP5 of analysis/duplicate-investigation.md: the sidecar rows are a
   * fixed 90.88 Hz LOGGER loop over a latest-frame buffer while the
   * device tops out at ~83 Hz (Paxini manual; Zheng's catch) — 10-30%
   * of rows are byte-identical re-reads. This drops a time sample only
   * when EVERY finger's frame equals its predecessor (per-finger dedup
   * would desync the shared time base). Default OFF: every threshold is
   * calibrated on the logger-rate stream.
   * CAUTION (CP5 finding): this COMPRESSES real time — held stretches
   * collapse — and scrambles time-based rules. Superseded by
   * deviceGridHz for axis-honest work; kept as the CP5 probe. */
  dedupFrames?: boolean;
  /** Zheng's beat-model correction (step 2 of his plan): assume the
   * device emits on a REGULAR grid (83.33 Hz = 12 ms) under the ~91 Hz
   * poller, so ~8.3% of rows are beat re-reads. Partition time into
   * 1/deviceGridHz slots from the first sample, keep the FIRST row of
   * each slot, stamp it at the slot boundary — beat re-reads drop,
   * real time is PRESERVED on a uniform device-rate axis. */
  deviceGridHz?: number;
}

/**
 * Parse raw sidecar CSV texts (91 Hz, company 163-column schema; one CSV
 * per finger, in finger order) into nested frames on the logger's time
 * axis, after the optional duplicate-row handling.
 */
export function parseRawCsvs(
  csvTexts: string[],
  opts: RawCsvOptions = {},
): { frames: number[][][][]; timestamps: number[] } | null {
  const parsed = csvTexts.map(parseRawCsv).filter((p) => p !== null) as Array<{
    t: Float64Array;
    taxels: Float64Array; // [n][nTaxels*3] flattened
    nTaxels: number;
  }>;
  if (!parsed.length) return null;
  let n = Math.min(...parsed.map((p) => p.t.length));
  if (opts?.deviceGridHz && opts.deviceGridHz > 0) {
    const T = 1 / opts.deviceGridHz;
    const t0 = parsed[0].t[0];
    const keep: number[] = [];
    const slotT: number[] = [];
    let lastSlot = -1;
    for (let i = 0; i < n; i++) {
      const slot = Math.floor((parsed[0].t[i] - t0) / T);
      if (slot !== lastSlot) {
        keep.push(i);
        slotT.push(t0 + slot * T);
        lastSlot = slot;
      }
    }
    if (keep.length < n) {
      for (const p of parsed) {
        const w = p.nTaxels * 3;
        const t2 = new Float64Array(keep.length);
        const x2 = new Float64Array(keep.length * w);
        keep.forEach((src, dst) => {
          t2[dst] = slotT[dst];
          x2.set(p.taxels.subarray(src * w, (src + 1) * w), dst * w);
        });
        p.t = t2;
        p.taxels = x2;
      }
      n = keep.length;
    }
  } else if (opts?.dedupFrames) {
    const keep: number[] = [0];
    for (let i = 1; i < n; i++) {
      let fresh = false;
      for (const p of parsed) {
        const w = p.nTaxels * 3;
        for (let k = 0; k < w; k++) {
          if (p.taxels[i * w + k] !== p.taxels[(i - 1) * w + k]) {
            fresh = true;
            break;
          }
        }
        if (fresh) break;
      }
      if (fresh) keep.push(i);
    }
    if (keep.length < n) {
      for (const p of parsed) {
        const w = p.nTaxels * 3;
        const t2 = new Float64Array(keep.length);
        const x2 = new Float64Array(keep.length * w);
        keep.forEach((src, dst) => {
          t2[dst] = p.t[src];
          x2.set(p.taxels.subarray(src * w, (src + 1) * w), dst * w);
        });
        p.t = t2;
        p.taxels = x2;
      }
      n = keep.length;
    }
  }
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
  return { frames, timestamps: Array.from(base.t.subarray(0, n)) };
}

/**
 * Build from raw sidecar CSV text (91 Hz, company 163-column schema).
 * One CSV per finger; pass texts in finger order.
 */
export function buildSeriesFromRawCsvs(
  csvTexts: string[],
  layout: [number, number, number][] | null,
  gripper: GripperSeries | null | undefined,
  opts: BaselineOptions & RawCsvOptions,
): TactileSeries | null {
  const parsed = parseRawCsvs(csvTexts, opts);
  if (!parsed) return null;
  return buildSeriesFromSensorFrames(
    parsed.frames as unknown as unknown[],
    parsed.timestamps,
    layout,
    gripper,
    opts,
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
    quantumN: s.quantumN,
    hasLayout: s.hasLayout,
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
      rawLoaded: f.rawLoaded?.slice(0, n),
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

// ---------------------------------------------------------------- clock map

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
