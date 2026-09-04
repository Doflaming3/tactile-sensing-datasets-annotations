import { describe, expect, test } from "bun:test";

import { buildSeriesFromSensorFrames, detectEvents } from "../eventDetection";
import { SOTAC_PROFILE, TEMPLATE_PROFILE } from "../rigProfile";

// A dataset without a taxel layout, a gripper channel or arm joints must
// still run — and SAY what it could not do, instead of degrading silently
// (Jingyi's PR #1 review: no_layout / no_gripper / no_arm).
const RATE = 30;
function frames(durS: number): { frames: unknown[]; ts: number[] } {
  const out: unknown[] = [];
  const ts: number[] = [];
  for (let i = 0; i < Math.round(durS * RATE); i++) {
    const t = i / RATE;
    const row: number[][] = Array.from({ length: 16 }, () => [0, 0, 0]);
    if (t >= 2 && t < 5) for (let k = 0; k < 12; k++) row[k][2] = 0.2;
    const idle: number[][] = Array.from({ length: 16 }, () => [0, 0, 0]);
    out.push([row, idle]);
    ts.push(t);
  }
  return { frames: out, ts };
}

describe("capability flags", () => {
  test("no layout, no gripper, no arm: runs and flags all three", () => {
    const { frames: fr, ts } = frames(8);
    const series = buildSeriesFromSensorFrames(
      fr,
      ts,
      null,
      null,
      SOTAC_PROFILE,
    );
    expect(series).not.toBeNull();
    const res = detectEvents(series!, null, {}, null, {
      profile: SOTAC_PROFILE,
    });
    expect(res.flags).toContain("no_layout");
    expect(res.flags).toContain("no_gripper");
    expect(res.flags).toContain("no_arm");
  });

  test("with a gripper the gripper flag is absent", () => {
    const { frames: fr, ts } = frames(8);
    const gripper = {
      t: ts,
      pos: ts.map((t) => (t < 1.5 ? 40 : t < 5 ? 10 : 45)),
    };
    const series = buildSeriesFromSensorFrames(
      fr,
      ts,
      null,
      gripper,
      SOTAC_PROFILE,
    );
    const res = detectEvents(series!, gripper, {}, null, {
      profile: SOTAC_PROFILE,
    });
    expect(res.flags).not.toContain("no_gripper");
    expect(res.flags).toContain("no_arm");
  });

  test("the template profile marks every result profile_unverified", () => {
    const { frames: fr, ts } = frames(8);
    const series = buildSeriesFromSensorFrames(
      fr,
      ts,
      null,
      null,
      TEMPLATE_PROFILE,
    );
    const res = detectEvents(series!, null, {}, null, {
      profile: TEMPLATE_PROFILE,
    });
    expect(res.flags).toContain("profile_unverified");
    const ok = detectEvents(series!, null, {}, null, {
      profile: SOTAC_PROFILE,
    });
    expect(ok.flags).not.toContain("profile_unverified");
  });
});
