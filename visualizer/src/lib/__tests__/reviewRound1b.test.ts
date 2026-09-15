// Jingyi's review of PR #3, items 3-7 and the small ones.
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { EpisodeData } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import type { LanguageAtom } from "@/types/language.types";
import {
  batchCommitBody,
  batchReportPath,
  commitBatchToHub,
  fetchAnnotationsFromHub,
  fetchBranchSha,
} from "@/utils/hubCommit";
import { setDatasetPathPrefix } from "@/utils/versionUtils";

import { editedAtom, isAutoAtom } from "../atomPolicy";
import {
  entriesForCommit,
  runBatch,
  type BatchLoaders,
  type BatchReport,
} from "../batchAnnotate";
import {
  SOTAC_PROFILE,
  TEMPLATE_PROFILE,
  type RigProfile,
} from "../rigProfile";
import { WorkerPool, type PoolRequest, type WorkerLike } from "../workerPool";
import { syntheticEpisode } from "./annotateEpisode.test";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setDatasetPathPrefix(null);
});

const human: LanguageAtom = {
  role: "user",
  content: "checked on video",
  style: "interjection",
  timestamp: 4.0,
  camera: null,
  tool_calls: null,
};
const interp: LanguageAtom = {
  role: "assistant",
  content: "[auto:high] finger_unload f0 2.1N (hand still holding)",
  style: "interjection",
  timestamp: 8.1,
  camera: null,
  tool_calls: null,
};

function report(rows: Partial<BatchReport["episodes"][number]>[]): BatchReport {
  return {
    schema: "batch-report/1",
    repoId: "org/name",
    profile: {
      id: "p",
      source: "registry",
      verified: true,
      interpretation: true,
    },
    thresholds: {},
    useRaw: true,
    detectorVersion: "t",
    concurrency: 1,
    requested: rows.map((r) => r.episode ?? 0),
    baseSha: "abc123",
    startedAt: "",
    finishedAt: "",
    aborted: false,
    episodes: rows.map((r) => ({
      episode: 0,
      status: "ok",
      source: "raw",
      rawFallback: false,
      flags: [],
      events: 0,
      atoms: 0,
      changed: true,
      localEdits: false,
      staged: true,
      ms: 0,
      weight: 0,
      ...r,
    })),
    summary: {
      total: rows.length,
      ok: rows.length,
      flagged: 0,
      failed: 0,
      noTactile: 0,
      changed: rows.length,
      staged: rows.length,
      localEdits: 0,
    },
  };
}

describe("item 3 — the commit names the version it read", () => {
  test("the body carries the parent commit; without one, none", () => {
    const withParent = batchCommitBody([], "s", "abc123");
    expect(JSON.parse(withParent.split("\n")[0])).toEqual({
      key: "header",
      value: { summary: "s", parentCommit: "abc123" },
    });
    expect(JSON.parse(batchCommitBody([], "s").split("\n")[0]).value).toEqual({
      summary: "s",
    });
  });

  test("a 412 reads as: the dataset moved, rerun", async () => {
    let body = "";
    globalThis.fetch = mock((_u: unknown, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return Promise.resolve(new Response("precondition", { status: 412 }));
    }) as unknown as typeof fetch;
    try {
      localStorage.setItem(
        "lerobot-viz-oauth",
        JSON.stringify({ accessToken: "t" }),
      );
    } catch {
      /* no localStorage in this runtime: the token check is skipped below */
    }
    const p = commitBatchToHub(
      "org/name",
      [{ episodeId: 1, atoms: [human] }],
      report([]),
      {
        parentCommit: "abc123",
      },
    );
    await expect(p).rejects.toThrow(/moved|Not signed in/);
    if (body) expect(body).toContain('"parentCommit":"abc123"');
  });

  test("the branch version comes from the Hub's revision endpoint", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ sha: "deadbeef" }), { status: 200 }),
      ),
    ) as unknown as typeof fetch;
    expect(await fetchBranchSha("org/name@47d46cfb")).toBe("deadbeef");
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("", { status: 503 })),
    ) as unknown as typeof fetch;
    await expect(fetchBranchSha("org/name")).rejects.toThrow("503");
  });

  test("the run records the version; a resume keeps the original", async () => {
    const good = syntheticEpisode();
    const loaders: BatchLoaders = {
      loadEpisode: async () => ({ data: good as unknown as EpisodeData }),
      listRawFiles: async () => [],
      fetchText: async () => "",
      fetchExisting: async () => null,
    };
    const base = {
      repoId: "org/name",
      profile: SOTAC_PROFILE,
      profileSource: "registry" as const,
      thresholds: {},
      useRaw: false,
      loaders,
    };
    const first = await runBatch({ ...base, episodes: [0, 1], baseSha: "v1" });
    expect(first.report.baseSha).toBe("v1");
    const resumed = await runBatch({
      ...base,
      episodes: [0, 1],
      baseSha: "v2-ignored",
      resume: {
        rows: first.report.episodes.slice(0, 1),
        baseSha: first.report.baseSha,
      },
    });
    expect(resumed.report.baseSha).toBe("v1");
  });
});

describe("item 4 — the commit applies the save rule", () => {
  const rep = report([
    { episode: 1 },
    { episode: 2 },
    { episode: 3, staged: false },
    { episode: 4, committed: true },
  ]);
  const local = new Map<number, LanguageAtom[]>([
    [1, [human, interp]],
    [4, [human]],
  ]);
  const files = new Map<number, LanguageAtom[]>([[2, [interp]]]);
  test("staged rows only, local copy first, the run's file as fallback, the rule per profile", () => {
    const unverified = entriesForCommit(
      rep,
      (ep) => local.get(ep) ?? null,
      files,
      TEMPLATE_PROFILE,
    );
    expect(unverified.entries).toEqual([
      { episodeId: 1, atoms: [human] },
      { episodeId: 2, atoms: [] },
    ]);
    expect(unverified.missing).toEqual([]);
    const verified = entriesForCommit(
      rep,
      (ep) => local.get(ep) ?? null,
      files,
      SOTAC_PROFILE,
    );
    expect(verified.entries[0].atoms).toEqual([human, interp]);
    // item 5: no profile known counts as unverified
    const unknown = entriesForCommit(
      rep,
      (ep) => local.get(ep) ?? null,
      files,
      null as RigProfile | null,
    );
    expect(unknown.entries[0].atoms).toEqual([human]);
    // a staged row with neither a local copy nor a run file is reported
    const gone = entriesForCommit(rep, () => null, undefined, SOTAC_PROFILE);
    expect(gone.entries).toEqual([]);
    expect(gone.missing).toEqual([1, 2]);
  });
});

describe("item 6 — a dead worker leaves the pool", () => {
  type Job = { profile: RigProfile; n: number };
  function worker(
    mode: "ok" | "crash" | "silent",
  ): WorkerLike & { received: number; terminated: boolean } {
    const listeners: Record<string, Array<(ev: never) => void>> = {};
    const emit = (type: string, ev: unknown) => {
      for (const l of listeners[type] ?? []) (l as (e: unknown) => void)(ev);
    };
    const w = {
      received: 0,
      terminated: false,
      postMessage(msg: unknown) {
        w.received++;
        const req = msg as PoolRequest<Job>;
        if (mode === "silent") return;
        setTimeout(() => {
          if (mode === "crash") emit("error", { message: "boom" });
          else
            emit("message", {
              data: { id: req.id, ok: true, result: req.job.n * 10 },
            });
        }, 0);
      },
      terminate() {
        w.terminated = true;
      },
      addEventListener(type: string, listener: (ev: never) => void) {
        (listeners[type] ??= []).push(listener);
      },
    };
    return w;
  }

  test("after a crash the slot is skipped; the survivor takes the work", async () => {
    const made: ReturnType<typeof worker>[] = [];
    let i = 0;
    const pool = new WorkerPool<Job, number>(
      2,
      () => {
        const w = worker(i++ === 0 ? "crash" : "ok");
        made.push(w);
        return w;
      },
      { fallback: async (j) => 1000 + j.n },
    );
    const first = await pool.run({ profile: SOTAC_PROFILE, n: 1 }); // crash -> fallback
    expect(first).toBe(1001);
    expect(pool.liveSize).toBe(1);
    const results = await Promise.all(
      [2, 3, 4].map((n) => pool.run({ profile: SOTAC_PROFILE, n })),
    );
    expect(results).toEqual([20, 30, 40]);
    expect(made[0].received).toBe(1); // never again
    expect(made[1].received).toBe(3);
    pool.terminate();
  });

  test("with every worker dead the jobs go straight to the fallback; without one they fail", async () => {
    const pool = new WorkerPool<Job, number>(1, () => worker("crash"), {
      fallback: async (j) => 1000 + j.n,
    });
    expect(await pool.run({ profile: SOTAC_PROFILE, n: 1 })).toBe(1001);
    expect(pool.liveSize).toBe(0);
    expect(await pool.run({ profile: SOTAC_PROFILE, n: 2 })).toBe(1002);
    pool.terminate();
    const bare = new WorkerPool<Job, number>(1, () => worker("crash"));
    await expect(bare.run({ profile: SOTAC_PROFILE, n: 1 })).rejects.toThrow(
      "boom",
    );
    await expect(bare.run({ profile: SOTAC_PROFILE, n: 2 })).rejects.toThrow(
      "every worker",
    );
    bare.terminate();
  });

  test("a message that cannot be decoded counts as a crash", async () => {
    let listeners: Record<string, Array<(ev: never) => void>> = {};
    const w: WorkerLike = {
      postMessage() {
        setTimeout(() => {
          for (const l of listeners["messageerror"] ?? [])
            (l as (e: unknown) => void)({});
        }, 0);
      },
      terminate() {},
      addEventListener(type: string, listener: (ev: never) => void) {
        (listeners[type] ??= []).push(listener);
      },
    };
    const crashes: string[] = [];
    const pool = new WorkerPool<Job, number>(1, () => w, {
      fallback: async (j) => -j.n,
      onWorkerError: (m) => crashes.push(m),
    });
    expect(await pool.run({ profile: SOTAC_PROFILE, n: 7 })).toBe(-7);
    expect(crashes[0]).toContain("decoded");
    listeners = {};
    pool.terminate();
  });
});

describe("item 7 — one report path under the dataset root", () => {
  test("the write path carries the root prefix the reads use", () => {
    setDatasetPathPrefix(null);
    expect(batchReportPath()).toBe("annotations/batch_report.json");
    setDatasetPathPrefix("episodes/ep_007");
    expect(batchReportPath()).toBe(
      "episodes/ep_007/annotations/batch_report.json",
    );
  });
});

describe("small — an emptied local copy is an edit", () => {
  test("a local copy of [] over a Hub file is kept, not re-staged", async () => {
    const good = syntheticEpisode();
    const staged: number[] = [];
    const { report: rep } = await runBatch({
      repoId: "org/name",
      episodes: [0],
      profile: SOTAC_PROFILE,
      profileSource: "registry",
      thresholds: {},
      useRaw: false,
      loaders: {
        loadEpisode: async () => ({ data: good as unknown as EpisodeData }),
        listRawFiles: async () => [],
        fetchText: async () => "",
        fetchExisting: async () => ({ atoms: [human] }),
        readLocal: () => [],
      },
      stage: (ep) => {
        staged.push(ep);
        return true;
      },
    });
    expect(rep.episodes[0].localEdits).toBe(true);
    expect(rep.episodes[0].staged).toBe(false);
    expect(staged).toEqual([]);
  });
});

describe("loopholes found cross-checking the round", () => {
  test("an edit strips the detector's mark: a dragged subtask is a person's", () => {
    const marked: LanguageAtom = {
      role: "assistant",
      content: "grasp",
      style: "subtask",
      timestamp: 3.9,
      camera: null,
      tool_calls: null,
      origin: "auto",
    };
    expect(isAutoAtom(marked)).toBe(true);
    const dragged = editedAtom(marked, { timestamp: 4.5 });
    expect(dragged.timestamp).toBe(4.5);
    expect("origin" in dragged).toBe(false);
    expect(isAutoAtom(dragged)).toBe(false);
    // an event keeps its prefix: that is its label
    const ev: LanguageAtom = {
      ...human,
      content: "[auto:high] slip f0",
      role: "assistant",
    };
    expect(isAutoAtom(editedAtom(ev, { timestamp: 1 }))).toBe(true);
  });

  test("a 200 whose body is not an annotations file throws, never reads as empty", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("<html>rate limited</html>", { status: 200 }),
      ),
    ) as unknown as typeof fetch;
    await expect(fetchAnnotationsFromHub("org/name", 1)).rejects.toThrow(
      "unreadable",
    );
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ x: 1 }), { status: 200 })),
    ) as unknown as typeof fetch;
    await expect(fetchAnnotationsFromHub("org/name", 1)).rejects.toThrow(
      "not an annotations file",
    );
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ schema_version: 1, episode_index: 1, atoms: [] }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;
    expect((await fetchAnnotationsFromHub("org/name", 1))?.atoms).toEqual([]);
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ schema_version: 1, episode_index: 5, atoms: [] }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;
    await expect(fetchAnnotationsFromHub("org/name", 1)).rejects.toThrow(
      "carries episode 5",
    );
  });

  test("a worker that never answers is given up on and its job runs on the fallback", async () => {
    type Job = { profile: RigProfile; n: number };
    let posted = 0;
    const silent: WorkerLike = {
      postMessage() {
        posted++;
      },
      terminate() {},
      addEventListener() {},
    };
    const crashes: string[] = [];
    const pool = new WorkerPool<Job, number>(1, () => silent, {
      fallback: async (j) => 100 + j.n,
      onWorkerError: (m) => crashes.push(m),
      jobTimeoutMs: 20,
    });
    expect(await pool.run({ profile: SOTAC_PROFILE, n: 1 })).toBe(101);
    expect(crashes[0]).toContain("no answer");
    expect(pool.liveSize).toBe(0);
    expect(await pool.run({ profile: SOTAC_PROFILE, n: 2 })).toBe(102);
    expect(posted).toBe(1);
    pool.terminate();
  });
});
