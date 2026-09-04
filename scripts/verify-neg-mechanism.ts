// Mechanism verification probe (Zheng's ruling: verify first, then decide).
// Claim under test: at ep47 ~16 s the DISPLAY-path correction
// (applyAdaptiveBaseline on the 30 Hz table frames) drives f0's taxels
// NEGATIVE, and |corrected F| exceeds |raw F|, which is why the corrected
// view drew arrows on an empty pad while raw drew nothing.
// Run: bun scripts/verify-neg-mechanism.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { applyAdaptiveBaseline } from "../visualizer/src/lib/eventDetection";
import { loadEpisodeInputs, loadEpisodesMeta, type Info } from "./run-detector";
import { SOTAC_PROFILE } from "../visualizer/src/lib/rigProfile";

const root = "data/sotac";
const info = JSON.parse(
  readFileSync(join(root, "meta", "info.json"), "utf-8"),
) as Info;
const metas = await loadEpisodesMeta(root);
const meta = metas.find((m) => m.episode_index === 47);
if (!meta) throw new Error("ep47 meta missing");
const inputs = await loadEpisodeInputs(root, info, meta);
const frames = inputs.frames as number[][][][];
const ts = inputs.timestamps;
const corr = applyAdaptiveBaseline(
  frames as unknown[],
  ts,
  inputs.gripper, { profile: SOTAC_PROFILE }) as number[][][][] | null;
if (!corr) throw new Error("applyAdaptiveBaseline returned null");

function stats(fr: number[][][], f: number) {
  let sum = 0;
  let neg = 0;
  let negMass = 0;
  let min = Infinity;
  let maxAbs = 0;
  for (const p of fr[f]) {
    const fz = p[2];
    sum += fz;
    if (fz < 0) {
      neg++;
      negMass += -fz;
    }
    if (fz < min) min = fz;
    const m = Math.hypot(p[0], p[1], p[2]);
    if (m > maxAbs) maxAbs = m;
  }
  return { sum, neg, negMass, min, maxAbs };
}

console.log(
  "t        fg | RAW  sumFz  min   max|F| | CORR sumFz  min    negTx negMass max|F|",
);
for (const tq of [2.0, 4.2, 10.3, 15.0, 16.0, 16.5, 17.0]) {
  let i = 0;
  for (let k = 0; k < ts.length; k++) {
    if (Math.abs(ts[k] - tq) < Math.abs(ts[i] - tq)) i = k;
  }
  for (const f of [0, 1]) {
    const r = stats(frames[i], f);
    const c = stats(corr[i], f);
    console.log(
      `${ts[i].toFixed(2).padStart(6)} f${f} | ` +
        `${r.sum.toFixed(2).padStart(7)} ${r.min.toFixed(2).padStart(5)} ` +
        `${r.maxAbs.toFixed(2).padStart(6)} | ` +
        `${c.sum.toFixed(2).padStart(7)} ${c.min.toFixed(2).padStart(6)} ` +
        `${String(c.neg).padStart(5)} ${c.negMass.toFixed(2).padStart(7)} ` +
        `${c.maxAbs.toFixed(2).padStart(6)}`,
    );
  }
}
