// How does the Hub answer when the batch's per-episode fetches run in
// parallel? Fires the annotation-file GETs of every episode (the path of
// review item 1) at rising concurrency, then the raw sidecar CSVs, and
// tallies the statuses, the errors and the latencies. Read-only, public
// files; stops a level early when the Hub starts refusing.
//
//   bun scripts/hub-burst-test.ts [--repo Jingyi-Z/sotac] [--episodes 163] [--levels 4,8,16,32,64]
import { listFiles } from "../visualizer/node_modules/@huggingface/hub";

const HUB = "https://huggingface.co";

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

interface Outcome {
  status: number | "error";
  ms: number;
  retryAfter?: string | null;
  error?: string;
  bytes?: number;
}

async function one(url: string, readBody: boolean): Promise<Outcome> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { cache: "no-store" });
    let bytes = 0;
    if (readBody && res.ok) bytes = (await res.arrayBuffer()).byteLength;
    else await res.arrayBuffer().catch(() => undefined);
    return {
      status: res.status,
      ms: performance.now() - t0,
      retryAfter: res.headers.get("retry-after"),
      bytes,
    };
  } catch (e) {
    return { status: "error", ms: performance.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<Outcome>): Promise<Outcome[]> {
  const out: Outcome[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const k = i++;
        if (k >= items.length) return;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
}

function report(label: string, outs: Outcome[], seconds: number): { refused: number } {
  const hist = new Map<string, number>();
  for (const o of outs) hist.set(String(o.status), (hist.get(String(o.status)) ?? 0) + 1);
  const lat = outs.map((o) => o.ms);
  const refused = outs.filter((o) => o.status === 429 || (typeof o.status === "number" && o.status >= 500) || o.status === "error").length;
  const retry = outs.find((o) => o.retryAfter)?.retryAfter ?? null;
  const errs = [...new Set(outs.filter((o) => o.error).map((o) => o.error))].slice(0, 3);
  const mb = outs.reduce((a, o) => a + (o.bytes ?? 0), 0) / 1048576;
  console.log(
    `${label}: ${outs.length} requests in ${seconds.toFixed(1)} s (${(outs.length / seconds).toFixed(1)}/s${mb ? `, ${mb.toFixed(1)} MB` : ""}) — statuses ${JSON.stringify(Object.fromEntries(hist))} — latency p50 ${pct(lat, 0.5).toFixed(0)} ms p95 ${pct(lat, 0.95).toFixed(0)} ms max ${Math.max(...lat).toFixed(0)} ms${retry ? ` — retry-after ${retry}` : ""}${errs.length ? ` — errors: ${errs.join(" | ")}` : ""}`,
  );
  return { refused };
}

async function main() {
  const repo = arg("repo", "Jingyi-Z/sotac");
  const nEp = Number(arg("episodes", "163"));
  const levels = arg("levels", "4,8,16,32,64").split(",").map(Number);
  const annotationUrls = Array.from({ length: nEp }, (_, ep) => `${HUB}/datasets/${repo}/resolve/main/annotations/episode_${String(ep).padStart(6, "0")}.json`);

  console.log(`== annotation files (the item-1 path): ${nEp} GETs per level`);
  for (const n of levels) {
    const t0 = performance.now();
    const outs = await pool(annotationUrls, n, (u) => one(u, true));
    const { refused } = report(`  concurrency ${n}`, outs, (performance.now() - t0) / 1000);
    if (refused > 0) {
      console.log(`  -> the Hub refused ${refused} of ${outs.length} at concurrency ${n}; stopping this phase here`);
      break;
    }
  }

  console.log(`== raw sidecar CSVs (what the workers pull beside the annotation file)`);
  const csvs: string[] = [];
  for await (const f of listFiles({ repo: { type: "dataset", name: repo }, recursive: true })) {
    if (f.type === "file" && /sensors\/.*\.csv$/.test(f.path)) csvs.push(f.path);
  }
  const sample = csvs.slice(0, 48);
  const csvUrls = sample.map((p) => `${HUB}/datasets/${repo}/resolve/main/${p}`);
  console.log(`  ${csvs.length} sidecar files in the repo; fetching ${sample.length} full bodies per level`);
  for (const n of [4, 8, 16]) {
    const t0 = performance.now();
    const outs = await pool(csvUrls, n, (u) => one(u, true));
    const { refused } = report(`  concurrency ${n}`, outs, (performance.now() - t0) / 1000);
    if (refused > 0) {
      console.log(`  -> refused ${refused} at concurrency ${n}; stopping`);
      break;
    }
  }

  console.log(`== the batch's real mix: annotation file + 2 sidecars per episode, 4 lanes, ${Math.min(nEp, 40)} episodes`);
  const mix: string[] = [];
  for (let ep = 0; ep < Math.min(nEp, 40); ep++) {
    mix.push(annotationUrls[ep]);
    for (const p of csvs.filter((c) => c.includes(`episode_${String(ep).padStart(6, "0")}/`)).slice(0, 2)) mix.push(`${HUB}/datasets/${repo}/resolve/main/${p}`);
  }
  const t0 = performance.now();
  const outs = await pool(mix, 4 * 3, (u) => one(u, true));
  report(`  12 in flight`, outs, (performance.now() - t0) / 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
