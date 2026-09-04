import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { TactileSeries } from "../eventDetection";
import {
  SCREEN_DIMS,
  SCREEN_K,
  screenBackgroundVotes,
  terminalWindowFeatures,
  type ScreenReference,
} from "../signalScreen";

/** Synthetic two-finger series at ~91 Hz; finger 0 carries a load step at
 * tStep (0 N before, amp N after) so windows before/after look different. */
function makeSeries(durS = 10, tStep = 5, amp = 4): TactileSeries {
  const rateHz = 91;
  const n = Math.round(durS * rateHz);
  const t = new Float64Array(n);
  const fnRaw = new Float64Array(n);
  const fsRaw = new Float64Array(n);
  const active = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = i / rateHz;
    const loaded = t[i] >= tStep;
    fnRaw[i] = loaded ? amp + 0.05 * Math.sin(i) : 0;
    fsRaw[i] = loaded ? amp / 3 : 0;
    active[i] = loaded ? 10 : 0;
  }
  const zeros = new Float64Array(n);
  const finger = {
    fn: fnRaw,
    fnRaw,
    fs: fsRaw,
    tauZ: zeros,
    slipDiv: zeros,
    edgeRateRatio: zeros,
    hf: zeros,
    fsRaw,
    active,
  };
  return { t, rateHz, fingers: [finger, { ...finger }] };
}

describe("terminalWindowFeatures", () => {
  test("returns the documented dimensionality", () => {
    const v = terminalWindowFeatures(makeSeries(), 0, 5);
    expect(v).not.toBeNull();
    expect(v!.length).toBe(SCREEN_DIMS);
  });

  test("null outside the series and without screen channels", () => {
    const s = makeSeries();
    expect(terminalWindowFeatures(s, 0, 0.1)).toBeNull();
    expect(terminalWindowFeatures(s, 0, 9.99)).toBeNull();
    const bare = {
      ...s,
      fingers: s.fingers.map((f) => ({ ...f, fsRaw: undefined })),
    };
    expect(terminalWindowFeatures(bare, 0, 5)).toBeNull();
  });

  test("pre/post scalars see the load step", () => {
    const v = terminalWindowFeatures(makeSeries(10, 5, 4), 0, 5)!;
    const pre = v[SCREEN_DIMS - 4];
    const post = v[SCREEN_DIMS - 3];
    const delta = v[SCREEN_DIMS - 2];
    expect(post).toBeGreaterThan(pre);
    expect(delta).toBeCloseTo(post - pre, 6);
  });
});

describe("screenBackgroundVotes", () => {
  /** reference: loaded windows labeled "release", flat windows
   * "background" — enough rows to clear the placeholder guard. */
  function makeReference(): ScreenReference {
    const s = makeSeries();
    const vectors: ScreenReference["vectors"] = [];
    for (let i = 0; i < 30; i++) {
      vectors.push({
        ep: 100 + i,
        label: "release",
        v: terminalWindowFeatures(s, 0, 5 + 0.001 * i)!,
      });
      vectors.push({
        ep: 100 + i,
        label: "background",
        v: terminalWindowFeatures(s, 0, 2 + 0.001 * i)!,
      });
    }
    const dims = vectors[0].v.length;
    const mean = new Array<number>(dims).fill(0);
    const std = new Array<number>(dims).fill(1);
    for (const r of vectors) for (let i = 0; i < dims; i++) mean[i] += r.v[i];
    for (let i = 0; i < dims; i++) mean[i] /= vectors.length;
    return { scaler: { mean, std }, vectors };
  }

  test("flat window votes background, event-like window does not", () => {
    const s = makeSeries();
    const ref = makeReference();
    expect(screenBackgroundVotes(s, 0, 2.5, undefined, ref)).toBe(SCREEN_K);
    expect(screenBackgroundVotes(s, 0, 5, undefined, ref)).toBe(0);
  });

  test("episode exclusion drops same-episode rows", () => {
    const s = makeSeries();
    const ref = makeReference();
    // every row shares ep=100..129; excluding one episode still leaves K
    expect(screenBackgroundVotes(s, 0, 2.5, 100, ref)).toBe(SCREEN_K);
  });

  test("placeholder reference disables the screen", () => {
    const empty: ScreenReference = {
      scaler: { mean: [], std: [] },
      vectors: [],
    };
    expect(
      screenBackgroundVotes(makeSeries(), 0, 5, undefined, empty),
    ).toBeNull();
  });
});

describe("reference provenance", () => {
  test("the screen module holds no reference of its own (the profile is the only source)", () => {
    // Jingyi's precondition: never a silent sotac default. The reference
    // reaches the screen only as an argument, from the rig profile.
    const src = readFileSync(join(__dirname, "..", "signalScreen.ts"), "utf-8");
    // the header comment may name the file; an import of it may not
    expect(src).not.toMatch(/import\s[^;]*screen-reference\.json/);
  });
});
