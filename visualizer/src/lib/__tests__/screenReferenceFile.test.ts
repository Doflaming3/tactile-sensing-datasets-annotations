import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildSeriesFromSensorFrames, detectEvents } from "../eventDetection";
import {
  SOTAC_PROFILE,
  SOTAC_SCREEN_REFERENCE_PATH,
  withScreenReference,
} from "../rigProfile";
import { SCREEN_DIMS, type ScreenReference } from "../signalScreen";

// B1 of Jingyi's PR B list: "move the corpus out of src and load it from the
// per dataset profile". The profile names the file; the resolvers attach it.

function loadShipped(): ScreenReference {
  return JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "public",
        SOTAC_SCREEN_REFERENCE_PATH.slice(1),
      ),
      "utf-8",
    ),
  ) as ScreenReference;
}

describe("reference corpus by path", () => {
  test("the shipped corpus is where the sotac profile says, in the screen's feature space", () => {
    const ref = loadShipped();
    expect(ref.vectors.length).toBeGreaterThan(50);
    expect(ref.scaler.mean.length).toBe(SCREEN_DIMS);
    expect(ref.vectors[0].v.length).toBe(SCREEN_DIMS);
  });

  test("withScreenReference attaches without mutating the profile", () => {
    const ref = loadShipped();
    const p = withScreenReference(SOTAC_PROFILE, ref);
    expect(p.calibration.screenReference).toBe(ref);
    expect(SOTAC_PROFILE.calibration.screenReference).toBeNull();
    expect(p.calibration.weakAttemptMaxN).toBe(
      SOTAC_PROFILE.calibration.weakAttemptMaxN,
    );
  });

  test("a profile that names a corpus it did not get flags no_screen_reference", () => {
    const frames: unknown[] = [];
    const ts: number[] = [];
    for (let i = 0; i < 8; i++) {
      frames.push([[[0, 0, 0]], [[0, 0, 0]]]);
      ts.push(i / 30);
    }
    const series = buildSeriesFromSensorFrames(
      frames,
      ts,
      null,
      null,
      SOTAC_PROFILE,
    );
    const bare = detectEvents(series!, null, {}, null, {
      profile: SOTAC_PROFILE,
    });
    expect(bare.flags).toContain("no_screen_reference");
    const loaded = detectEvents(series!, null, {}, null, {
      profile: withScreenReference(SOTAC_PROFILE, loadShipped()),
    });
    expect(loaded.flags).not.toContain("no_screen_reference");
  });
});
