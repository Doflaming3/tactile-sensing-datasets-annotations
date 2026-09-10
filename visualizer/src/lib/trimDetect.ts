// Trim cut points from the trajectory signals (Jingyi's trim ask, cycle 2).
//
// Her own cuts, read off the raw recordings (analysis/trim-census.md), are
// the arm's motion envelope with fixed margins: the start sits ~0.4-0.5 s
// before the COMMANDED joints (action) first move, the end ~0.53 s after
// the MEASURED joints (observation.state) last move. The jaw and the
// tactile load play no part — they move later than the arm at the start
// and stop earlier at the end. This module proposes exactly that; the
// reviewer adjusts on the timeline (trim panel) and the trim page lists
// every episode's proposal.
import type { ArmMotionSeries } from "./eventDetection";

export interface TrimParams {
  /** commanded-joint speed that counts as motion, degrees per frame */
  commandSpeedDegPerFrame: number;
  /** measured-joint speed that counts as motion, degrees per frame */
  measuredSpeedDegPerFrame: number;
  /** frames of motion in a row before the onset counts */
  holdStart: number;
  /** frames of motion in a row before the last motion counts */
  holdEnd: number;
  /** seconds kept before the onset */
  leadS: number;
  /** seconds kept after the last motion */
  tailS: number;
}

/** Fitted to her 100 script-cut episodes (scripts/trim-score.ts): starts
 * within 3 frames of hers in 83 % of them and within 6 in 97 %, ends
 * within 3 in 92 % and within 6 in 97 %. */
export const DEFAULT_TRIM_PARAMS: TrimParams = {
  commandSpeedDegPerFrame: 0.5,
  measuredSpeedDegPerFrame: 0.5,
  holdStart: 8,
  holdEnd: 2,
  leadS: 0.43,
  tailS: 0.53,
};

export interface TrimProposal {
  /** first kept frame (row index) */
  startFrame: number;
  /** last kept frame, inclusive */
  endFrame: number;
  startS: number;
  /** end of the kept window in seconds: the last kept frame plus one
   * frame, so `endS - startS` is the kept duration */
  endS: number;
  /** first frame of commanded motion (or measured, without a command) */
  onsetFrame: number | null;
  /** last frame of measured motion */
  motionEndFrame: number | null;
  nFrames: number;
  fps: number;
  /** what the reviewer should know: arm_moving_at_start, no_motion,
   * motion_to_recording_end, no_command_signal, sampled_rows */
  flags: string[];
}

/** Commanded joints (the `action` columns) with the gripper excluded,
 * the way armSeriesFrom reads the measured ones. */
export function commandSeriesFrom(
  rows: Record<string, number>[] | undefined,
): ArmMotionSeries | null {
  if (!rows || rows.length === 0) return null;
  const keys = Object.keys(rows[0]).filter(
    (k) => /\.pos$/i.test(k) && /^action/i.test(k) && !/gripper/i.test(k),
  );
  if (keys.length === 0) return null;
  const t: number[] = [];
  const joints: number[][] = [];
  for (const r of rows) {
    const ts = r["timestamp"];
    if (typeof ts !== "number") continue;
    const row = keys.map((k) => (typeof r[k] === "number" ? r[k] : NaN));
    if (row.some((v) => Number.isNaN(v))) continue;
    t.push(ts);
    joints.push(row);
  }
  return t.length > 2 ? { t, joints } : null;
}

/** Per-frame speed: the largest joint change between a frame and the one
 * before it (index 0 is 0). */
export function jointSpeed(joints: number[][]): number[] {
  const out = new Array<number>(joints.length).fill(0);
  for (let i = 1; i < joints.length; i++) {
    let m = 0;
    const a = joints[i - 1];
    const b = joints[i];
    for (let j = 0; j < b.length; j++) m = Math.max(m, Math.abs(b[j] - a[j]));
    out[i] = m;
  }
  return out;
}

/** First frame of a run of `hold` frames faster than `thr`, or null. */
export function firstMotion(
  speed: number[],
  thr: number,
  hold: number,
): number | null {
  const h = Math.max(1, hold);
  let run = 0;
  for (let i = 1; i < speed.length; i++) {
    run = speed[i] > thr ? run + 1 : 0;
    if (run >= h) return i - h + 1;
  }
  return null;
}

/** Last frame of a run of `hold` frames faster than `thr`, or null. */
export function lastMotion(
  speed: number[],
  thr: number,
  hold: number,
): number | null {
  const h = Math.max(1, hold);
  let run = 0;
  for (let i = speed.length - 1; i >= 1; i--) {
    run = speed[i] > thr ? run + 1 : 0;
    if (run >= h) return i + h - 1;
  }
  return null;
}

export function proposeTrim(
  measured: ArmMotionSeries | null,
  commanded: ArmMotionSeries | null,
  fps: number,
  params: TrimParams = DEFAULT_TRIM_PARAMS,
  opts: { totalFrames?: number } = {},
): TrimProposal | null {
  const base = measured ?? commanded;
  if (!base || base.joints.length < 3) return null;
  const n = base.joints.length;
  const flags: string[] = [];
  const lead = Math.round(params.leadS * fps);
  const tail = Math.round(params.tailS * fps);

  // start: the commanded joints, or the measured ones without a command
  const onsetSource = commanded ?? measured!;
  if (!commanded) flags.push("no_command_signal");
  const onset = firstMotion(
    jointSpeed(onsetSource.joints),
    commanded
      ? params.commandSpeedDegPerFrame
      : params.measuredSpeedDegPerFrame,
    params.holdStart,
  );
  // end: the measured joints, or the commanded ones without a measurement
  const endSource = measured ?? commanded!;
  const motionEnd = lastMotion(
    jointSpeed(endSource.joints),
    measured ? params.measuredSpeedDegPerFrame : params.commandSpeedDegPerFrame,
    params.holdEnd,
  );

  let startFrame = 0;
  let endFrame = n - 1;
  if (onset === null || motionEnd === null) {
    flags.push("no_motion");
  } else {
    startFrame = Math.max(0, onset - lead);
    endFrame = Math.min(n - 1, motionEnd + tail);
    if (onset <= params.holdStart) flags.push("arm_moving_at_start");
    if (motionEnd + tail > n - 1) flags.push("motion_to_recording_end");
    if (endFrame <= startFrame) {
      flags.push("no_motion");
      startFrame = 0;
      endFrame = n - 1;
    }
  }
  if (opts.totalFrames !== undefined && opts.totalFrames > n)
    flags.push("sampled_rows");

  return {
    startFrame,
    endFrame,
    startS: startFrame / fps,
    endS: (endFrame + 1) / fps,
    onsetFrame: onset,
    motionEndFrame: motionEnd,
    nFrames: n,
    fps,
    flags,
  };
}
