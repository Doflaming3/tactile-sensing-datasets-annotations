// Batch auto-annotation (Jingyi's PR #1 request): "Run the detector over
// every episode of a dataset and save all annotations to the Hub in one
// commit, with a progress view and a list of episodes that failed or raised
// flags so the reviewer knows where to look first."
//
// This module is the run: it reads each episode (table, raw sidecars, the
// Hub's annotation file) and annotates it, merges the result with what the
// Hub already holds (human atoms kept, auto atoms replaced), applies the
// save rule, and reports. It writes nothing to the Hub. Through `stage` it
// can put each proposal into this browser's local copy of the episode (the
// slot the viewer edits, never over unsaved edits); the batch page commits
// the staged files in one Hub commit.
//
// Speed (Zheng: "not fast enough, do parallel processing"): `concurrency`
// episodes are handled at once. The read-and-annotate step of an episode
// is an EpisodeReader: the default one runs here through the injected
// loaders with its three fetches overlapping; the batch page injects one
// that hands the whole step to a Web Worker (a real thread; workerPool.ts,
// batchWorkers.ts), so parquet decoding, CSV parsing and detection of
// several episodes run on several cores while this thread only merges,
// stages and draws. A stopped run can be resumed: `resume` carries the rows
// already done, and their episodes are skipped.
import type { EpisodeData } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import type { LanguageAtom } from "@/types/language.types";

import {
  annotateEpisode,
  inputsFromEpisode,
  pickRawFiles,
  type AnnotateInputs,
  type AnnotateOptions,
  type AnnotateOutcome,
} from "./annotateEpisode";
import { atomsForSave, mergeAutoAtoms, sameAtomSet } from "./atomPolicy";
import type { DetectionThresholds } from "./eventDetection";
import type { ProfileSource, RigProfile } from "./rigProfile";
import { withTimeout } from "./timeLimit";

/** Bumped by hand when the detector's output changes; lands in the report
 * so a batch can be told apart from a later one. */
export const DETECTOR_VERSION = "sotac-annotator 2026-09-09";

export interface BatchLoaders {
  loadEpisode(episode: number): Promise<{ data?: EpisodeData; error?: string }>;
  /** every raw sidecar path in the dataset (listed once) */
  listRawFiles(): Promise<string[]>;
  fetchText(path: string): Promise<string>;
  /** the annotation file already on the Hub, or null */
  fetchExisting(episode: number): Promise<{ atoms: LanguageAtom[] } | null>;
  /** this browser's local copy of the episode's atoms (the viewer's edit
   * slot; unsaved edits live there), or null */
  readLocal?(episode: number): LanguageAtom[] | null;
  /** what the batch itself staged into that slot last time, or null: a
   * local copy equal to it was not edited by anyone */
  readStaged?(episode: number): LanguageAtom[] | null;
}

export type BatchStatus = "ok" | "no_tactile" | "failed";

/** Wall time of each stage of one episode, ms (the fetches overlap, so
 * they do not add up to `ms`). */
export interface BatchTiming {
  load: number;
  raw: number;
  hub: number;
  annotate: number;
}

export interface BatchRow {
  episode: number;
  status: BatchStatus;
  source: "raw" | "table" | null;
  rawFallback: boolean;
  flags: string[];
  events: number;
  /** atoms in the merged file (human + auto) */
  atoms: number;
  /** the merged file differs from what the Hub holds */
  changed: boolean;
  /** this browser holds unsaved edits of the episode; left untouched */
  localEdits: boolean;
  /** the merged file was written into this browser's local copy for review */
  staged: boolean;
  /** this row's file went to the Hub in a batch commit */
  committed?: boolean;
  error?: string;
  ms: number;
  timing?: BatchTiming;
  /** triage weight: what a reviewer should look at first */
  weight: number;
}

export interface BatchReport {
  schema: "batch-report/1";
  repoId: string;
  profile: {
    id: string;
    source: ProfileSource | null;
    verified: boolean;
    interpretation: boolean;
  };
  thresholds: Partial<DetectionThresholds>;
  useRaw: boolean;
  detectorVersion: string;
  /** episodes handled at once */
  concurrency: number;
  /** the episodes the run was asked for (a stopped run has fewer rows) */
  requested: number[];
  /** the dataset's commit on main when the run started; Commit sends it
   * as the parent so nothing committed in between is overwritten */
  baseSha?: string | null;
  startedAt: string;
  finishedAt: string;
  aborted: boolean;
  episodes: BatchRow[];
  summary: {
    total: number;
    ok: number;
    flagged: number;
    failed: number;
    noTactile: number;
    changed: number;
    staged: number;
    localEdits: number;
  };
}

/** How loudly a flag asks for a human. Result-level findings first, then
 * signal warnings, then capability notes; base_mode is not a finding. */
export const FLAG_WEIGHTS: Record<string, number> = {
  failed_attempt: 5,
  sustained_slide: 4,
  hesitation: 3,
  short_transport: 3,
  weak_contact: 2,
  air_grasp: 2,
  post_task_contact: 2,
  residual_suspect: 2,
  unlabeled_transition: 1,
  no_contact: 1,
  no_layout: 1,
  no_gripper: 1,
  no_arm: 1,
  no_screen_reference: 1,
  profile_unverified: 1,
  base_mode: 0,
};
export const RAW_FALLBACK_WEIGHT = 1;

export function flagKind(flag: string): string {
  return flag.split("@")[0];
}

export function flagWeight(flags: string[], rawFallback: boolean): number {
  let w = rawFallback ? RAW_FALLBACK_WEIGHT : 0;
  for (const f of flags) w += FLAG_WEIGHTS[flagKind(f)] ?? 1;
  return w;
}

/** Failed first, then the heaviest flags, then episode order. */
export function sortTriage(rows: BatchRow[]): BatchRow[] {
  const rank = (r: BatchRow): number =>
    r.status === "failed" ? 2 : r.status === "no_tactile" ? 1 : 0;
  return [...rows].sort(
    (a, b) => rank(b) - rank(a) || b.weight - a.weight || a.episode - b.episode,
  );
}

/** A row a reviewer should look at: it ran and raised something. */
export function isFlaggedRow(r: BatchRow): boolean {
  return r.status === "ok" && (r.weight > 0 || r.rawFallback);
}

/** Flag kinds by how many episodes raised them, most first. */
export function flagHistogram(
  rows: BatchRow[],
): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const kind of new Set(r.flags.map(flagKind)))
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/** Average stage times over the rows that carry a timing, ms. */
export function timingAverages(rows: BatchRow[]): BatchTiming | null {
  const timed = rows.filter((r) => r.timing);
  if (timed.length === 0) return null;
  const sum: BatchTiming = { load: 0, raw: 0, hub: 0, annotate: 0 };
  for (const r of timed) {
    sum.load += r.timing!.load;
    sum.raw += r.timing!.raw;
    sum.hub += r.timing!.hub;
    sum.annotate += r.timing!.annotate;
  }
  const n = timed.length;
  return {
    load: sum.load / n,
    raw: sum.raw / n,
    hub: sum.hub / n,
    annotate: sum.annotate / n,
  };
}

/** The episodes a stopped run still owes (a report written before the
 * `requested` list existed owes nothing). */
export function remainingEpisodes(report: BatchReport): number[] {
  const done = new Set(report.episodes.map((r) => r.episode));
  return (report.requested ?? []).filter((ep) => !done.has(ep));
}

// ---------------------------------------------------------------- reading

export type AnnotateFn = (
  inputs: AnnotateInputs,
  opts: AnnotateOptions,
) => Promise<AnnotateOutcome>;

/** One episode read and annotated; what the merge step needs. */
export interface EpisodeRead {
  outcome: AnnotateOutcome;
  /** the Hub's annotation file, or null */
  existing: LanguageAtom[] | null;
  timing: BatchTiming;
}

export type EpisodeReader = (
  episode: number,
  rawPaths: string[],
) => Promise<EpisodeRead>;

/** The read-and-annotate step through loaders: the episode table, its raw
 * sidecar texts and the Hub file fetched together, then the detector. Runs
 * wherever it is called — on the main thread, or inside a worker with that
 * worker's own loaders. */
/** How long one episode's read — its fetches and the detector together —
 * may take before its row fails: on this thread, inside a worker, and on
 * the worker's fallback alike, so a stalled fetch costs one row, never
 * the run. A cold episode read takes ~10 s. */
export const EPISODE_READ_TIMEOUT_MS = 180_000;

export function episodeReader(
  loaders: Pick<BatchLoaders, "loadEpisode" | "fetchText" | "fetchExisting">,
  annotate: AnnotateFn,
  opts: {
    profile: RigProfile;
    thresholds: Partial<DetectionThresholds>;
    useRaw: boolean;
    /** give up on an episode after this long (0 or unset: wait) */
    timeoutMs?: number;
  },
): EpisodeReader {
  const limit = opts.timeoutMs ?? 0;
  const readOne = async (
    episode: number,
    rawPaths: string[],
  ): Promise<EpisodeRead> => {
    const timing: BatchTiming = { load: 0, raw: 0, hub: 0, annotate: 0 };
    // the work is started INSIDE the clock (a synchronous detector would
    // otherwise run before it)
    const timed = async <T>(
      key: keyof BatchTiming,
      work: () => Promise<T>,
    ): Promise<T> => {
      const s = performance.now();
      try {
        return await work();
      } finally {
        timing[key] = performance.now() - s;
      }
    };
    // the three reads of an episode do not depend on each other
    const [loaded, rawTexts, existingFile] = await Promise.all([
      timed("load", () => loaders.loadEpisode(episode)),
      timed("raw", () =>
        opts.useRaw && rawPaths.length
          ? Promise.all(rawPaths.map((p) => loaders.fetchText(p)))
          : Promise.resolve<string[] | null>(null),
      ),
      timed("hub", () => loaders.fetchExisting(episode)),
    ]);
    if (!loaded.data) throw new Error(loaded.error || "episode did not load");
    const outcome = await timed("annotate", () =>
      annotate(inputsFromEpisode(loaded.data!, rawTexts), {
        profile: opts.profile,
        thresholds: opts.thresholds,
        episodeIndex: episode,
        useRaw: opts.useRaw,
      }),
    );
    return { outcome, existing: existingFile?.atoms ?? null, timing };
  };
  return (episode, rawPaths) =>
    withTimeout(
      readOne(episode, rawPaths),
      limit,
      `no answer in ${Math.round(limit / 1000)} s (a stalled fetch, most likely)`,
    );
}

// ---------------------------------------------------------------- the run

export interface BatchRunOptions {
  repoId: string;
  episodes: number[];
  profile: RigProfile;
  profileSource: ProfileSource | null;
  thresholds: Partial<DetectionThresholds>;
  useRaw: boolean;
  loaders: BatchLoaders;
  onProgress?: (row: BatchRow, done: number, total: number) => void;
  /** an episode's work begins (for an in-flight display) */
  onStart?: (episode: number) => void;
  signal?: AbortSignal;
  /** injectable clock for reproducible tests */
  now?: () => Date;
  /** write a changed episode's merged atoms into the browser's local copy;
   * false when the write did not happen */
  stage?: (episode: number, atoms: LanguageAtom[]) => boolean;
  /** episodes handled at once — default 1 */
  concurrency?: number;
  /** the detector step of the default reader — default annotateEpisode
   * on this thread */
  annotate?: AnnotateFn;
  /** the whole read-and-annotate step (the batch page's worker pool);
   * default: episodeReader over `loaders` and `annotate` */
  readEpisode?: EpisodeReader;
  /** the default reader's deadline per episode (the batch page passes
   * EPISODE_READ_TIMEOUT_MS); unset: wait */
  readTimeoutMs?: number;
  /** the dataset's commit on main at the start of a fresh run */
  baseSha?: string | null;
  /** continue a stopped run: the rows already done (their episodes are
   * skipped), the files they staged, the original start time and the
   * original base version */
  resume?: {
    rows: BatchRow[];
    files?: Map<number, LanguageAtom[]>;
    startedAt?: string;
    baseSha?: string | null;
  };
}

/** What a Commit sends: every staged, not yet committed row's local copy
 * (the reviewer's adjustments included; the run's own file when the copy
 * is gone), each through the save rule for the active profile. */
export function entriesForCommit(
  report: BatchReport,
  readLocal: (episode: number) => LanguageAtom[] | null,
  files: Map<number, LanguageAtom[]> | undefined,
  profile: RigProfile | null,
): {
  entries: Array<{ episodeId: number; atoms: LanguageAtom[] }>;
  missing: number[];
} {
  const entries: Array<{ episodeId: number; atoms: LanguageAtom[] }> = [];
  const missing: number[] = [];
  for (const r of report.episodes) {
    if (!r.staged || r.committed) continue;
    const atoms = readLocal(r.episode) ?? files?.get(r.episode) ?? null;
    if (atoms)
      entries.push({
        episodeId: r.episode,
        atoms: atomsForSave(atoms, profile),
      });
    else missing.push(r.episode);
  }
  return { entries, missing };
}

export interface BatchOutput {
  report: BatchReport;
  /** merged, save-filtered atoms per episode whose file changed */
  files: Map<number, LanguageAtom[]>;
}

export async function runBatch(opts: BatchRunOptions): Promise<BatchOutput> {
  const now = opts.now ?? (() => new Date());
  const annotate: AnnotateFn =
    opts.annotate ?? (async (inputs, o) => annotateEpisode(inputs, o));
  const read: EpisodeReader =
    opts.readEpisode ??
    episodeReader(opts.loaders, annotate, {
      profile: opts.profile,
      thresholds: opts.thresholds,
      useRaw: opts.useRaw,
      timeoutMs: opts.readTimeoutMs,
    });
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const priorRows = opts.resume?.rows ?? [];
  const doneBefore = new Set(priorRows.map((r) => r.episode));
  const queue = opts.episodes.filter((ep) => !doneBefore.has(ep));
  const startedAt = opts.resume?.startedAt ?? now().toISOString();
  const rows: BatchRow[] = [...priorRows];
  const files = new Map<number, LanguageAtom[]>(opts.resume?.files ?? []);
  const total = opts.episodes.length;
  let done = priorRows.length;
  let next = 0;
  let aborted = false;
  // the sidecar listing is one request for the whole run
  let rawListP: Promise<string[]> | null = null;
  const rawList = () => (rawListP ??= opts.loaders.listRawFiles());

  const processOne = async (episode: number): Promise<BatchRow> => {
    const t0 = performance.now();
    try {
      const rawPaths = opts.useRaw
        ? pickRawFiles(await rawList(), episode)
        : [];
      const {
        outcome,
        existing: existingFile,
        timing,
      } = await read(episode, rawPaths);
      const existing = existingFile ?? [];
      const merged = atomsForSave(
        mergeAutoAtoms(existing, outcome.recordedAtoms),
        opts.profile,
      );
      const changed =
        !(existing.length === 0 && merged.length === 0) &&
        !sameAtomSet(existing, merged);
      if (changed) files.set(episode, merged);
      // unsaved edits in this browser: a local copy that is neither what
      // the Hub holds, nor what the batch itself staged last time, nor
      // already this very proposal — an emptied copy included (someone
      // cleared the episode on purpose). The batch never overwrites them.
      const local = opts.loaders.readLocal?.(episode) ?? null;
      const stagedBefore = opts.loaders.readStaged?.(episode) ?? null;
      const localEdits =
        local !== null &&
        !sameAtomSet(local, existing) &&
        !sameAtomSet(local, merged) &&
        !(stagedBefore !== null && sameAtomSet(local, stagedBefore));
      const staged =
        changed && !localEdits && (opts.stage?.(episode, merged) ?? false);
      return {
        episode,
        status: outcome.status,
        source: outcome.source,
        rawFallback: outcome.rawFallback,
        flags: outcome.flags,
        events: outcome.events,
        atoms: merged.length,
        changed,
        localEdits,
        staged,
        ms: performance.now() - t0,
        timing,
        weight: flagWeight(outcome.flags, outcome.rawFallback),
      };
    } catch (e) {
      return {
        episode,
        status: "failed",
        source: null,
        rawFallback: false,
        flags: [],
        events: 0,
        atoms: 0,
        changed: false,
        localEdits: false,
        staged: false,
        error: e instanceof Error ? e.message : String(e),
        ms: performance.now() - t0,
        weight: 0,
      };
    }
  };

  // `concurrency` slots pull episodes off the queue until it is empty or
  // a stop is requested; an episode in flight always finishes. Slots start
  // one after another: a slot's first episode is a cold start (a fresh
  // thread decodes the whole parquet file), and several cold starts at
  // once were a memory peak that killed the renderer.
  let previousFirst: Promise<void> = Promise.resolve();
  const slot = async (): Promise<void> => {
    const gate = previousFirst;
    let releaseFirst: () => void = () => {};
    previousFirst = new Promise<void>((r) => (releaseFirst = r));
    await gate;
    try {
      for (;;) {
        if (opts.signal?.aborted) {
          aborted = true;
          return;
        }
        const i = next++;
        if (i >= queue.length) return;
        const episode = queue[i];
        opts.onStart?.(episode);
        const row = await processOne(episode);
        rows.push(row);
        done++;
        opts.onProgress?.(row, done, total);
        releaseFirst();
      }
    } finally {
      releaseFirst();
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, queue.length)) },
      slot,
    ),
  );

  const report: BatchReport = {
    schema: "batch-report/1",
    repoId: opts.repoId,
    profile: {
      id: opts.profile.id,
      source: opts.profileSource,
      verified: opts.profile.verified,
      interpretation: opts.profile.interpretation,
    },
    thresholds: opts.thresholds,
    useRaw: opts.useRaw,
    detectorVersion: DETECTOR_VERSION,
    concurrency,
    requested: [...opts.episodes],
    baseSha: opts.resume
      ? (opts.resume.baseSha ?? null)
      : (opts.baseSha ?? null),
    startedAt,
    finishedAt: now().toISOString(),
    aborted,
    episodes: sortTriage(rows),
    summary: {
      total,
      ok: rows.filter((r) => r.status === "ok").length,
      flagged: rows.filter(isFlaggedRow).length,
      failed: rows.filter((r) => r.status === "failed").length,
      noTactile: rows.filter((r) => r.status === "no_tactile").length,
      // from the rows: after a resume the files map holds only this run's
      changed: rows.filter((r) => r.changed).length,
      staged: rows.filter((r) => r.staged).length,
      localEdits: rows.filter((r) => r.localEdits).length,
    },
  };
  return { report, files };
}
