import { describe, expect, test } from "bun:test";

import {
  applyAdaptiveBaseline,
  buildSeriesFromSensorFrames,
  detectEvents,
  type AutoLabelResult,
  type EventLabel,
  type GripperSeries,
} from "../eventDetection";
import { activeProfileFor } from "../interpretationOptIn";
import {
  profileFromFile,
  SOTAC_PROFILE,
  TEMPLATE_PROFILE,
  templateProfileFile,
} from "../rigProfile";

// B3 of Jingyi's PR B list: the interpretation layer runs only for datasets
// that opted in ("behind a per dataset opt in and out of the default save
// path"). Without the opt-in the detector is in BASE MODE.

/** Jingyi's Table VIII taxonomy — everything base mode may emit. */
const BASE_LABELS = new Set<EventLabel>([
  "contact_onset",
  "grasp_stable",
  "lift",
  "incipient_slip",
  "slip",
  "rotation",
  "place",
  "release",
  "drop",
]);
const INTERPRETATION_FLAGS =
  /^(hesitation|sustained_slide|residual_suspect|failed_attempt|weak_contact|air_grasp|post_task_contact|short_transport)/;

const RATE = 30;
const Q = 0.2;

// An episode the interpretation layer has something to say about: the jaw
// closes 20 units and reopens with no contact at 2.5-4.0 s (an air-miss
// attempt, jaw-only), then the real grasp holds 12 taxels at one quantum
// from 5.5 to 8 s, and after the release taxel #1 stays stuck at one
// quantum with 3-frame bursts every 0.5 s (the residual class).
function frames(): { frames: unknown[]; ts: number[]; gripper: GripperSeries } {
  const n = 12 * RATE;
  const out: unknown[] = [];
  const ts: number[] = [];
  const gripper: GripperSeries = { t: [], pos: [] };
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const row: number[][] = Array.from({ length: 16 }, () => [0, 0, 0]);
    if (t >= 5.5 && t < 8) for (let k = 0; k < 12; k++) row[k][2] = Q;
    if (t >= 8) {
      row[1][2] = Q;
      if ((t - 8) % 0.5 < 3 / RATE) for (let k = 0; k < 9; k++) row[k][2] = Q;
    }
    out.push([row, Array.from({ length: 16 }, () => [0, 0, 0])]);
    ts.push(t);
    let p = 40;
    if (t >= 2.5 && t < 3) p = 40 - 40 * (t - 2.5);
    else if (t >= 3 && t < 3.5) p = 20;
    else if (t >= 3.5 && t < 4) p = 20 + 40 * (t - 3.5);
    else if (t >= 5 && t < 5.5) p = 40 - 60 * (t - 5);
    else if (t >= 5.5 && t < 7.9) p = 10;
    else if (t >= 7.9 && t < 8.4) p = 10 + 70 * (t - 7.9);
    else if (t >= 8.4) p = 45;
    gripper.t.push(t);
    gripper.pos.push(p);
  }
  return { frames: out, ts, gripper };
}

function run(profile: typeof SOTAC_PROFILE): AutoLabelResult {
  const { frames: fr, ts, gripper } = frames();
  const series = buildSeriesFromSensorFrames(fr, ts, null, gripper, profile)!;
  return detectEvents(series, gripper, {}, null, { profile });
}

const BASE = { ...SOTAC_PROFILE, interpretation: false };

describe("base mode (no per-dataset opt-in)", () => {
  test("the opted-in run produces an attempt span the base run must not", () => {
    const full = run(SOTAC_PROFILE);
    expect(full.flags).not.toContain("base_mode");
    expect(full.spans.some((s) => s.kind === "failed_attempt")).toBe(true);
    expect(full.flags.some((f) => f.startsWith("failed_attempt@"))).toBe(true);
    const base = run(BASE);
    expect(base.flags).toContain("base_mode");
    expect(base.spans).toEqual([]);
    for (const f of base.flags)
      expect(INTERPRETATION_FLAGS.test(f)).toBe(false);
    for (const e of base.events) expect(BASE_LABELS.has(e.label)).toBe(true);
    // the base taxonomy itself is the same in both modes on this episode
    const key = (r: AutoLabelResult) =>
      r.events.map((e) => `${e.label}@${e.startS.toFixed(2)}`).join(",");
    expect(key(base)).toBe(key(full));
  });

  test("the residual gate follows the opt-in; an explicit switch wins either way", () => {
    const { frames: fr, ts, gripper } = frames();
    const sumAt = (c: number[][][][], t: number) =>
      c[Math.round(t * RATE)][0].reduce((a, tx) => a + tx[2], 0);
    // 8.55 s sits inside a post-release burst
    const full = applyAdaptiveBaseline(fr, ts, gripper, {
      profile: SOTAC_PROFILE,
    })!;
    const base = applyAdaptiveBaseline(fr, ts, gripper, { profile: BASE })!;
    expect(sumAt(full, 8.55)).toBe(0);
    expect(sumAt(base, 8.55)).toBeGreaterThan(0);
    const forcedOn = applyAdaptiveBaseline(fr, ts, gripper, {
      profile: BASE,
      residualGate: true,
    })!;
    const forcedOff = applyAdaptiveBaseline(fr, ts, gripper, {
      profile: SOTAC_PROFILE,
      residualGate: false,
    })!;
    expect(sumAt(forcedOn, 8.55)).toBe(0);
    expect(sumAt(forcedOff, 8.55)).toBeGreaterThan(0);
  });

  test("no_screen_reference is a full-mode concern only", () => {
    // the sotac registry profile names a corpus that is not attached here
    expect(run(SOTAC_PROFILE).flags).toContain("no_screen_reference");
    expect(run(BASE).flags).not.toContain("no_screen_reference");
  });

  test("the profile file carries the opt-in; absent means base mode; the template does not opt in", () => {
    const file = templateProfileFile();
    expect(profileFromFile(file)!.interpretation).toBe(false);
    expect(
      profileFromFile({ ...file, interpretation: true })!.interpretation,
    ).toBe(true);
    const { interpretation: _i, ...withoutKey } = file;
    void _i;
    expect(profileFromFile(withoutKey)!.interpretation).toBe(false);
    expect(TEMPLATE_PROFILE.interpretation).toBe(false);
    expect(SOTAC_PROFILE.interpretation).toBe(true);
  });

  test("the session opt-in copies the profile rather than editing it", () => {
    const p = activeProfileFor(BASE, true)!;
    expect(p.interpretation).toBe(true);
    expect(BASE.interpretation).toBe(false);
    expect(activeProfileFor(BASE, false)).toBe(BASE);
    expect(activeProfileFor(SOTAC_PROFILE, true)).toBe(SOTAC_PROFILE);
    expect(activeProfileFor(null, true)).toBeNull();
  });
});
