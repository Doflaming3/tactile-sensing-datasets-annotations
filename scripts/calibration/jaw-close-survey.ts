// Does jaw position separate "pads touching each other" (ep0 @2.2-2.7,
// video-verified air-close) from "object between pads"? Survey the
// minimum jaw position (a) inside every attempt-flagged span and (b)
// during every episode's real grasp hold (grasp_stable to last release).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildSeriesFromRawCsvs,
  buildSeriesFromSensorFrames,
  clipSeries,
  detectEvents,
  type TactileSeries,
} from "../../visualizer/src/lib/eventDetection";
import { resolveTaxelLayout } from "../../visualizer/src/lib/taxel-layouts";
import { parquetReadObjects } from "../../visualizer/node_modules/hyparquet";
import { SOTAC_PROFILE } from "../../visualizer/src/lib/rigProfile";

const ROOT = "data/sotac";
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
  const metas: { ep: number; chunk: number; file: number; from: number; to: number }[] = [];
  for (const chunk of readdirSync(metaBase).sort()) {
    for (const f of readdirSync(join(metaBase, chunk)).sort()) {
      if (!f.endsWith(".parquet")) continue;
      const rows = await parquetReadObjects({ file: localParquet(join(metaBase, chunk, f)) });
      for (const row of rows as Record<string, unknown>[]) {
        metas.push({
          ep: toNum(row["episode_index"]),
          chunk: toNum(row["data/chunk_index"]),
          file: toNum(row["data/file_index"]),
          from: toNum(row["dataset_from_index"]),
          to: toNum(row["dataset_to_index"]),
        });
      }
    }
  }

  const attemptMins: string[] = [];
  const graspMins: string[] = [];
  for (const m of metas) {
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
    const gripper = gt.length > 2 ? { t: gt, pos: gp } : null;
    if (!gripper) continue;

    let series: TactileSeries | null = null;
    const dir = join(ROOT, "sensors", sensorName, `episode_${pad6(m.ep)}`);
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => f.endsWith(".csv")).sort();
      if (files.length) {
        const raw = buildSeriesFromRawCsvs(files.map((f) => readFileSync(join(dir, f), "utf-8")), layout, undefined, { profile: SOTAC_PROFILE });
        if (raw) series = clipSeries(raw, timestamps[timestamps.length - 1] + 0.1);
      }
    }
    if (!series) {
      series = buildSeriesFromSensorFrames(
        rows.map((r) => r[sensorKey]), timestamps, layout, undefined, SOTAC_PROFILE);
    }
    if (!series) continue;
    const result = detectEvents(series, gripper, {}, { t: armT, joints: armJ }, { profile: SOTAC_PROFILE });

    const minPos = (a: number, b: number): number => {
      let mn = Infinity;
      for (let j = 0; j < gt.length; j++) {
        if (gt[j] < a) continue;
        if (gt[j] > b) break;
        if (gp[j] < mn) mn = gp[j];
      }
      return mn;
    };

    for (const fl of result.flags) {
      const mm = /^(failed_attempt|weak_contact)@([\d.]+)-([\d.]+)s$/.exec(fl);
      if (!mm) continue;
      const mn = minPos(Number(mm[2]), Number(mm[3]) + 0.3);
      attemptMins.push(`ep${m.ep} ${mm[1]}@${mm[2]}-${mm[3]} minJaw=${mn.toFixed(1)}`);
    }
    // real hold: first grasp_stable in the grasp subtask to last release
    const rel = [...result.events].reverse().find((e) => e.label === "release");
    const stable = result.events.find((e) => e.label === "grasp_stable");
    if (rel && stable && rel.startS > stable.startS) {
      graspMins.push(`ep${m.ep} hold ${stable.startS.toFixed(1)}-${rel.startS.toFixed(1)} minJaw=${minPos(stable.startS, rel.startS).toFixed(1)}`);
    }
  }

  console.log("ATTEMPT/WEAK spans (min jaw pos, closing overshoot allowed +0.3s):");
  for (const s of attemptMins) console.log("  " + s);
  console.log("\nREAL holds (min jaw pos during stable-to-release):");
  for (const s of graspMins) console.log("  " + s);
}

main();
