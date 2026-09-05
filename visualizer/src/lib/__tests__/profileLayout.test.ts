import { describe, expect, test } from "bun:test";

import { buildSeriesFromSensorFrames, detectEvents } from "../eventDetection";
import {
  layoutFor,
  profileFromFile,
  SOTAC_PROFILE,
  templateProfileFile,
} from "../rigProfile";
import { TAXEL_LAYOUTS } from "../taxel-layouts";

// B2 of Jingyi's PR B list: "the per dataset profile should be able to
// supply a layout the same way it supplies thresholds".

const FOUR: [number, number, number][] = [
  [-1, 0, 0],
  [1, 0, 0],
  [-1, 5, 0],
  [1, 5, 0],
];

function fileWith(layouts: unknown) {
  return { ...templateProfileFile(), id: "four-taxel-rig", layouts };
}

describe("profile-supplied taxel layout", () => {
  test("a layout keyed by its taxel count is used before the built-in tables", () => {
    const p = profileFromFile(
      fileWith({ "4": { model: "toy pad", points: FOUR } }),
    );
    expect(p).not.toBeNull();
    expect(layoutFor(p, 4)?.points).toEqual(FOUR);
    expect(layoutFor(p, 4)?.model).toBe("toy pad");
    // counts the profile does not cover still resolve through the tables
    expect(layoutFor(p, 52)).toBe(TAXEL_LAYOUTS[52]);
    // sotac supplies none: the tables, and nothing for an unknown count
    expect(layoutFor(SOTAC_PROFILE, 52)).toBe(TAXEL_LAYOUTS[52]);
    expect(layoutFor(SOTAC_PROFILE, 4)).toBeNull();
    expect(layoutFor(null, 52)).toBe(TAXEL_LAYOUTS[52]);
  });

  test("a malformed layout rejects the whole file, never half-applies", () => {
    expect(
      profileFromFile(fileWith({ "4": { points: FOUR.slice(0, 3) } })),
    ).toBeNull();
    expect(
      profileFromFile(
        fileWith({ "4": { points: [[0, 0, "z"], ...FOUR.slice(1)] } }),
      ),
    ).toBeNull();
    expect(profileFromFile(fileWith({ four: { points: FOUR } }))).toBeNull();
    expect(profileFromFile(fileWith([FOUR]))).toBeNull();
    expect(profileFromFile(fileWith({}))!.layouts).toBeUndefined();
  });

  test("with the profile's layout the detector has geometry: no no_layout, CoP measured", () => {
    const p = profileFromFile(fileWith({ "4": { points: FOUR } }))!;
    const frames: unknown[] = [];
    const ts: number[] = [];
    for (let i = 0; i < 90; i++) {
      const on = i >= 30 && i < 75;
      frames.push([
        [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, on ? 2 : 0],
          [0, 0, on ? 2 : 0],
        ],
      ]);
      ts.push(i / 30);
    }
    const withLayout = buildSeriesFromSensorFrames(
      frames,
      ts,
      layoutFor(p, 4)!.points,
      null,
      p,
    )!;
    expect(withLayout.hasLayout).toBe(true);
    expect(withLayout.fingers[0].copY![50]).toBeCloseTo(5, 6);
    expect(
      detectEvents(withLayout, null, {}, null, { profile: p }).flags,
    ).not.toContain("no_layout");
    const without = buildSeriesFromSensorFrames(frames, ts, null, null, p)!;
    expect(
      detectEvents(without, null, {}, null, { profile: p }).flags,
    ).toContain("no_layout");
  });
});
