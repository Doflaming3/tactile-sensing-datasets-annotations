// Option A probe: ep37 f1's contact exit around the true release
// (Zheng: jaw opens 10.3, ball falls 10.8). Hypothesis: the source clamp's
// small positive floor keeps fn above the exit threshold (0.10 N for
// EXIT_MIN 0.3 s) past 10.83, sliding the exit to ~11.38 where the rename
// pass calls it a residual. Run on clamped tree and with clamp stashed.
// Run: bun scripts/probe-ep37-exit.ts

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

const root = "data/sotac";
const info = JSON.parse(
  readFileSync(join(root, "meta", "info.json"), "utf-8"),
) as Info;
const metas = await loadEpisodesMeta(root);
const meta = metas.find((m) => m.episode_index === 37);
if (!meta) throw new Error("ep37 missing");
const inputs = await loadEpisodeInputs(root, info, meta);
const layout = resolveTaxelLayout(inputs.nTaxels)?.points ?? null;
const texts = loadRawCsvTexts(root, 37, inputs.sensorName);
if (!texts) throw new Error("no raw csvs");
const raw = buildSeriesFromRawCsvs(texts, layout, inputs.gripper);
if (!raw) throw new Error("no series");
const tEnd = inputs.timestamps.length
  ? inputs.timestamps[inputs.timestamps.length - 1] + 0.1
  : raw.t[raw.t.length - 1];
const s = clipSeries(raw, tEnd);
const f = s.fingers[1];

console.log("ep37 f1 fn, 10.5-11.6s (exit threshold 0.10 N):");
for (let tc = 10.5; tc <= 11.6; tc += 0.1) {
  let i = 0;
  for (let k = 0; k < s.t.length; k++) {
    if (Math.abs(s.t[k] - tc) < Math.abs(s.t[i] - tc)) i = k;
  }
  console.log(`  t=${s.t[i].toFixed(2)}  fn=${f.fn[i].toFixed(3)}N`);
}

// first sustained exit after 10.7: 0.3 s continuously below 0.10
let exitAt = NaN;
for (let i = 0; i < s.t.length; i++) {
  if (s.t[i] < 10.7) continue;
  if (f.fn[i] < 0.1) {
    let j = i;
    while (j < s.t.length && f.fn[j] < 0.1) j++;
    if (s.t[Math.min(j, s.t.length - 1)] - s.t[i] >= 0.3) {
      exitAt = s.t[i];
      break;
    }
    i = j;
  }
}
console.log(`first sustained exit after 10.7s: ${exitAt.toFixed(3)}s`);
