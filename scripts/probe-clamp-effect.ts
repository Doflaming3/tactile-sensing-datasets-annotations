// Probe for Zheng's two questions (2026-09-02): (1) why did source-clamping
// move ep24's grasp anchor; (2) does the clamped correction fail to remove
// noise/phantoms when the gripper is EMPTY? Run once on the clamped working
// tree and once with the clamp stashed; compare.
// Run: bun scripts/probe-clamp-effect.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildSeriesFromRawCsvs,
  clipSeries,
} from "../visualizer/src/lib/eventDetection";
import { resolveTaxelLayout } from "../visualizer/src/lib/taxel-layouts";
import {
  loadEpisodeInputs,
  loadEpisodesMeta,
  loadRawCsvTexts,
  type Info,
} from "./run-detector";
import { SOTAC_PROFILE } from "../visualizer/src/lib/rigProfile";

const root = "data/sotac";
const info = JSON.parse(
  readFileSync(join(root, "meta", "info.json"), "utf-8"),
) as Info;
const metas = await loadEpisodesMeta(root);

async function series(ep: number) {
  const meta = metas.find((m) => m.episode_index === ep);
  if (!meta) throw new Error(`ep${ep} missing`);
  const inputs = await loadEpisodeInputs(root, info, meta);
  const layout = resolveTaxelLayout(inputs.nTaxels)?.points ?? null;
  const texts = loadRawCsvTexts(root, ep, inputs.sensorName);
  if (!texts) throw new Error("no raw csvs");
  const raw = buildSeriesFromRawCsvs(texts, layout, inputs.gripper, { profile: SOTAC_PROFILE });
  if (!raw) throw new Error("no series");
  const tEnd = inputs.timestamps.length
    ? inputs.timestamps[inputs.timestamps.length - 1] + 0.1
    : raw.t[raw.t.length - 1];
  return clipSeries(raw, tEnd);
}

// (1) ep24 f1: the fumble-to-regrasp gap 5.30-6.20 s. Contact exit needs
// fn < 0.10 sustained; report the gap's fn profile.
{
  const s = await series(24);
  const f = s.fingers[1];
  let above = 0;
  let total = 0;
  let minFn = Infinity;
  let meanFn = 0;
  for (let i = 0; i < s.t.length; i++) {
    if (s.t[i] < 5.3 || s.t[i] > 6.2) continue;
    total++;
    meanFn += f.fn[i];
    if (f.fn[i] >= 0.1) above++;
    if (f.fn[i] < minFn) minFn = f.fn[i];
  }
  console.log(
    `ep24 f1 gap 5.30-6.20s: frames ${total}, fn>=0.10 on ${above} ` +
      `(${((100 * above) / Math.max(total, 1)).toFixed(0)}%), ` +
      `min fn ${minFn.toFixed(3)}N, mean fn ${(meanFn / Math.max(total, 1)).toFixed(3)}N`,
  );
}

// (2) empty-gripper bias: mean fn during the pre-contact approach, where
// the true force is exactly zero. Any positive mean is manufactured.
for (const [ep, fi, a, b] of [
  [24, 1, 1.0, 4.0],
  [43, 0, 0.3, 1.5],
  [47, 1, 0.3, 3.5],
  [13, 1, 1.0, 3.5],
] as Array<[number, number, number, number]>) {
  const s = await series(ep);
  const f = s.fingers[fi];
  let mean = 0;
  let n = 0;
  let above = 0;
  for (let i = 0; i < s.t.length; i++) {
    if (s.t[i] < a || s.t[i] > b) continue;
    mean += f.fn[i];
    n++;
    if (f.fn[i] >= 0.1) above++;
  }
  console.log(
    `ep${ep} f${fi} empty-hand ${a}-${b}s: mean fn ${(mean / Math.max(n, 1)).toFixed(3)}N, ` +
      `fn>=0.10 on ${((100 * above) / Math.max(n, 1)).toFixed(0)}% of frames`,
  );
}
