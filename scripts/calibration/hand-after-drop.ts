// Hand-total force in the 1.0s after each candidate attempt drop.
// Separability question: ep47 (real attempt, partner reading = standing
// phantom) and ep32/ep45 (real attempts, hand empty) must sit BELOW the
// threshold; ep35 (phantom span, partner = motion phantom) and ep40
// (real pinch continues on partner) must sit ABOVE it — if they do.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildSeriesFromRawCsvs,
  clipSeries,
} from "../../visualizer/src/lib/eventDetection";
import { resolveTaxelLayout } from "../../visualizer/src/lib/taxel-layouts";
import { parquetReadObjects } from "../../visualizer/node_modules/hyparquet";

const ROOT = "data/sotac";
const CASES: Array<[number, number, string]> = [
  [47, 4.575, "REAL attempt, partner=standing phantom (must flag)"],
  [32, 6.501, "REAL attempt, hand empty (must flag)"],
  [45, 7.57, "REAL loss, failure ep (must flag)"],
  [35, 4.54, "phantom span (must NOT flag)"],
  [40, 8.74, "pinch continues on partner (must NOT flag)"],
  [19, 3.67, "ball slid into clamp (must NOT flag)"],
  [33, 4.51, "migration during grasp (must NOT flag)"],
];

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

  for (const [ep, tDrop, label] of CASES) {
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
      file, columns: ["timestamp"], rowStart: m.from - fileStart, rowEnd: m.to - fileStart,
    })) as Record<string, unknown>[];
    const tEnd = toNum(rows[rows.length - 1]["timestamp"]) + 0.1;

    const dir = join(ROOT, "sensors", sensorName, `episode_${pad6(ep)}`);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(".csv")).sort();
    const raw = buildSeriesFromRawCsvs(files.map((f) => readFileSync(join(dir, f), "utf-8")), layout);
    const series = clipSeries(raw!, tEnd);

    // hand total fn over [tDrop, tDrop+1.0], reported per 0.1s step
    const stats: string[] = [];
    for (let w = 0; w < 10; w++) {
      const a = tDrop + w * 0.1;
      const b = a + 0.1;
      let mx = 0;
      for (let i = 0; i < series.t.length; i++) {
        if (series.t[i] < a) continue;
        if (series.t[i] > b) break;
        let sum = 0;
        for (const f of series.fingers) sum += f.fn[i];
        if (sum > mx) mx = sum;
      }
      stats.push(mx.toFixed(1));
    }
    console.log(`ep${ep} drop@${tDrop}: hand max/0.1s = [${stats.join(" ")}]  (${label})`);
  }
}

main();

// jaw opening after the drop: max rise above the drop-time position
// within 2.5s, from the table gripper series
async function jawCheck() {
  const info = JSON.parse(readFileSync(join(ROOT, "meta", "info.json"), "utf-8"));
  const stateNames = info.features["observation.state"].names as string[];
  const gIdx = stateNames.findIndex((n: string) => /gripper/i.test(n));
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
  for (const [ep, tDrop, label] of CASES) {
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
      file, columns: ["timestamp", "observation.state"],
      rowStart: m.from - fileStart, rowEnd: m.to - fileStart,
    })) as Record<string, unknown>[];
    let posAtDrop = -1;
    let maxRise = 0;
    for (const r of rows) {
      const ts = toNum(r["timestamp"]);
      const st = r["observation.state"] as ArrayLike<number>;
      if (!st) continue;
      const p = Number(st[gIdx]);
      if (ts <= tDrop) posAtDrop = p;
      else if (posAtDrop >= 0) {
        maxRise = Math.max(maxRise, p - posAtDrop);
      }
    }
    console.log(`ep${ep} drop@${tDrop}: jaw max rise to EP END = ${maxRise.toFixed(1)}  (${label})`);
  }
}
await jawCheck();
