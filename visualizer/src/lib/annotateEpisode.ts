// One episode through the auto-labeler, as a plain function: the same
// pipeline the Annotations tab's panel runs (30 Hz table series or the raw
// sidecar series clipped to the episode, the detector, the recording
// policy), with no React and no network, so the panel and the batch runner
// (batchAnnotate.ts) share it and cannot drift apart.
import type {
  EpisodeData,
  SensorFramesMap,
  SensorTaxelFrames,
} from "@/app/[org]/[dataset]/[episode]/fetch-data";
import type { LanguageAtom } from "@/types/language.types";
import { authHeaders } from "@/utils/auth";
import { buildVersionedUrl } from "@/utils/versionUtils";

import {
  buildSeriesFromRawCsvs,
  buildSeriesFromSensorFrames,
  clipSeries,
  detectEvents,
  resultToRecordedAtoms,
  type ArmMotionSeries,
  type AutoLabelResult,
  type DetectionThresholds,
  type GripperSeries,
  type TactileSeries,
} from "./eventDetection";
import { layoutFor, type RigProfile } from "./rigProfile";

// ---------------------------------------------------------------- inputs

/** Jaw trajectory from the flat chart rows: the observation column whose
 * name mentions the gripper (never the action). */
export function gripperSeriesFrom(
  rows: Record<string, number>[] | undefined,
): GripperSeries | null {
  if (!rows || rows.length === 0) return null;
  const key = Object.keys(rows[0]).find(
    (k) => /gripper/i.test(k) && !/^action/i.test(k),
  );
  if (!key) return null;
  const t: number[] = [];
  const pos: number[] = [];
  for (const r of rows) {
    const ts = r["timestamp"];
    const v = r[key];
    if (typeof ts === "number" && typeof v === "number") {
      t.push(ts);
      pos.push(v);
    }
  }
  return t.length > 2 ? { t, pos } : null;
}

/** Arm joint positions (gripper excluded) — the transport anchor reads the
 * arm starting to CARRY, which grip force cannot see. */
export function armSeriesFrom(
  rows: Record<string, number>[] | undefined,
): ArmMotionSeries | null {
  if (!rows || rows.length === 0) return null;
  const keys = Object.keys(rows[0]).filter(
    (k) => /\.pos$/i.test(k) && !/^action/i.test(k) && !/gripper/i.test(k),
  );
  if (keys.length === 0) return null;
  const t: number[] = [];
  const joints: number[][] = [];
  for (const r of rows) {
    const ts = r["timestamp"];
    if (typeof ts !== "number") continue;
    const row = keys.map((k) => (typeof r[k] === "number" ? r[k] : NaN));
    if (row.some((v) => Number.isNaN(v))) continue;
    t.push(ts);
    joints.push(row);
  }
  return t.length > 2 ? { t, joints } : null;
}

/** The tactile feature of the episode (first `observation.sensors.*` with
 * two or more dims and at least one frame). */
export function tactileEntry(
  sensorFrames: SensorFramesMap | undefined,
): SensorTaxelFrames | null {
  if (!sensorFrames) return null;
  return (
    Object.values(sensorFrames).find(
      (s) => s.shape.length >= 2 && s.frames.length > 0,
    ) ?? null
  );
}

export function taxelCount(entry: SensorTaxelFrames): number {
  return entry.shape.length >= 3 ? entry.shape[1] : entry.shape[0];
}

/** The raw sidecar files of one episode from the repo listing. Multi-episode
 * datasets carry one folder per episode; per-episode-folder datasets carry
 * the CSVs at the root, so those fall back to every unscoped path. */
export function pickRawFiles(all: string[], episodeId: number): string[] {
  const epTag = `episode_${String(episodeId).padStart(6, "0")}/`;
  let files = all.filter((p) => p.includes(epTag)).sort();
  if (files.length === 0 && !all.some((p) => /episode_\d{6}\//.test(p))) {
    files = all.slice().sort();
  }
  return files;
}

/** Repo-relative path of a sidecar as the URL builder wants it (the
 * listing paths carry the ?root= prefix, the builder prepends it). */
export function rawFileRelPath(
  root: string | null | undefined,
  path: string,
): string {
  return root ? path.slice(root.replace(/^\/+|\/+$/g, "").length + 1) : path;
}

export async function fetchRepoText(
  repoId: string,
  root: string | null | undefined,
  path: string,
): Promise<string> {
  const res = await fetch(
    buildVersionedUrl(repoId, "v3.0", rawFileRelPath(root, path)),
    { headers: authHeaders() },
  );
  if (!res.ok) throw new Error(`${res.status} on ${path}`);
  return res.text();
}

// ---------------------------------------------------------------- the run

export interface AnnotateInputs {
  sensorFrames: SensorFramesMap | undefined;
  gripper: GripperSeries | null;
  arm: ArmMotionSeries | null;
  /** raw sidecar texts in finger order; null/empty = none available */
  rawCsvTexts?: string[] | null;
}

export interface AnnotateOptions {
  profile: RigProfile;
  thresholds?: Partial<DetectionThresholds>;
  episodeIndex: number;
  /** prefer the raw sidecar series (default true); the 30 Hz table is the
   * fallback and is reported as such */
  useRaw?: boolean;
}

export interface AnnotateOutcome {
  status: "ok" | "no_tactile";
  /** which series the detector ran on */
  source: "raw" | "table" | null;
  /** raw was wanted but unavailable: the 30 Hz table was used instead */
  rawFallback: boolean;
  rateHz: number;
  samples: number;
  result: AutoLabelResult | null;
  /** the annotation set's share of the result (recording policy) */
  recordedAtoms: LanguageAtom[];
  flags: string[];
  events: number;
  ms: number;
}

const EMPTY: AnnotateOutcome = {
  status: "no_tactile",
  source: null,
  rawFallback: false,
  rateHz: 0,
  samples: 0,
  result: null,
  recordedAtoms: [],
  flags: [],
  events: 0,
  ms: 0,
};

export function annotateEpisode(
  inputs: AnnotateInputs,
  opts: AnnotateOptions,
): AnnotateOutcome {
  const t0 = performance.now();
  const useRaw = opts.useRaw ?? true;
  const entry = tactileEntry(inputs.sensorFrames);
  const nTaxels = entry ? taxelCount(entry) : 52;
  const layout = layoutFor(opts.profile, nTaxels)?.points ?? null;

  const series30: TactileSeries | null = entry
    ? buildSeriesFromSensorFrames(
        entry.frames,
        entry.timestamps,
        layout,
        inputs.gripper,
        opts.profile,
      )
    : null;

  let series: TactileSeries | null = series30;
  let source: "raw" | "table" | null = series30 ? "table" : null;
  let rawFallback = false;
  if (useRaw) {
    const texts = inputs.rawCsvTexts ?? [];
    const raw = texts.length
      ? buildSeriesFromRawCsvs(texts, layout, inputs.gripper, {
          profile: opts.profile,
        })
      : null;
    if (raw) {
      // sidecars record through the inter-episode reset: clip to the
      // main table's window before detecting
      const tEnd = series30
        ? series30.t[series30.t.length - 1] + 0.1
        : raw.t[raw.t.length - 1];
      series = clipSeries(raw, tEnd);
      source = "raw";
    } else {
      rawFallback = true;
    }
  }
  if (!series) return { ...EMPTY, rawFallback, ms: performance.now() - t0 };

  const result = detectEvents(
    series,
    inputs.gripper,
    opts.thresholds ?? {},
    inputs.arm,
    { profile: opts.profile, episodeIndex: opts.episodeIndex },
  );
  return {
    status: "ok",
    source,
    rawFallback,
    rateHz: series.rateHz,
    samples: series.t.length,
    result,
    recordedAtoms: resultToRecordedAtoms(result),
    flags: result.flags,
    events: result.events.length,
    ms: performance.now() - t0,
  };
}

/** Convenience for callers holding a loaded episode. */
export function inputsFromEpisode(
  data: Pick<EpisodeData, "sensorFrames" | "flatChartData">,
  rawCsvTexts?: string[] | null,
): AnnotateInputs {
  return {
    sensorFrames: data.sensorFrames,
    gripper: gripperSeriesFrom(data.flatChartData),
    arm: armSeriesFrom(data.flatChartData),
    rawCsvTexts,
  };
}
