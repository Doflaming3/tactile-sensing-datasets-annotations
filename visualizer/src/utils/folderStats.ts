// Cross-episode statistics for per-episode-folder datasets. Each folder is a
// self-contained 1-episode v3 dataset, so whole-dataset numbers must be
// aggregated client-side:
//   * episode lengths — one tiny meta/info.json fetch per folder (cheap,
//     done automatically when the Statistics tab opens in folder mode);
//   * tactile aggregates — needs every folder's data parquet (MBs each), so
//     it is opt-in behind a button (see TactileAggregate in tactile-panel).

import { authHeaders } from "./auth";
import {
  fetchParquetFile,
  readParquetAsObjects,
} from "./parquetUtils";
import type {
  EpisodeLengthStats,
  EpisodeLengthInfo,
} from "@/app/[org]/[dataset]/[episode]/fetch-data";

const DATASET_URL =
  process.env.DATASET_URL || "https://huggingface.co/datasets";

function folderUrl(repoId: string, folder: string, rel: string): string {
  return `${DATASET_URL}/${repoId}/resolve/main/${folder}/${rel}`;
}

type FolderInfo = {
  folder: string;
  fps: number;
  frames: number;
  features: Record<string, { dtype: string; shape: number[] }>;
};

const infoCache = new Map<string, Promise<FolderInfo | null>>();

async function loadFolderInfo(
  repoId: string,
  folder: string,
): Promise<FolderInfo | null> {
  const key = `${repoId}/${folder}`;
  const hit = infoCache.get(key);
  if (hit) return hit;
  const p = (async () => {
    try {
      const res = await fetch(folderUrl(repoId, folder, "meta/info.json"), {
        headers: authHeaders(),
      });
      if (!res.ok) return null;
      const j = await res.json();
      return {
        folder,
        fps: Number(j.fps) || 30,
        frames: Number(j.total_frames) || 0,
        features: j.features ?? {},
      };
    } catch {
      return null;
    }
  })();
  infoCache.set(key, p);
  return p;
}

function buildHistogram(
  lengths: number[],
): { binLabel: string; count: number }[] {
  if (!lengths.length) return [];
  const min = Math.min(...lengths);
  const max = Math.max(...lengths);
  if (max - min < 1e-9) {
    return [{ binLabel: `${min.toFixed(1)}s`, count: lengths.length }];
  }
  const nBins = Math.min(6, lengths.length);
  const w = (max - min) / nBins;
  return Array.from({ length: nBins }, (_, b) => {
    const lo = min + b * w;
    const hi = lo + w;
    const count = lengths.filter(
      (v) => v >= lo && (b === nBins - 1 ? v <= hi : v < hi),
    ).length;
    return { binLabel: `${lo.toFixed(1)}–${hi.toFixed(1)}s`, count };
  });
}

export async function loadFolderEpisodeLengths(
  repoId: string,
  folders: string[],
): Promise<{
  stats: EpisodeLengthStats;
  totalFrames: number;
  fps: number;
} | null> {
  const infos = (
    await Promise.all(folders.map((f) => loadFolderInfo(repoId, f)))
  ).filter((x): x is FolderInfo => x !== null);
  if (!infos.length) return null;
  const fps = infos[0].fps || 30;
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const all: EpisodeLengthInfo[] = infos.map((inf, i) => ({
    episodeIndex: i,
    frames: inf.frames,
    lengthSeconds: round1(inf.frames / (inf.fps || fps)),
  }));
  const lengths = all.map((e) => e.lengthSeconds);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const sorted = [...lengths].sort((a, b) => a - b);
  const median =
    sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const std = Math.sqrt(
    lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length,
  );
  const byLen = [...all].sort((a, b) => a.lengthSeconds - b.lengthSeconds);
  return {
    stats: {
      shortestEpisodes: byLen.slice(0, 5),
      longestEpisodes: byLen.slice(-5).reverse(),
      allEpisodeLengths: all,
      meanEpisodeLength: round1(mean),
      medianEpisodeLength: round1(median),
      stdEpisodeLength: round1(std),
      episodeLengthHistogram: buildHistogram(lengths),
    },
    totalFrames: infos.reduce((a, b) => a + b.frames, 0),
    fps,
  };
}

// ---- tactile aggregation (opt-in, heavy) -----------------------------------

const CONTACT_THR_N = 0.05;

export type FolderTactileRow = {
  channel: string;
  peak: number;
  peakFolder: string;
  peakT: number;
  meanContactPct: number;
  maxSumFz: number;
  episodes: number;
};

type PerChannelAcc = {
  peak: number;
  peakFolder: string;
  peakT: number;
  contactPcts: number[];
  maxSumFz: number;
};

export async function computeFolderTactileAggregate(
  repoId: string,
  folders: string[],
  onProgress: (done: number, total: number, folder: string) => void,
): Promise<FolderTactileRow[]> {
  const acc = new Map<string, PerChannelAcc>();

  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    onProgress(i, folders.length, folder);
    const info = await loadFolderInfo(repoId, folder);
    if (!info) continue;
    const sensorCols = Object.entries(info.features)
      .filter(
        ([k, f]) =>
          k.startsWith("observation.sensors.") && (f.shape?.length ?? 0) >= 2,
      )
      .map(([k]) => k);
    if (!sensorCols.length) continue;
    let rows: Record<string, unknown>[] = [];
    try {
      const buf = await fetchParquetFile(
        folderUrl(repoId, folder, "data/chunk-000/file-000.parquet"),
      );
      rows = await readParquetAsObjects(buf, ["timestamp", ...sensorCols]);
    } catch {
      continue;
    }
    for (const col of sensorCols) {
      // channels: (F,P,3) with small F -> per-finger; else single
      const first = rows.find((r) => r[col] != null)?.[col] as
        | number[][][]
        | number[][]
        | undefined;
      if (!first) continue;
      const isMulti =
        Array.isArray(first) &&
        Array.isArray(first[0]) &&
        Array.isArray((first[0] as number[][])[0]) &&
        first.length <= 4;
      const nCh = isMulti ? first.length : 1;
      for (let k = 0; k < nCh; k++) {
        const chName =
          (isMulti ? `${col}[${k}]` : col).replace(
            "observation.sensors.",
            "",
          );
        let a = acc.get(chName);
        if (!a) {
          a = {
            peak: 0,
            peakFolder: "",
            peakT: 0,
            contactPcts: [],
            maxSumFz: 0,
          };
          acc.set(chName, a);
        }
        let contact = 0;
        let n = 0;
        for (const r of rows) {
          const cell = r[col] as number[][][] | number[][] | undefined;
          if (!cell) continue;
          const taxels = (isMulti
            ? (cell as number[][][])[k]
            : (cell as number[][])) as number[][];
          if (!taxels) continue;
          n++;
          let framePeak = 0;
          let sumFz = 0;
          for (const p of taxels) {
            const m = Math.hypot(Number(p[0]), Number(p[1]), Number(p[2]));
            sumFz += Number(p[2]);
            if (m > framePeak) framePeak = m;
          }
          if (framePeak >= CONTACT_THR_N) contact++;
          if (sumFz > a.maxSumFz) a.maxSumFz = sumFz;
          if (framePeak > a.peak) {
            a.peak = framePeak;
            a.peakFolder = folder;
            a.peakT = Number(r.timestamp) || 0;
          }
        }
        if (n) a.contactPcts.push((100 * contact) / n);
      }
    }
  }
  onProgress(folders.length, folders.length, "");
  return [...acc.entries()].map(([channel, a]) => ({
    channel,
    peak: a.peak,
    peakFolder: a.peakFolder,
    peakT: a.peakT,
    meanContactPct: a.contactPcts.length
      ? a.contactPcts.reduce((x, y) => x + y, 0) / a.contactPcts.length
      : 0,
    maxSumFz: a.maxSumFz,
    episodes: a.contactPcts.length,
  }));
}
