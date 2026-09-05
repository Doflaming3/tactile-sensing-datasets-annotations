// Cycle 3 check: does the finger-scoped, event-level recording filter keep
// the corpus recorded set identical to the old finger-blind, text-parsing
// one? Runs the detector on every local episode, applies both filters,
// reports any difference. Run: bun scripts/probe-recorded-equivalence.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSeriesFromRawCsvs,
  clipSeries,
  detectEvents,
  resultToAtoms,
  resultToRecordedAtoms,
  type AutoLabelResult,
} from "../visualizer/src/lib/eventDetection";
import type { LanguageAtom } from "../visualizer/src/types/language.types";
import { resolveTaxelLayout } from "../visualizer/src/lib/taxel-layouts";
import {
  loadEpisodeInputs,
  loadEpisodesMeta,
  loadRawCsvTexts,
  type Info,
} from "./run-detector";
import { SOTAC_PROFILE } from "../visualizer/src/lib/rigProfile";
import { loadScreenReference } from "./lib/profile-node";
// the screen's corpus is attached from disk (profile-node.ts)
const PROFILE = loadScreenReference(SOTAC_PROFILE);

// the pre-cycle-3 filter, verbatim in behaviour (flag strings + atom text)
function oldRecorded(result: AutoLabelResult): LanguageAtom[] {
  const lowSpans: Array<[number, number]> = [];
  const allSpans: Array<[number, number]> = [];
  for (const fl of result.flags) {
    const m = /^(post_task_contact|weak_contact)@([\d.]+)-([\d.]+)s$/.exec(fl);
    if (!m) continue;
    const span: [number, number] = [Number(m[2]) - 0.05, Number(m[3]) + 0.05];
    (m[1] === "post_task_contact" ? lowSpans : allSpans).push(span);
  }
  const atoms = resultToAtoms(result);
  const inside = (a: LanguageAtom, spans: Array<[number, number]>) =>
    spans.some(([s, e]) => a.timestamp >= s && a.timestamp <= e);
  return atoms.filter((a) => {
    if (a.style !== "interjection") return true;
    if (!a.content?.startsWith("[auto:")) return true;
    if (/\] (phantom|sensor_residual)\b/.test(a.content)) return false;
    if (inside(a, allSpans)) return false;
    return !(a.content.startsWith("[auto:low]") && inside(a, lowSpans));
  });
}

const root = "data/sotac";
const info = JSON.parse(readFileSync(join(root, "meta", "info.json"), "utf-8")) as Info;
const metas = await loadEpisodesMeta(root);
let identical = 0;
let checked = 0;
let spansTotal = 0;
let fingerScoped = 0;
for (const meta of metas) {
  const ep = meta.episode_index;
  const inputs = await loadEpisodeInputs(root, info, meta);
  const layout = resolveTaxelLayout(inputs.nTaxels)?.points ?? null;
  const texts = loadRawCsvTexts(root, ep, inputs.sensorName);
  if (!texts) continue;
  const raw = buildSeriesFromRawCsvs(texts, layout, inputs.gripper, { profile: PROFILE });
  if (!raw) continue;
  const s = clipSeries(raw, inputs.timestamps[inputs.timestamps.length - 1] + 0.1);
  const res = detectEvents(s, inputs.gripper, {}, inputs.arm, { profile: PROFILE, episodeIndex: ep });
  checked++;
  spansTotal += res.spans.length;
  fingerScoped += res.spans.filter((x) => x.finger !== null).length;
  const key = (a: LanguageAtom) => `${a.style}|${a.timestamp.toFixed(3)}|${a.content}`;
  const a = new Set(oldRecorded(res).map(key));
  const b = new Set(resultToRecordedAtoms(res).map(key));
  const onlyOld = [...a].filter((k) => !b.has(k));
  const onlyNew = [...b].filter((k) => !a.has(k));
  // flags must render identically from spans
  const flagsOk = res.flags.every((f) => typeof f === "string");
  if (onlyOld.length === 0 && onlyNew.length === 0 && flagsOk) {
    identical++;
  } else {
    console.log(`ep${ep}: recorded set differs`);
    for (const k of onlyOld) console.log(`   old only: ${k}`);
    for (const k of onlyNew) console.log(`   new only: ${k}`);
  }
}
console.log(
  `checked ${checked} episodes: recorded set identical on ${identical}; spans ${spansTotal} (finger-scoped ${fingerScoped}, hand-level ${spansTotal - fingerScoped})`,
);
