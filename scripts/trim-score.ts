// Scores the visualizer's trim detector (visualizer/src/lib/trimDetect.ts)
// against Jingyi's own cuts, read off the raw recordings by
// scripts/trim_census.py (analysis/trim-census-all163.csv). Our conventions:
// the local table-only mirror of sotac_raw, parquet read from disk.
//
// Usage (repo root):
//   bun scripts/trim-score.ts [--raw data/sotac_raw_326fe149] [--census analysis/trim-census-all163.csv]
//                             [--lead 0.4] [--tail 0.53] [--cmd 0.2] [--meas 0.5] [--hold-start 5] [--hold-end 2]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { parquetReadObjects } from "../visualizer/node_modules/hyparquet";
import {
  DEFAULT_TRIM_PARAMS,
  proposeTrim,
  type TrimParams,
} from "../visualizer/src/lib/trimDetect";

const FPS = 30;

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function localParquet(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function toNum(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v);
}

function listParquet(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".parquet")) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

interface Cut {
  cur: number;
  raw: number;
  start_cut: number;
  kept_end_frame_raw: number;
}

function readCensus(path: string): Cut[] {
  const lines = readFileSync(path, "utf-8").trim().split(/\r?\n/);
  const head = lines[0].split(",");
  const col = (n: string) => head.indexOf(n);
  return lines.slice(1).map((l) => {
    const c = l.split(",");
    return {
      cur: Number(c[col("cur")]),
      raw: Number(c[col("raw")]),
      start_cut: Number(c[col("start_cut")]),
      kept_end_frame_raw: Number(c[col("kept_end_frame_raw")]),
    };
  });
}

function stats(xs: number[]): string {
  if (xs.length === 0) return "n=0";
  const s = [...xs].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  const within = (k: number) => xs.filter((x) => Math.abs(x) <= k).length;
  return `n=${xs.length} median ${med} mean ${mean.toFixed(1)} sd ${sd.toFixed(1)} |x|<=3: ${within(3)} |x|<=6: ${within(6)} |x|<=15: ${within(15)} min ${s[0]} max ${s[s.length - 1]}`;
}

async function main() {
  const raw = arg("raw", "data/sotac_raw_326fe149");
  const census = readCensus(arg("census", "analysis/trim-census-all163.csv"));
  const params: TrimParams = {
    ...DEFAULT_TRIM_PARAMS,
    leadS: Number(arg("lead", String(DEFAULT_TRIM_PARAMS.leadS))),
    tailS: Number(arg("tail", String(DEFAULT_TRIM_PARAMS.tailS))),
    commandSpeedDegPerFrame: Number(arg("cmd", String(DEFAULT_TRIM_PARAMS.commandSpeedDegPerFrame))),
    measuredSpeedDegPerFrame: Number(arg("meas", String(DEFAULT_TRIM_PARAMS.measuredSpeedDegPerFrame))),
    holdStart: Number(arg("hold-start", String(DEFAULT_TRIM_PARAMS.holdStart))),
    holdEnd: Number(arg("hold-end", String(DEFAULT_TRIM_PARAMS.holdEnd))),
  };
  if (!existsSync(raw)) throw new Error(`no mirror at ${raw}`);
  console.log(`params ${JSON.stringify(params)}`);

  // every raw episode's measured and commanded joints
  const byEp = new Map<number, { t: number[]; state: number[][]; action: number[][] }>();
  for (const f of listParquet(join(raw, "data"))) {
    const rows = (await parquetReadObjects({
      file: localParquet(f),
      columns: ["episode_index", "frame_index", "timestamp", "observation.state", "action"],
    })) as Record<string, unknown>[];
    for (const r of rows) {
      const ep = toNum(r["episode_index"]);
      let e = byEp.get(ep);
      if (!e) {
        e = { t: [], state: [], action: [] };
        byEp.set(ep, e);
      }
      const st = Array.from(r["observation.state"] as ArrayLike<number>).map(Number);
      const ac = Array.from(r["action"] as ArrayLike<number>).map(Number);
      e.t.push(Number(r["timestamp"]));
      e.state.push(st.slice(0, 5));
      e.action.push(ac.slice(0, 5));
    }
  }
  // rows come in file order, which is frame order within an episode

  const groups: Record<string, { ds: number[]; de: number[]; flagged: number; rows: string[] }> = {
    "new100 (raw>=77)": { ds: [], de: [], flagged: 0, rows: [] },
    "old63 (raw<77)": { ds: [], de: [], flagged: 0, rows: [] },
  };
  for (const c of census) {
    const e = byEp.get(c.raw);
    if (!e) continue;
    const p = proposeTrim({ t: e.t, joints: e.state }, { t: e.t, joints: e.action }, FPS, params);
    if (!p) continue;
    const g = groups[c.raw >= 77 ? "new100 (raw>=77)" : "old63 (raw<77)"];
    const ds = p.startFrame - c.start_cut;
    const de = p.endFrame - c.kept_end_frame_raw;
    g.ds.push(ds);
    g.de.push(de);
    if (p.flags.length) g.flagged++;
    if (Math.abs(ds) > 15 || Math.abs(de) > 15)
      g.rows.push(`  cur ${c.cur} raw ${c.raw}: start ours ${p.startFrame} hers ${c.start_cut} (${ds >= 0 ? "+" : ""}${ds}) end ours ${p.endFrame} hers ${c.kept_end_frame_raw} (${de >= 0 ? "+" : ""}${de}) flags ${p.flags.join(",") || "-"}`);
  }
  for (const [name, g] of Object.entries(groups)) {
    console.log(`\n${name}: ${g.ds.length} episodes, ${g.flagged} with flags`);
    console.log(`  start: ours - hers (frames)  ${stats(g.ds)}`);
    console.log(`  end:   ours - hers (frames)  ${stats(g.de)}`);
    if (g.rows.length) {
      console.log(`  off by more than 15 frames (${g.rows.length}):`);
      for (const r of g.rows.slice(0, 20)) console.log(r);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
