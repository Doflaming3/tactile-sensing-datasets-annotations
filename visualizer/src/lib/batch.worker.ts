// Web Worker entry for the batch page (driven by lib/workerPool.ts): one
// episode end to end on this thread — parquet table, raw sidecars, the
// Hub's annotation file, the detector — so the main thread only merges,
// stages and draws. The worker keeps the profile it was last sent; the
// Hub token and the dataset root arrive with each job (a worker has no
// localStorage and its own copy of the module state).
import { getEpisodeDataSafe } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { setAuthTokenOverride } from "@/utils/auth";
import { fetchAnnotationsFromHub } from "@/utils/hubCommit";
import { setDatasetPathPrefix } from "@/utils/versionUtils";

import { annotateEpisode, fetchRepoText } from "./annotateEpisode";
import {
  EPISODE_READ_TIMEOUT_MS,
  episodeReader,
  type EpisodeRead,
} from "./batchAnnotate";
import type { EpisodeJob } from "./batchJobs";
import type { RigProfile } from "./rigProfile";
import type { PoolRequest, PoolResponse } from "./workerPool";

let profile: RigProfile | null = null;

self.addEventListener(
  "message",
  async (ev: MessageEvent<PoolRequest<EpisodeJob>>) => {
    const req = ev.data;
    if (!req || typeof req.id !== "number") return;
    if (req.profile) profile = req.profile;
    let res: PoolResponse<EpisodeRead>;
    try {
      if (!profile) throw new Error("the worker was given no profile");
      const job = req.job;
      setAuthTokenOverride(job.token);
      setDatasetPathPrefix(job.root);
      const repoId = `${job.org}/${job.dataset}`;
      const read = episodeReader(
        {
          loadEpisode: (ep) => getEpisodeDataSafe(job.org, job.dataset, ep),
          fetchText: (path) => fetchRepoText(repoId, job.root, path),
          fetchExisting: (ep) => fetchAnnotationsFromHub(repoId, ep),
        },
        async (inputs, opts) => annotateEpisode(inputs, opts),
        {
          profile,
          thresholds: job.thresholds,
          useRaw: job.useRaw,
          // a stalled fetch fails this job with a message and the worker
          // lives on; the pool's own, longer limit is for a thread that
          // cannot even answer
          timeoutMs: EPISODE_READ_TIMEOUT_MS,
        },
      );
      res = {
        id: req.id,
        ok: true,
        result: await read(job.episode, job.rawPaths),
      };
    } catch (e) {
      res = {
        id: req.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    self.postMessage(res);
  },
);
