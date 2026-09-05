import { describe, expect, test } from "bun:test";

import {
  noProfileMessage,
  profileById,
  profileForDataset,
  SOTAC_PROFILE,
  SOTAC_SCREEN_REFERENCE_PATH,
} from "../rigProfile";

describe("rig profile registry", () => {
  test("sotac and sotac_raw resolve to the sotac profile, pinned or not", () => {
    expect(profileForDataset("Jingyi-Z/sotac")?.id).toBe(SOTAC_PROFILE.id);
    expect(profileForDataset("Jingyi-Z/sotac@47d46cfb")?.id).toBe(
      SOTAC_PROFILE.id,
    );
    expect(profileForDataset("Jingyi-Z/sotac_raw")?.id).toBe(SOTAC_PROFILE.id);
  });

  test("an unknown dataset gets NO profile — never sotac's numbers by default", () => {
    expect(profileForDataset("someone/other-rig")).toBeNull();
    expect(profileForDataset(null)).toBeNull();
    expect(noProfileMessage("someone/other-rig@main")).toContain(
      "someone/other-rig",
    );
  });

  test("an explicit override applies a known profile to any dataset", () => {
    expect(profileForDataset("someone/same-rig", SOTAC_PROFILE.id)?.id).toBe(
      SOTAC_PROFILE.id,
    );
    expect(profileForDataset("someone/same-rig", "no-such-profile")).toBeNull();
    expect(profileById(undefined)).toBeNull();
  });

  test("the sotac profile carries the audited numbers", () => {
    const c = SOTAC_PROFILE.calibration;
    expect(c.weakAttemptMaxN).toBe(2.3);
    expect(c.handLossN).toBe(1.0);
    expect(c.jawRetryRiseU).toBe(5.0);
    expect(c.hesitationP90S).toEqual([6.32, 2.2, 4.56, 1.26]);
    // the corpus is not embedded: the profile names it by path (B1)
    expect(c.screenReference).toBeNull();
    expect(SOTAC_PROFILE.screenReferencePath).toBe(SOTAC_SCREEN_REFERENCE_PATH);
  });
});
