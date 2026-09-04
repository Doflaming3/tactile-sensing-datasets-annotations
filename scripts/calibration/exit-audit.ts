// Audit of release condition 1 (two-sample jaw-opening check) across the
// corpus. For every terminal event (release/drop) reports:
//   cond1     — the shipped check: gvel > eps at exit start OR at +0.3s
//   placed    — the (circular) place-context rule that currently rescues it
//   winTravel — net jaw travel over [t-0.5, t+1.0] (opening positive)
//   openOff   — offset of nearest sustained opening onset in [t-1, t+3]
// Classes:
//   A cond1 fires                       -> jaw check works as-is
//   B !cond1, opening within window     -> a WINDOWED jaw check would decouple it
//   C !cond1, opening only >1s later    -> placement-then-open (needs new logic)
//   D !cond1, no opening at all         -> true drop OR phantom exit
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  buildSeriesFromSensorFrames,
  buildSeriesFromRawCsvs,
  clipSeries,
  detectEvents,
  type TactileSeries,
} from "../../visualizer/src/lib/eventDetection";
import { resolveTaxelLayout } from "../../visualizer/src/lib/taxel-layouts";
import { parquetReadObjects } from "../../visualizer/node_modules/hyparquet";
import { SOTAC_PROFILE } from "../../visualizer/src/lib/rigProfile";

const ROOT = "data/sotac";
const EPS = 0.5; // th.gripperVelEps default

const toNum = (v: unknown): number => (typeof v === "bigint" ? Number(v) : (v as number));
const pad6 = (n: number) => String(n).padStart(6, "0");
const localParquet = (p: string): ArrayBuffer => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

async function main() {
  const info = JSON.parse(readFileSync(join(ROOT, "meta", "info.json"), "utf-8"));
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

  const sensorKey = Object.keys(info.features).find(
    (k: string) => k.startsWith("observation.sensors.") && info.features[k].shape.length >= 2,
  )!;
  const sensorName = sensorKey.slice("observation.sensors.".length);
  const nTaxels = info.features[sensorKey].shape[1];
  const stateNames = info.features["observation.state"]?.names as string[];
  const gIdx = stateNames.findIndex((n) => /gripper/i.test(n));
  const layout = resolveTaxelLayout(nTaxels)?.points ?? null;

  const counts = { A: 0, B: 0, C: 0, D: 0 };
  const rows: string[] = [];

  for (const m of metas) {
    const dataPath = join(
      ROOT, "data",
      `chunk-${String(m.chunk).padStart(3, "0")}`,
      `file-${String(m.file).padStart(3, "0")}.parquet`,
    );
    const file = localParquet(dataPath);
    const first = await parquetReadObjects({ file, columns: ["index"], rowStart: 0, rowEnd: 1 });
    const fileStart = toNum((first[0] as Record<string, unknown>)["index"]);
    const dataRows = (await parquetReadObjects({
      file,
      columns: ["timestamp", "observation.state", sensorKey],
      rowStart: m.from - fileStart,
      rowEnd: m.to - fileStart,
    })) as Record<string, unknown>[];

    const timestamps = dataRows.map((r) => toNum(r["timestamp"]));
    const frames = dataRows.map((r) => r[sensorKey]);
    const gt: number[] = [];
    const gp: number[] = [];
    const armT: number[] = [];
    const armJ: number[][] = [];
    for (const r of dataRows) {
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
    const arm = gripper ? { t: armT, joints: armJ } : null;

    let series: TactileSeries | null = null;
    const dir = join(ROOT, "sensors", sensorName, `episode_${pad6(m.ep)}`);
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => f.endsWith(".csv")).sort();
      if (files.length) {
        const raw = buildSeriesFromRawCsvs(files.map((f) => readFileSync(join(dir, f), "utf-8")), layout, undefined, { profile: SOTAC_PROFILE });
        if (raw) series = clipSeries(raw, timestamps[timestamps.length - 1] + 0.1);
      }
    }
    if (!series) series = buildSeriesFromSensorFrames(frames, timestamps, layout, undefined, SOTAC_PROFILE);
    if (!series || !gripper) continue;

    const result = detectEvents(series, gripper, {}, arm, { profile: SOTAC_PROFILE });

    // gripper velocity exactly as the detector resamples it (sample-and-hold
    // finite difference between the bracketing table pair)
    const gvelAt = (tq: number): number => {
      let j = 1;
      while (j < gt.length - 1 && gt[j] < tq) j++;
      const dt = gt[j] - gt[j - 1];
      return dt > 1e-9 ? (gp[j] - gp[j - 1]) / dt : 0;
    };
    const posAt = (tq: number): number => {
      if (tq <= gt[0]) return gp[0];
      if (tq >= gt[gt.length - 1]) return gp[gp.length - 1];
      let j = 1;
      while (j < gt.length - 1 && gt[j] < tq) j++;
      return gp[j - 1];
    };
    // sustained opening onsets: gvel > EPS for >= 3 consecutive table steps
    const openOnsets: number[] = [];
    let run = 0;
    for (let j = 1; j < gt.length; j++) {
      const dt = gt[j] - gt[j - 1];
      const v = dt > 1e-9 ? (gp[j] - gp[j - 1]) / dt : 0;
      if (v > EPS) {
        run++;
        if (run === 3) openOnsets.push(gt[j - run + 1]);
      } else run = 0;
    }

    const st = series.t;
    const idxAt = (tq: number): number => {
      let lo = 0, hi = st.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (st[mid] < tq) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };

    const events = result.events;

    // ---- simulate the decoupled rules on every terminal
    const terms = events.filter((e) => e.label === "release" || e.label === "drop");
    const travelOf = (tq: number): number => posAt(tq + 1.0) - posAt(tq - 0.5);
    const backOf = (tq: number): number => posAt(tq) - posAt(tq - 0.5);
    const rule1 = (tq: number): boolean =>
      backOf(tq) > -1.0 && travelOf(tq) >= 2.0;
    const newLabelOf = (e: (typeof terms)[0]): string => {
      const tEx = e.startS;
      if (rule1(tEx)) return "release";
      // this exit's own bout onset: the latest contact_onset on this finger
      // before the exit
      let boutOnset = -1;
      for (const c of events) {
        if (c.finger === e.finger && c.label === "contact_onset" &&
            c.startS < tEx && c.startS > boutOnset) boutOnset = c.startS;
      }
      // peel requires the finger to have been HOLDING in this very bout:
      // its last grasp_stable must lie inside the bout
      const hadStable = events.some(
        (s) =>
          s.finger === e.finger && s.label === "grasp_stable" &&
          s.startS < tEx && s.startS >= boutOnset,
      );
      const recontact = events.some(
        (c) =>
          c.finger === e.finger && c.label === "contact_onset" &&
          c.startS > tEx && c.startS - tEx <= 1.5,
      );
      if (hadStable && !recontact) {
        // early peel: partner holding at exit, partner's next exit <=3s later is rule-1
        for (const p of terms) {
          if (p.finger === e.finger) continue;
          if (p.startS >= tEx && p.startS - tEx <= 3.0 && rule1(p.startS)) {
            const partnerHolding = events.some(
              (c) =>
                c.finger === p.finger && c.label === "contact_onset" &&
                c.startS < tEx,
            ) && !terms.some((x) => x.finger === p.finger && x.startS < tEx && x.startS > 0 &&
              !events.some((c2) => c2.finger === p.finger && c2.label === "contact_onset" &&
                c2.startS > x.startS && c2.startS < tEx));
            if (partnerHolding) return "release";
          }
          // late peel: partner's rule-1 release <=1.5s BEFORE this exit, and
          // this finger was already in contact when the partner released
          if (p.startS <= tEx && tEx - p.startS <= 1.5 && rule1(p.startS) &&
              boutOnset <= p.startS) return "release";
        }
      }
      return "drop";
    };

    for (const e of events) {
      if (e.label !== "release" && e.label !== "drop") continue;
      const tEx = e.startS;
      const newLabel = newLabelOf(e as (typeof terms)[0]);
      if (newLabel !== e.label) {
        rows.push(
          `FLIP ep${String(m.ep).padStart(2)} f${e.finger} t=${tEx.toFixed(2)} ` +
            `${e.label} -> ${newLabel}  (travel=${travelOf(tEx).toFixed(1)})`,
        );
      }
      const fing = series.fingers[e.finger];
      // bout peak: max fn from the matching contact_onset to the exit
      let onsetT = 0;
      for (const c of events) {
        if (c.finger === e.finger && c.label === "contact_onset" && c.startS < tEx && c.startS > onsetT) {
          onsetT = c.startS;
        }
      }
      let boutPeak = 0;
      for (let k = idxAt(onsetT); k <= idxAt(tEx) && k < st.length; k++) {
        if (fing.fn[k] > boutPeak) boutPeak = fing.fn[k];
      }
      // decay: plateau = max fn in the 1.5s before exit; decayS = time since
      // fn was last at >= 50% of that plateau
      const exIdx = idxAt(tEx);
      let plateau = 0;
      for (let k = idxAt(tEx - 1.5); k <= exIdx; k++) {
        if (fing.fn[k] > plateau) plateau = fing.fn[k];
      }
      let lastHalf = exIdx;
      for (let k = exIdx; k >= 0 && st[k] >= tEx - 1.5; k--) {
        if (fing.fn[k] >= plateau * 0.5) { lastHalf = k; break; }
      }
      const decayS = tEx - st[lastHalf];
      const hfConf = fing.hf[Math.min(idxAt(tEx + 0.3), st.length - 1)];
      const cond1 = gvelAt(tEx) > EPS || gvelAt(tEx + 0.3) > EPS;
      const placed = events.some(
        (p) =>
          p.finger === e.finger && p.label === "place" &&
          p.endS <= tEx + 1e-6 && tEx - p.endS <= 1.0,
      );
      const winTravel = posAt(tEx + 1.0) - posAt(tEx - 0.5);
      let openOff: number | null = null;
      for (const o of openOnsets) {
        const off = o - tEx;
        if (off >= -1.0 && off <= 3.0 && (openOff === null || Math.abs(off) < Math.abs(openOff))) {
          openOff = off;
        }
      }
      const windowed = openOff !== null && openOff >= -1.0 && openOff <= 1.0;
      const cls = cond1 ? "A" : windowed ? "B" : openOff !== null ? "C" : "D";
      counts[cls]++;
      rows.push(
        `ep${String(m.ep).padStart(2)} f${e.finger} ${e.label.padEnd(7)} ` +
          `t=${tEx.toFixed(2).padStart(6)} conf=${String(e.confidence).padEnd(6)} ` +
          `cls=${cls} cond1=${cond1 ? "Y" : "n"} placed=${placed ? "Y" : "n"} ` +
          `winTravel=${winTravel.toFixed(1).padStart(6)} ` +
          `openOff=${openOff === null ? "  none" : openOff.toFixed(2).padStart(6)} ` +
          `peak=${boutPeak.toFixed(1).padStart(5)} decay=${decayS.toFixed(2).padStart(5)} ` +
          `hf=${hfConf.toFixed(1).padStart(5)}`,
      );
    }
  }

  console.log(rows.join("\n"));
  console.log(
    `\nTOTALS  A(cond1 ok)=${counts.A}  B(windowed jaw would catch)=${counts.B}  ` +
      `C(opening >1s later)=${counts.C}  D(no opening at all)=${counts.D}`,
  );
}

main();
