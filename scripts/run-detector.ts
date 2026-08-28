// Offline runner for the visualizer's tactile event detector.
//
// Drives visualizer/src/lib/eventDetection.ts on the LOCAL data mirrors
// (data/sotac by default) exactly the way the app's auto-label panel does:
// raw ~91 Hz sidecar CSVs by default, clipped to the main table's window,
// with the 30 Hz table as fallback; gripper trajectory from
// observation.state; taxel layout resolved from the sensor's point count.
//
// Usage (run with bun from the repo root):
//   bun scripts/run-detector.ts --episode 6
//   bun scripts/run-detector.ts --episode 6 --source table
//   bun scripts/run-detector.ts --episode 6 --compare        # diff vs published annotations
//   bun scripts/run-detector.ts --all --compare              # batch consistency audit
//   bun scripts/run-detector.ts --episode 6 --th hfEnter=10 --th contactEnterN=0.2
//   bun scripts/run-detector.ts --episode 6 --json out.json

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  buildSeriesFromSensorFrames,
  buildSeriesFromRawCsvs,
  clipSeries,
  detectEvents,
  resultToAtoms,
  type DetectionThresholds,
  type TactileSeries,
} from "../visualizer/src/lib/eventDetection";
import { resolveTaxelLayout } from "../visualizer/src/lib/taxel-layouts";
import { parquetReadObjects } from "../visualizer/node_modules/hyparquet";

// ---------------------------------------------------------------- args

interface Args {
  dataset: string;
  episode: number | null;
  all: boolean;
  source: "raw" | "table";
  compare: boolean;
  json: string | null;
  report: string | null;
  thresholds: Partial<DetectionThresholds>;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dataset: "data/sotac",
    episode: null,
    all: false,
    source: "raw",
    compare: false,
    json: null,
    report: null,
    thresholds: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--dataset") a.dataset = argv[++i];
    else if (k === "--episode") a.episode = Number(argv[++i]);
    else if (k === "--all") a.all = true;
    else if (k === "--source") a.source = argv[++i] as "raw" | "table";
    else if (k === "--compare") a.compare = true;
    else if (k === "--json") a.json = argv[++i];
    else if (k === "--report") a.report = argv[++i];
    else if (k === "--th") {
      const [key, val] = argv[++i].split("=");
      (a.thresholds as Record<string, number>)[key] = Number(val);
    } else throw new Error(`unknown arg ${k}`);
  }
  if (a.episode === null && !a.all) {
    throw new Error("pass --episode <N> or --all");
  }
  return a;
}

// ---------------------------------------------------------------- parquet

function toNum(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : (v as number);
}

function localParquet(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

interface EpisodeMeta {
  episode_index: number;
  dataChunk: number;
  dataFile: number;
  from: number;
  to: number;
  length: number;
}

async function loadEpisodesMeta(root: string): Promise<EpisodeMeta[]> {
  const base = join(root, "meta", "episodes");
  const out: EpisodeMeta[] = [];
  for (const chunk of readdirSync(base).sort()) {
    const dir = join(base, chunk);
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".parquet")) continue;
      const rows = await parquetReadObjects({ file: localParquet(join(dir, f)) });
      for (const row of rows as Record<string, unknown>[]) {
        out.push({
          episode_index: toNum(row["episode_index"]),
          dataChunk: toNum(row["data/chunk_index"]),
          dataFile: toNum(row["data/file_index"]),
          from: toNum(row["dataset_from_index"]),
          to: toNum(row["dataset_to_index"]),
          length: toNum(row["length"]),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- episode IO

interface Info {
  fps: number;
  features: Record<
    string,
    { dtype: string; shape: number[]; names: unknown }
  >;
}

interface EpisodeInputs {
  timestamps: number[];
  gripper: { t: number[]; pos: number[] } | null;
  frames: unknown[];
  sensorName: string;
  nTaxels: number;
}

const pad6 = (n: number) => String(n).padStart(6, "0");

async function loadEpisodeInputs(
  root: string,
  info: Info,
  meta: EpisodeMeta,
): Promise<EpisodeInputs> {
  const sensorKey = Object.keys(info.features).find(
    (k) => k.startsWith("observation.sensors.") && info.features[k].shape.length >= 2,
  );
  if (!sensorKey) throw new Error("no observation.sensors.* feature in info.json");
  const sensorName = sensorKey.slice("observation.sensors.".length);
  const nTaxels = info.features[sensorKey].shape[1];

  const stateNames = info.features["observation.state"]?.names as string[] | null;
  const gripperIdx = Array.isArray(stateNames)
    ? stateNames.findIndex((n) => /gripper/i.test(n))
    : -1;

  const dataPath = join(
    root, "data",
    `chunk-${String(meta.dataChunk).padStart(3, "0")}`,
    `file-${String(meta.dataFile).padStart(3, "0")}.parquet`,
  );
  const file = localParquet(dataPath);
  const first = await parquetReadObjects({
    file, columns: ["index"], rowStart: 0, rowEnd: 1,
  });
  const fileStart = toNum((first[0] as Record<string, unknown>)["index"]);
  const rows = (await parquetReadObjects({
    file,
    columns: ["timestamp", "observation.state", sensorKey],
    rowStart: meta.from - fileStart,
    rowEnd: meta.to - fileStart,
  })) as Record<string, unknown>[];

  const timestamps = rows.map((r) => toNum(r["timestamp"]));
  const frames = rows.map((r) => r[sensorKey]);
  let gripper: { t: number[]; pos: number[] } | null = null;
  if (gripperIdx >= 0) {
    gripper = { t: [], pos: [] };
    for (const r of rows) {
      const st = r["observation.state"] as ArrayLike<number> | undefined;
      if (!st) continue;
      gripper.t.push(toNum(r["timestamp"]));
      gripper.pos.push(Number(st[gripperIdx]));
    }
    if (gripper.t.length <= 2) gripper = null;
  }
  return { timestamps, gripper, frames, sensorName, nTaxels };
}

function loadRawCsvTexts(root: string, ep: number, sensorName: string): string[] | null {
  const dir = join(root, "sensors", sensorName, `episode_${pad6(ep)}`);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".csv")).sort();
  if (files.length === 0) return null;
  return files.map((f) => readFileSync(join(dir, f), "utf-8"));
}

// ---------------------------------------------------------------- compare

interface Atom {
  role: string;
  content: string;
  style: string | null;
  timestamp: number;
}

const AUTO_RE = /^\[auto:(\w+)\] (\w+)(?: (f\d))?(?: ([\d.]+)s)?$/;

function atomKey(a: Atom): string {
  const m = AUTO_RE.exec(a.content);
  if (m) return `event|${m[2]}|${m[3] ?? ""}`;
  return `${a.style}|${a.content}`;
}

function compareAtoms(ours: Atom[], theirs: Atom[]) {
  const exact = (a: Atom) => `${a.style}|${a.content}|${a.timestamp.toFixed(4)}`;
  const theirExact = new Set(theirs.map(exact));
  const ourExact = new Set(ours.map(exact));
  const unchanged = ours.filter((a) => theirExact.has(exact(a)));
  let ourRest = ours.filter((a) => !theirExact.has(exact(a)));
  let theirRest = theirs.filter((a) => !ourExact.has(exact(a)));
  const moved: Array<[Atom, Atom]> = [];
  const modified: Array<[Atom, Atom]> = [];
  for (const o of [...ourRest]) {
    const cands = theirRest.filter(
      (t) => atomKey(t) === atomKey(o) && Math.abs(t.timestamp - o.timestamp) <= 0.5,
    );
    if (!cands.length) continue;
    const t = cands.reduce((best, c) =>
      Math.abs(c.timestamp - o.timestamp) < Math.abs(best.timestamp - o.timestamp) ? c : best,
    );
    ourRest = ourRest.filter((x) => x !== o);
    theirRest = theirRest.filter((x) => x !== t);
    (o.content === t.content ? moved : modified).push([o, t]);
  }
  return { unchanged, moved, modified, onlyOurs: ourRest, onlyTheirs: theirRest };
}

// ---------------------------------------------------------------- main

const reportRows: Record<string, unknown>[] = [];

async function runEpisode(
  root: string,
  info: Info,
  meta: EpisodeMeta,
  args: Args,
): Promise<{ ok: boolean; line: string }> {
  const ep = meta.episode_index;
  const inputs = await loadEpisodeInputs(root, info, meta);
  const layout = resolveTaxelLayout(inputs.nTaxels)?.points ?? null;

  let series: TactileSeries | null = null;
  let gripper = inputs.gripper;
  let source = args.source;
  if (args.source === "raw") {
    const texts = loadRawCsvTexts(root, ep, inputs.sensorName);
    const raw = texts ? buildSeriesFromRawCsvs(texts, layout) : null;
    if (raw && texts) {
      const tEnd = inputs.timestamps.length
        ? inputs.timestamps[inputs.timestamps.length - 1] + 0.1
        : raw.t[raw.t.length - 1];
      series = clipSeries(raw, tEnd);
      // NOTE: the gripper (table clock) is used as-is on the raw time base.
      // Content-matching via buildTableToRawClockMap verified the two sotac
      // clocks agree to ~2 ms, so no re-clocking is needed here. Do NOT
      // remap by default: anchor pairs exist only during contact, and the
      // interpolated map can go non-monotone between sparse anchors, which
      // corrupts the gripper-velocity resampler (measured: corpus match
      // rate collapsed 23 -> 2 with remapping on). Company-format data,
      // where the clocks genuinely differ, needs a monotone-constrained
      // fit before this becomes safe as a transform.
    } else {
      source = "table";
    }
  }
  if (!series) {
    series = buildSeriesFromSensorFrames(inputs.frames, inputs.timestamps, layout);
  }
  if (!series) throw new Error(`episode ${ep}: no tactile series`);

  const result = detectEvents(series, gripper, args.thresholds);
  const atoms = resultToAtoms(result) as unknown as Atom[];

  if (!args.all) {
    console.log(
      `episode ${ep} — source=${source} rate=${series.rateHz.toFixed(1)} Hz ` +
        `samples=${series.t.length} events=${result.events.length} ` +
        `flags=[${result.flags.join(", ")}]`,
    );
    for (const a of atoms) {
      console.log(
        `  ${a.timestamp.toFixed(3).padStart(8)}  ${String(a.style).padEnd(12)} ${a.content}`,
      );
    }
  }

  if (args.json && !args.all) {
    const out = {
      episode_index: ep,
      source,
      rateHz: series.rateHz,
      thresholds: args.thresholds,
      flags: result.flags,
      atoms,
    };
    await Bun.write(args.json, JSON.stringify(out, null, 1));
    console.log(`wrote ${args.json}`);
  }

  if (!args.compare) return { ok: true, line: "" };

  const annPath = join(root, "annotations", `episode_${pad6(ep)}.json`);
  if (!existsSync(annPath)) {
    return { ok: false, line: `ep${ep}: no published annotation file` };
  }
  const theirs = (JSON.parse(readFileSync(annPath, "utf-8")) as { atoms: Atom[] }).atoms;
  const c = compareAtoms(atoms, theirs);
  const ok = c.onlyOurs.length === 0 && c.onlyTheirs.length === 0 &&
    c.moved.length === 0 && c.modified.length === 0;
  reportRows.push({
    episode: ep,
    ours: atoms.length,
    theirs: theirs.length,
    unchanged: c.unchanged.length,
    moved: c.moved.map(([o, t]) => ({ content: o.content, ours: o.timestamp, theirs: t.timestamp })),
    modified: c.modified.map(([o, t]) => ({ ours: o.content, theirs: t.content, t: o.timestamp })),
    onlyOurs: c.onlyOurs.map((a) => ({ t: a.timestamp, content: a.content })),
    onlyTheirs: c.onlyTheirs.map((a) => ({ t: a.timestamp, content: a.content })),
  });
  const line =
    `ep${String(ep).padStart(2)}: ours=${atoms.length} theirs=${theirs.length} ` +
    `unchanged=${c.unchanged.length} moved=${c.moved.length} ` +
    `modified=${c.modified.length} onlyOurs=${c.onlyOurs.length} onlyTheirs=${c.onlyTheirs.length}` +
    (ok ? "  MATCH" : "");
  if (!args.all) {
    console.log(`\ncompare vs ${annPath}`);
    console.log(line);
    for (const [o, t] of c.moved) {
      console.log(`  MOVED    ${o.content}: ours ${o.timestamp.toFixed(3)} vs theirs ${t.timestamp.toFixed(3)}`);
    }
    for (const [o, t] of c.modified) {
      console.log(`  MODIFIED ${o.timestamp.toFixed(3)}  ours ${o.content!} vs theirs ${t.content}`);
    }
    for (const a of c.onlyOurs) console.log(`  ONLY-OURS   ${a.timestamp.toFixed(3)}  ${a.content}`);
    for (const a of c.onlyTheirs) console.log(`  ONLY-THEIRS ${a.timestamp.toFixed(3)}  ${a.content}`);
  }
  return { ok, line };
}

const args = parseArgs(process.argv.slice(2));
const root = args.dataset;
const info = JSON.parse(readFileSync(join(root, "meta", "info.json"), "utf-8")) as Info;
const episodes = await loadEpisodesMeta(root);

if (args.all) {
  let matches = 0;
  let total = 0;
  for (const meta of episodes) {
    try {
      const { ok, line } = await runEpisode(root, info, meta, args);
      if (line) console.log(line);
      if (ok) matches++;
      total++;
    } catch (e) {
      console.log(`ep${meta.episode_index}: ERROR ${(e as Error).message}`);
      total++;
    }
  }
  if (args.compare) console.log(`\n${matches}/${total} episodes match published annotations`);
  if (args.report) {
    await Bun.write(args.report, JSON.stringify(reportRows, null, 1));
    console.log(`wrote ${args.report}`);
  }
} else {
  const meta = episodes.find((e) => e.episode_index === args.episode);
  if (!meta) throw new Error(`episode ${args.episode} not in meta/episodes`);
  await runEpisode(root, info, meta, args);
}
