// Browser side of the worker pool: real Web Workers when the platform has
// them (the batch page), nothing otherwise (runBatch then reads episodes
// on the main thread). A crashed worker's jobs run on the main thread, so
// a broken worker bundle costs speed, not results.
import { getEpisodeDataSafe } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { getAuthToken } from "@/utils/auth";
import { fetchAnnotationsFromHub } from "@/utils/hubCommit";

import { annotateEpisode, fetchRepoText } from "./annotateEpisode";
import {
  episodeReader,
  type EpisodeRead,
  type EpisodeReader,
} from "./batchAnnotate";
import type { EpisodeJob } from "./batchJobs";
import { WorkerPool, type WorkerLike } from "./workerPool";

export function coreCount(): number {
  return typeof navigator !== "undefined" && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 2;
}

/** Zheng's rule: half the machine's cores, at most 4. */
export function defaultWorkerCount(): number {
  return Math.min(4, Math.max(1, Math.floor(coreCount() / 2)));
}

/** The per-episode pipeline on this thread, from a job: the pool's
 * fallback, and the whole story when there are no workers. */
export function readEpisodeHere(job: EpisodeJob): Promise<EpisodeRead> {
  const repoId = `${job.org}/${job.dataset}`;
  return episodeReader(
    {
      loadEpisode: (ep) => getEpisodeDataSafe(job.org, job.dataset, ep),
      fetchText: (path) => fetchRepoText(repoId, job.root, path),
      fetchExisting: (ep) => fetchAnnotationsFromHub(repoId, ep),
    },
    async (inputs, opts) => annotateEpisode(inputs, opts),
    { profile: job.profile, thresholds: job.thresholds, useRaw: job.useRaw },
  )(job.episode, job.rawPaths);
}

export type EpisodePool = WorkerPool<EpisodeJob, EpisodeRead>;

export function createBrowserPool(
  size: number,
  onWorkerError?: (message: string, jobs: number, restartable: boolean) => void,
): EpisodePool | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new WorkerPool<EpisodeJob, EpisodeRead>(
      size,
      () =>
        new Worker(
          new URL("./batch.worker.ts", import.meta.url),
        ) as unknown as WorkerLike,
      // a thread that stops answering (not a crash) is given up after
      // three minutes — a cold episode read takes ~10 s; a dead worker is
      // terminated and replaced up to twice, so a passing failure (a
      // stalled fetch) does not cost a thread for the rest of the page's
      // life, while one that keeps dying stays dead
      {
        fallback: readEpisodeHere,
        onWorkerError,
        jobTimeoutMs: 180_000,
        maxRespawns: 2,
      },
    );
  } catch {
    return null;
  }
}

/** An EpisodeReader for runBatch: every episode goes to the pool. */
export function poolReader(
  pool: EpisodePool,
  ctx: Omit<EpisodeJob, "episode" | "rawPaths" | "token">,
): EpisodeReader {
  return (episode, rawPaths) =>
    pool.run({ ...ctx, token: getAuthToken(), episode, rawPaths });
}
