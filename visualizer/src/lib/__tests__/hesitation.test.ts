import { describe, expect, test } from "bun:test";

import { computeHesitation } from "../eventDetection";
import { SOTAC_PROFILE } from "../rigProfile";

const P90 = SOTAC_PROFILE.calibration.hesitationP90S;

// Calibration cases are the real corpus numbers behind the rule
// (2026-08-31 census + Zheng's video verdicts).
describe("computeHesitation", () => {
  test("ep50 (verified hesitation) fires: two solid slow stages", () => {
    expect(computeHesitation([4.47, 2.7, 5.84, 0.12], false, P90)).toBe(true);
  });

  test("ep25 (verified hesitation) fires: place at 2.2x carries strong", () => {
    expect(computeHesitation([8.41, 1.0, 4.58, 2.77], false, P90)).toBe(true);
  });

  test("ep28 (Zheng: 'not that obvious') stays silent: marginal only", () => {
    expect(computeHesitation([4.0, 2.55, 5.25, 1.29], false, P90)).toBe(false);
  });

  test("excused episodes never fire regardless of durations", () => {
    expect(computeHesitation([8.41, 2.7, 5.84, 2.77], true, P90)).toBe(false);
  });

  test("one slow stage is not hesitation", () => {
    const d = P90.map((v, i) => (i === 2 ? v * 2 : v * 0.5));
    expect(computeHesitation(d, false, P90)).toBe(false);
  });

  test("missing stages (failure episodes) are skipped, not counted", () => {
    expect(computeHesitation([8.41, null, null, null], false, P90)).toBe(false);
  });
});
