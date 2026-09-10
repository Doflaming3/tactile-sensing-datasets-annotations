import { describe, expect, test } from "bun:test";

import {
  commandSeriesFrom,
  DEFAULT_TRIM_PARAMS,
  firstMotion,
  jointSpeed,
  lastMotion,
  proposeTrim,
} from "../trimDetect";

const FPS = 30;

/** A recording: still for `before` frames, the arm moves for `moving`
 * frames (1 deg/frame on one joint), still for `after` frames. The
 * commanded joints lead the measured ones by `lag` frames. */
function recording(
  before: number,
  moving: number,
  after: number,
  lag = 3,
): {
  measured: { t: number[]; joints: number[][] };
  commanded: { t: number[]; joints: number[][] };
} {
  const n = before + moving + after;
  const pose = (i: number, start: number) => {
    const k = Math.min(Math.max(i - start, 0), moving);
    return [10 + k, 20, 30, 40, 50];
  };
  const t = Array.from({ length: n }, (_, i) => i / FPS);
  return {
    measured: { t, joints: t.map((_, i) => pose(i, before)) },
    commanded: { t, joints: t.map((_, i) => pose(i, before - lag)) },
  };
}

describe("trim detector", () => {
  test("speed and motion runs", () => {
    const joints = [
      [0, 0],
      [0, 0],
      [0.1, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 0],
      [3, 0.05],
    ];
    const sp = jointSpeed(joints);
    expect(sp).toEqual([0, 0, 0.1, 0.9, 1, 1, 0, 0.05]);
    expect(firstMotion(sp, 0.5, 2)).toBe(3);
    expect(firstMotion(sp, 0.5, 4)).toBeNull();
    expect(lastMotion(sp, 0.5, 1)).toBe(5);
    expect(lastMotion(sp, 0.5, 2)).toBe(5);
    expect(firstMotion(sp, 5, 1)).toBeNull();
  });

  test("proposes the motion envelope with her margins", () => {
    const { measured, commanded } = recording(90, 200, 60);
    const p = proposeTrim(measured, commanded, FPS)!;
    // the commanded joints first differ from the frame before at frame 88
    // (they start at 87, lag 3); lead 12 frames
    expect(p.onsetFrame).toBe(88);
    expect(p.startFrame).toBe(88 - Math.round(DEFAULT_TRIM_PARAMS.leadS * FPS));
    // the measured joints last change at frame 290; tail 16 frames
    expect(p.motionEndFrame).toBe(290);
    expect(p.endFrame).toBe(290 + Math.round(DEFAULT_TRIM_PARAMS.tailS * FPS));
    expect(p.endS).toBeCloseTo((p.endFrame + 1) / FPS, 6);
    expect(p.flags).toEqual([]);
    expect(p.nFrames).toBe(350);
  });

  test("flags an arm already moving at the start and motion to the end", () => {
    const { measured, commanded } = recording(2, 100, 0);
    const p = proposeTrim(measured, commanded, FPS)!;
    expect(p.startFrame).toBe(0);
    expect(p.flags).toContain("arm_moving_at_start");
    expect(p.flags).toContain("motion_to_recording_end");
    expect(p.endFrame).toBe(101);
  });

  test("no motion keeps everything and says so; measured only works", () => {
    const still = recording(0, 0, 50);
    const p = proposeTrim(still.measured, still.commanded, FPS)!;
    expect([p.startFrame, p.endFrame]).toEqual([0, 49]);
    expect(p.flags).toContain("no_motion");
    const { measured } = recording(60, 100, 60);
    const q = proposeTrim(measured, null, FPS)!;
    expect(q.flags).toContain("no_command_signal");
    expect(q.onsetFrame).toBe(61);
    expect(proposeTrim(null, null, FPS)).toBeNull();
    const r = proposeTrim(measured, null, FPS, DEFAULT_TRIM_PARAMS, {
      totalFrames: 500,
    })!;
    expect(r.flags).toContain("sampled_rows");
  });

  test("commandSeriesFrom reads the action columns without the gripper", () => {
    const rows = [
      {
        timestamp: 0,
        "action | shoulder_pan.pos": 1,
        "action | gripper.pos": 9,
        "observation.state | shoulder_pan.pos": 0,
      },
      {
        timestamp: 1 / FPS,
        "action | shoulder_pan.pos": 2,
        "action | gripper.pos": 9,
        "observation.state | shoulder_pan.pos": 1,
      },
      {
        timestamp: 2 / FPS,
        "action | shoulder_pan.pos": 3,
        "action | gripper.pos": 9,
        "observation.state | shoulder_pan.pos": 2,
      },
      {
        timestamp: 3 / FPS,
        "action | shoulder_pan.pos": 4,
        "action | gripper.pos": 9,
        "observation.state | shoulder_pan.pos": 3,
      },
    ];
    const s = commandSeriesFrom(rows)!;
    expect(s.joints.map((j) => j.length)).toEqual([1, 1, 1, 1]);
    expect(s.joints.map((j) => j[0])).toEqual([1, 2, 3, 4]);
    expect(commandSeriesFrom([{ timestamp: 0, x: 1 }])).toBeNull();
    expect(commandSeriesFrom(undefined)).toBeNull();
  });
});
