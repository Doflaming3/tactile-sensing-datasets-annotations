// Builds visualizer/src/lib/screen-reference.json — the signal screen's
// reference corpus — from the LOCAL sotac mirror, in the detector's own
// feature space (terminalWindowFeatures on the exact series the app/runner
// build: raw CSVs, adaptive baseline, clipped to the table window).
//
// Rebuild whenever the rig, the featurizer, or the corpus changes; the
// reference is a Tier-2 calibration artifact (analysis/portability.md).
// Reference rows come from PUBLISHED annotations (labels' vintage caveat
// applies: eps 0-5 human-corrected, 6-59 detector output) plus 2
// deterministic background windows per finger (>= 0.5 s from any event).
//
// Also prints the leave-one-episode-out validation: background-vote
// distribution per class, so the 4/7 threshold can be re-checked against
// the numbers each time the reference regenerates.
//
// Usage (repo root):  bun scripts/build-screen-reference.ts

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildSeriesFromRawCsvs,
  clipSeries,
  type TactileSeries,
} from "../visualizer/src/lib/eventDetection";
import {
  SCREEN_HALF_S,
  SCREEN_K,
  SCREEN_VOTE_MIN,
  terminalWindowFeatures,
  type ScreenReference,
} from "../visualizer/src/lib/signalScreen";
import { resolveTaxelLayout } from "../visualizer/src/lib/taxel-layouts";
import {
  loadEpisodeInputs,
  loadEpisodesMeta,
  loadRawCsvTexts,
  type Info,
} from "./run-detector";

const ROOT = "data/sotac";
const OUT = "visualizer/src/lib/screen-reference.json";
const CLASSES = new Set([
  "contact_onset",
  "grasp_stable",
  "slip",
  "place",
  "release",
  "drop",
]);
const BG_PER_FINGER = 2;
const BG_MIN_GAP_S = 0.5;
const AUTO_RE = /^\[auto:(\w+)\] (\w+)(?: (f\d))?/;
const pad6 = (n: number) => String(n).padStart(6, "0");

interface Row {
  ep: number;
  label: string;
  v: number[];
}

const info = JSON.parse(
  readFileSync(join(ROOT, "meta", "info.json"), "utf-8"),
) as Info;
const episodesMeta = await loadEpisodesMeta(ROOT);

const rows: Row[] = [];
for (const meta of episodesMeta) {
  const ep = meta.episode_index;
  const annPath = join(ROOT, "annotations", `episode_${pad6(ep)}.json`);
  if (!existsSync(annPath)) continue; // ep50/60-62: no published labels
  const inputs = await loadEpisodeInputs(ROOT, info, meta);
  const layout = resolveTaxelLayout(inputs.nTaxels)?.points ?? null;
  const texts = loadRawCsvTexts(ROOT, ep, inputs.sensorName);
  if (!texts) continue;
  const raw = buildSeriesFromRawCsvs(texts, layout, inputs.gripper);
  if (!raw) continue;
  const tEnd = inputs.timestamps.length
    ? inputs.timestamps[inputs.timestamps.length - 1] + 0.1
    : raw.t[raw.t.length - 1];
  const series: TactileSeries = clipSeries(raw, tEnd);

  const atoms = (
    JSON.parse(readFileSync(annPath, "utf-8")) as {
      atoms: Array<{ style: string | null; content: string; timestamp: number }>;
    }
  ).atoms;
  const evTimes: number[][] = [[], []];
  for (const a of atoms) {
    if (a.style !== "interjection") continue;
    const m = AUTO_RE.exec(a.content);
    if (!m || !CLASSES.has(m[2]) || !m[3]) continue;
    const finger = Number(m[3].slice(1));
    const v = terminalWindowFeatures(series, finger, a.timestamp);
    if (v) {
      rows.push({ ep, label: m[2], v });
      evTimes[finger]?.push(a.timestamp);
    }
  }
  // deterministic background windows: among samples >= BG_MIN_GAP_S from
  // every event on the finger, take the 1/3 and 2/3 positions
  for (let f = 0; f < series.fingers.length; f++) {
    const far: number[] = [];
    for (const tc of series.t) {
      if (tc < series.t[0] + SCREEN_HALF_S) continue;
      if (tc > series.t[series.t.length - 1] - SCREEN_HALF_S) continue;
      const evs = evTimes[f] ?? [];
      let ok = true;
      for (const te of evs) {
        if (Math.abs(tc - te) < BG_MIN_GAP_S) {
          ok = false;
          break;
        }
      }
      if (ok) far.push(tc);
    }
    if (!far.length) continue;
    const picks = new Set<number>();
    for (let b = 1; b <= BG_PER_FINGER; b++) {
      picks.add(far[Math.floor((far.length * b) / (BG_PER_FINGER + 1))]);
    }
    for (const tc of picks) {
      const v = terminalWindowFeatures(series, f, tc);
      if (v) rows.push({ ep, label: "background", v });
    }
  }
}

const dims = rows[0].v.length;
const mean = new Array<number>(dims).fill(0);
const std = new Array<number>(dims).fill(0);
for (const r of rows) for (let i = 0; i < dims; i++) mean[i] += r.v[i];
for (let i = 0; i < dims; i++) mean[i] /= rows.length;
for (const r of rows) {
  for (let i = 0; i < dims; i++) std[i] += (r.v[i] - mean[i]) ** 2;
}
for (let i = 0; i < dims; i++) std[i] = Math.sqrt(std[i] / rows.length);

const reference: ScreenReference = {
  scaler: {
    mean: mean.map((v) => Number(v.toFixed(4))),
    std: std.map((v) => Number(v.toFixed(4))),
  },
  vectors: rows.map((r) => ({
    ep: r.ep,
    label: r.label,
    v: r.v.map((x) => Number(x.toFixed(3))),
  })),
};

const counts = new Map<string, number>();
for (const r of rows) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
console.log(
  `reference: ${rows.length} windows, ${dims} dims — ` +
    [...counts.entries()].map(([k, n]) => `${k}:${n}`).join(" "),
);

// leave-one-episode-out validation: series are gone, but the reference
// vectors themselves are the queries — vote each against all other episodes
console.log(`\nLOO background votes (of ${SCREEN_K}) per class:`);
const dist = new Map<string, number[]>();
for (const r of rows) {
  // reuse screenBackgroundVotes' scaler+KNN via a synthetic 1-sample series?
  // no — vote directly here to keep it honest and simple
  const q = r.v.map((v, i) => (v - mean[i]) / Math.max(std[i], 1e-9));
  const best: Array<{ d: number; bg: boolean }> = [];
  for (const o of rows) {
    if (o.ep === r.ep) continue;
    let d = 0;
    for (let i = 0; i < dims; i++) {
      const z = (o.v[i] - mean[i]) / Math.max(std[i], 1e-9) - q[i];
      d += z * z;
    }
    if (best.length < SCREEN_K || d < best[best.length - 1].d) {
      let at = best.length;
      while (at > 0 && best[at - 1].d > d) at--;
      best.splice(at, 0, { d, bg: o.label === "background" });
      if (best.length > SCREEN_K) best.pop();
    }
  }
  const votes = best.filter((b) => b.bg).length;
  if (!dist.has(r.label)) dist.set(r.label, []);
  dist.get(r.label)!.push(votes);
}
for (const [label, votes] of dist) {
  const flagged = votes.filter((v) => v >= SCREEN_VOTE_MIN).length;
  const meanV = votes.reduce((a, b) => a + b, 0) / votes.length;
  console.log(
    `  ${label.padEnd(14)} n=${String(votes.length).padStart(3)}  ` +
      `mean=${meanV.toFixed(2)}  >=${SCREEN_VOTE_MIN}: ${flagged} (${((100 * flagged) / votes.length).toFixed(1)}%)`,
  );
}

await Bun.write(OUT, JSON.stringify(reference));
console.log(`\nwrote ${OUT}`);
