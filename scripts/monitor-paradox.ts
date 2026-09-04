// Corpus-wide paradox monitor (Zheng's order, 2026-09-02): verify on EVERY
// episode that the deduct-exceeds-raw paradox is cleanly resolved on the
// display path (applyAdaptiveBaseline over the 30 Hz table frames).
// Violations checked per frame, per finger:
//   NEG   any output component fz < 0 (impossible-by-construction check)
//   FAB   raw frame all-zero but corrected shows any nonzero (fabrication)
//   EXC   corrected sum fz exceeds raw sum fz (deduction added force)
// Run: bun scripts/monitor-paradox.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { applyAdaptiveBaseline } from "../visualizer/src/lib/eventDetection";
import { loadEpisodeInputs, loadEpisodesMeta, type Info } from "./run-detector";

const root = "data/sotac";
const info = JSON.parse(
  readFileSync(join(root, "meta", "info.json"), "utf-8"),
) as Info;
const metas = await loadEpisodesMeta(root);

let epsChecked = 0;
let framesChecked = 0;
let totNeg = 0;
let totFab = 0;
let totExc = 0;
const badRows: string[] = [];

for (const meta of metas) {
  const ep = meta.episode_index;
  const inputs = await loadEpisodeInputs(root, info, meta);
  const frames = inputs.frames as number[][][][];
  const ts = inputs.timestamps;
  const corr = applyAdaptiveBaseline(
    frames as unknown[],
    ts,
    inputs.gripper,
  ) as number[][][][] | null;
  if (!corr) {
    badRows.push(`ep${ep}: correction returned null`);
    continue;
  }
  epsChecked++;
  const nFingers = frames[0]?.length ?? 0;
  for (let f = 0; f < nFingers; f++) {
    let neg = 0;
    let fab = 0;
    let exc = 0;
    let worstExc = 0;
    for (let i = 0; i < corr.length; i++) {
      framesChecked++;
      const rawTx = frames[i]?.[f] ?? [];
      const corTx = corr[i]?.[f] ?? [];
      let rawAllZero = true;
      let rawSum = 0;
      let corSum = 0;
      let corAny = false;
      for (let k = 0; k < corTx.length; k++) {
        const rp = rawTx[k] ?? [0, 0, 0];
        const cp = corTx[k] ?? [0, 0, 0];
        if (cp[2] < 0) neg++;
        if (rp[0] !== 0 || rp[1] !== 0 || rp[2] !== 0) rawAllZero = false;
        if (cp[0] !== 0 || cp[1] !== 0 || cp[2] !== 0) corAny = true;
        rawSum += rp[2];
        corSum += cp[2];
      }
      if (rawAllZero && corAny) fab++;
      if (corSum > rawSum + 1e-9) {
        exc++;
        if (corSum - rawSum > worstExc) worstExc = corSum - rawSum;
      }
    }
    totNeg += neg;
    totFab += fab;
    totExc += exc;
    if (neg || fab || exc) {
      badRows.push(
        `ep${ep} f${f}: NEG ${neg}  FAB ${fab}  EXC ${exc} (worst +${worstExc.toFixed(3)}N)`,
      );
    }
  }
}

console.log(
  `checked ${epsChecked} episodes, ${framesChecked} finger-frames`,
);
console.log(
  `violations: negative outputs ${totNeg}, fabricated frames ${totFab}, ` +
    `corrected-exceeds-raw frames ${totExc}`,
);
if (badRows.length) {
  console.log("\nper-finger violations:");
  for (const r of badRows) console.log("  " + r);
} else {
  console.log("CLEAN: paradox resolved on every episode, both fingers.");
}
