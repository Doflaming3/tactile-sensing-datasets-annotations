// Verify the rename pass against Zheng's recorded video verdicts:
// for each affected episode print every marker with its final name and
// whether it survives into the RECORDED annotation set.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildSeriesFromRawCsvs,
  clipSeries,
  detectEvents,
  resultToAtoms,
  resultToRecordedAtoms,
} from "../../visualizer/src/lib/eventDetection";
import { resolveTaxelLayout } from "../../visualizer/src/lib/taxel-layouts";
import { parquetReadObjects } from "../../visualizer/node_modules/hyparquet";

const ROOT = "data/sotac";
const EPS = Array.from({ length: 63 }, (_, i) => i);
const toNum = (v: unknown): number => (typeof v === "bigint" ? Number(v) : (v as number));
const pad6 = (n: number) => String(n).padStart(6, "0");
const localParquet = (p: string): ArrayBuffer => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

async function main() {
  const info = JSON.parse(readFileSync(join(ROOT, "meta", "info.json"), "utf-8"));
  const sensorKey = Object.keys(info.features).find(
    (k: string) => k.startsWith("observation.sensors.") && info.features[k].shape.length >= 2,
  )!;
  const sensorName = sensorKey.slice("observation.sensors.".length);
  const nTaxels = info.features[sensorKey].shape[1];
  const stateNames = info.features["observation.state"].names as string[];
  const gIdx = stateNames.findIndex((n: string) => /gripper/i.test(n));
  const layout = resolveTaxelLayout(nTaxels)?.points ?? null;

  const metaBase = join(ROOT, "meta", "episodes");
  const metas = new Map<number, { chunk: number; file: number; from: number; to: number }>();
  for (const chunk of readdirSync(metaBase).sort()) {
    for (const f of readdirSync(join(metaBase, chunk)).sort()) {
      if (!f.endsWith(".parquet")) continue;
      const rows = await parquetReadObjects({ file: localParquet(join(metaBase, chunk, f)) });
      for (const row of rows as Record<string, unknown>[]) {
        metas.set(toNum(row["episode_index"]), {
          chunk: toNum(row["data/chunk_index"]),
          file: toNum(row["data/file_index"]),
          from: toNum(row["dataset_from_index"]),
          to: toNum(row["dataset_to_index"]),
        });
      }
    }
  }

  for (const ep of EPS) {
    const m = metas.get(ep)!;
    const dataPath = join(
      ROOT, "data",
      `chunk-${String(m.chunk).padStart(3, "0")}`,
      `file-${String(m.file).padStart(3, "0")}.parquet`,
    );
    const file = localParquet(dataPath);
    const first = await parquetReadObjects({ file, columns: ["index"], rowStart: 0, rowEnd: 1 });
    const fileStart = toNum((first[0] as Record<string, unknown>)["index"]);
    const rows = (await parquetReadObjects({
      file,
      columns: ["timestamp", "observation.state", sensorKey],
      rowStart: m.from - fileStart,
      rowEnd: m.to - fileStart,
    })) as Record<string, unknown>[];
    const timestamps = rows.map((r) => toNum(r["timestamp"]));
    const gt: number[] = [];
    const gp: number[] = [];
    const armT: number[] = [];
    const armJ: number[][] = [];
    for (const r of rows) {
      const st = r["observation.state"] as ArrayLike<number>;
      if (!st) continue;
      gt.push(toNum(r["timestamp"]));
      gp.push(Number(st[gIdx]));
      const joints: number[] = [];
      for (let k = 0; k < st.length; k++) if (k !== gIdx) joints.push(Number(st[k]));
      armT.push(toNum(r["timestamp"]));
      armJ.push(joints);
    }
    const dir = join(ROOT, "sensors", sensorName, `episode_${pad6(ep)}`);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(".csv")).sort();
    const raw = buildSeriesFromRawCsvs(
      files.map((f) => readFileSync(join(dir, f), "utf-8")), layout, { t: gt, pos: gp });
    const series = clipSeries(raw!, timestamps[timestamps.length - 1] + 0.1);
    const result = detectEvents(series, { t: gt, pos: gp }, {}, { t: armT, joints: armJ });

    const placeRel = result.subtasks.find((s) => s.label === "place_release");
    const airSpans = [];
    for (const fl of result.flags) {
      const mm = /^air_grasp@([\d.]+)-([\d.]+)s$/.exec(fl);
      if (mm) airSpans.push([Number(mm[1]) - 0.1, Number(mm[2]) + 0.1]);
    }
    const stt = series.t;
    const idxAt = (tq) => {
      let lo = 0, hi = stt.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (stt[mid] < tq) lo = mid + 1; else hi = mid; }
      return lo;
    };
    for (const e of result.events) {
      if (e.label !== "place") continue;
      const fing = series.fingers[e.finger];
      let plateau = 0;
      for (let i = idxAt(e.startS - 1.0); i <= idxAt(e.startS) && i < stt.length; i++) {
        if (fing.fn[i] > plateau) plateau = fing.fn[i];
      }
      const nextTerm = result.events.find(
        (x) => x.finger === e.finger && x.startS >= e.endS - 1e-6 &&
          ["release", "drop", "finger_unload", "sensor_residual"].includes(x.label),
      );
      const termS = nextTerm ? nextTerm.startS : stt[stt.length - 1];
      let maxRec = 0;
      for (let i = idxAt(e.endS + 0.2); i <= idxAt(termS) && i < stt.length; i++) {
        if (fing.fn[i] > maxRec) maxRec = fing.fn[i];
      }
      const recFrac = plateau > 0 ? maxRec / plateau : 0;
      const inAir = airSpans.some(([s2, e2]) => e.startS >= s2 && e.startS <= e2);
      const dtAnchor = placeRel ? (e.startS - placeRel.startS).toFixed(2) : "n/a";
      console.log(
        "ep" + ep + " f" + e.finger + " place " + e.startS.toFixed(2) + "-" + e.endS.toFixed(2) +
        " " + e.confidence + " plateau=" + plateau.toFixed(1) +
        " recovery=" + (recFrac * 100).toFixed(0) + "%" +
        " dtAnchor=" + dtAnchor + " inAir=" + (inAir ? "Y" : "n") +
        " term=" + (nextTerm ? nextTerm.label + "@" + termS.toFixed(2) : "NONE"),
      );
    }
  }
}
main();
