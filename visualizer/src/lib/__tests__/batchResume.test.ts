import { describe, expect, test } from "bun:test";

import type { EpisodeData } from "@/app/[org]/[dataset]/[episode]/fetch-data";

import type { LanguageAtom } from "@/types/language.types";

import {
  episodeReader,
  remainingEpisodes,
  runBatch,
  timingAverages,
  type BatchLoaders,
  type EpisodeRead,
} from "../batchAnnotate";
import { SOTAC_PROFILE } from "../rigProfile";
import { syntheticEpisode } from "./annotateEpisode.test";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Loaders with a small delay, so overlap is observable. */
function slowLoaders(): BatchLoaders & { fetched: number[] } {
  const good = syntheticEpisode();
  const fetched: number[] = [];
  return {
    fetched,
    loadEpisode: async (ep) => {
      fetched.push(ep);
      await wait(8);
      return { data: good as unknown as EpisodeData };
    },
    listRawFiles: async () => {
      await wait(3);
      return [];
    },
    fetchText: async () => "",
    fetchExisting: async () => {
      await wait(4);
      return null;
    },
  };
}

const base = (loaders: BatchLoaders) => ({
  repoId: "org/name",
  profile: SOTAC_PROFILE,
  profileSource: "registry" as const,
  thresholds: {},
  useRaw: true,
  loaders,
});

describe("parallel runs", () => {
  test("handles `concurrency` episodes at once and times each stage", async () => {
    const L = slowLoaders();
    let inFlight = 0;
    let peak = 0;
    const { report } = await runBatch({
      ...base(L),
      episodes: [0, 1, 2, 3, 4],
      concurrency: 2,
      onStart: () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
      },
      onProgress: () => {
        inFlight--;
      },
    });
    expect(peak).toBe(2);
    expect(report.concurrency).toBe(2);
    expect(report.requested).toEqual([0, 1, 2, 3, 4]);
    expect(report.episodes.length).toBe(5);
    expect(report.summary.total).toBe(5);
    expect(L.fetched.sort()).toEqual([0, 1, 2, 3, 4]);
    const avg = timingAverages(report.episodes)!;
    expect(avg.load).toBeGreaterThan(5);
    expect(avg.annotate).toBeGreaterThanOrEqual(0);
    expect(avg.hub).toBeGreaterThan(2);
  });

  test("the injected annotate function is what runs", async () => {
    const seen: number[] = [];
    const { report } = await runBatch({
      ...base(slowLoaders()),
      episodes: [7, 8],
      concurrency: 4,
      annotate: async (_inputs, opts) => {
        seen.push(opts.episodeIndex);
        return {
          status: "ok",
          source: "table",
          rawFallback: true,
          rateHz: 30,
          samples: 1,
          result: null,
          recordedAtoms: [],
          flags: ["no_contact"],
          events: 0,
          ms: 0,
        };
      },
    });
    expect(seen.sort()).toEqual([7, 8]);
    expect(report.episodes.every((r) => r.flags[0] === "no_contact")).toBe(
      true,
    );
    expect(report.episodes.every((r) => r.rawFallback)).toBe(true);
  });
});

describe("cold starts", () => {
  test("a slot's first episode runs alone; the next slot starts after it", async () => {
    const L = slowLoaders();
    const events: string[] = [];
    await runBatch({
      ...base(L),
      episodes: [0, 1, 2, 3, 4, 5],
      concurrency: 3,
      onStart: (ep) => events.push(`start ${ep}`),
      onProgress: (row) => events.push(`done ${row.episode}`),
    });
    // one episode runs before the first completion; a second slot joins
    // only after it, a third only after the second slot's first episode
    const firstDone = events.findIndex((e) => e.startsWith("done"));
    expect(
      events.slice(0, firstDone).filter((e) => e.startsWith("start")).length,
    ).toBe(1);
    let inFlight = 0;
    let completions = 0;
    let peakBeforeSecondCompletion = 0;
    let peak = 0;
    for (const e of events) {
      if (e.startsWith("start")) inFlight++;
      else {
        inFlight--;
        completions++;
      }
      peak = Math.max(peak, inFlight);
      if (completions < 2)
        peakBeforeSecondCompletion = Math.max(
          peakBeforeSecondCompletion,
          inFlight,
        );
    }
    expect(peakBeforeSecondCompletion).toBeLessThanOrEqual(2);
    expect(peak).toBe(3);
    expect(events.filter((e) => e.startsWith("done")).length).toBe(6);
  });
});

describe("stop and resume", () => {
  test("a stop after the first episode leaves the rest owed; resume does only those", async () => {
    const ctrl = new AbortController();
    const first = await runBatch({
      ...base(slowLoaders()),
      episodes: [0, 1, 2, 3],
      concurrency: 1,
      signal: ctrl.signal,
      onProgress: (_row, done) => {
        if (done === 1) ctrl.abort();
      },
      now: () => new Date("2026-09-09T00:00:00Z"),
    });
    expect(first.report.aborted).toBe(true);
    expect(first.report.episodes.map((r) => r.episode)).toEqual([0]);
    expect(remainingEpisodes(first.report)).toEqual([1, 2, 3]);

    const L = slowLoaders();
    const second = await runBatch({
      ...base(L),
      episodes: first.report.requested,
      concurrency: 2,
      resume: {
        rows: first.report.episodes,
        files: first.files,
        startedAt: first.report.startedAt,
      },
      now: () => new Date("2026-09-09T00:05:00Z"),
    });
    expect(L.fetched.sort()).toEqual([1, 2, 3]);
    expect(second.report.aborted).toBe(false);
    expect(second.report.episodes.map((r) => r.episode).sort()).toEqual([
      0, 1, 2, 3,
    ]);
    expect(second.report.startedAt).toBe("2026-09-09T00:00:00.000Z");
    expect(second.report.finishedAt).toBe("2026-09-09T00:05:00.000Z");
    expect(remainingEpisodes(second.report)).toEqual([]);
    expect(second.report.summary.total).toBe(4);
    expect(second.files.size).toBe(4);
  });

  test("resuming a finished run does nothing", async () => {
    const L = slowLoaders();
    const done = await runBatch({ ...base(L), episodes: [0, 1] });
    const L2 = slowLoaders();
    const again = await runBatch({
      ...base(L2),
      episodes: [0, 1],
      resume: { rows: done.report.episodes },
    });
    expect(L2.fetched).toEqual([]);
    expect(again.report.episodes.length).toBe(2);
  });
});

describe("the read step", () => {
  test("an injected reader replaces load, fetch and detect; the run merges and stages its result", async () => {
    const seen: Array<[number, string[]]> = [];
    const auto: LanguageAtom = {
      role: "assistant",
      content: "[auto:high] contact_onset f0 1.2N",
      style: "interjection",
      timestamp: 2.5,
      camera: null,
    };
    const read = async (
      episode: number,
      rawPaths: string[],
    ): Promise<EpisodeRead> => {
      seen.push([episode, rawPaths]);
      return {
        outcome: {
          status: "ok",
          source: "raw",
          rawFallback: false,
          rateHz: 90,
          samples: 100,
          result: null,
          recordedAtoms: [auto],
          flags: [],
          events: 1,
          ms: 1,
        },
        existing: null,
        timing: { load: 1, raw: 2, hub: 3, annotate: 4 },
      };
    };
    const staged: number[] = [];
    const L = slowLoaders();
    L.listRawFiles = async () => [
      "sensors/episode_000003/sensor_1.csv",
      "sensors/episode_000004/sensor_1.csv",
    ];
    const { report, files } = await runBatch({
      ...base(L),
      episodes: [3, 4],
      concurrency: 2,
      readEpisode: read,
      stage: (ep) => {
        staged.push(ep);
        return true;
      },
    });
    expect(L.fetched).toEqual([]); // the loaders' loadEpisode was not used
    expect(seen.sort()).toEqual([
      [3, ["sensors/episode_000003/sensor_1.csv"]],
      [4, ["sensors/episode_000004/sensor_1.csv"]],
    ]);
    expect(files.get(3)).toEqual([auto]);
    expect(staged.sort()).toEqual([3, 4]);
    expect(report.episodes.every((r) => r.timing?.hub === 3)).toBe(true);
  });

  test("the default reader fetches table, sidecars and Hub file together", async () => {
    const order: string[] = [];
    const good = syntheticEpisode();
    const read = episodeReader(
      {
        loadEpisode: async () => {
          order.push("load-start");
          await wait(10);
          order.push("load-end");
          return { data: good as unknown as EpisodeData };
        },
        fetchText: async (p) => {
          order.push(`text:${p}`);
          return "";
        },
        fetchExisting: async () => {
          order.push("hub-start");
          await wait(2);
          order.push("hub-end");
          return null;
        },
      },
      async () => ({
        status: "ok",
        source: "raw",
        rawFallback: false,
        rateHz: 90,
        samples: 1,
        result: null,
        recordedAtoms: [],
        flags: [],
        events: 0,
        ms: 0,
      }),
      { profile: SOTAC_PROFILE, thresholds: {}, useRaw: true },
    );
    const r = await read(1, ["a.csv"]);
    // the Hub fetch finished while the table was still loading
    expect(order.indexOf("hub-end")).toBeLessThan(order.indexOf("load-end"));
    expect(order).toContain("text:a.csv");
    expect(r.existing).toBeNull();
    expect(r.timing.load).toBeGreaterThanOrEqual(r.timing.hub);
    await expect(
      episodeReader(
        {
          loadEpisode: async () => ({ error: "gone" }),
          fetchText: async () => "",
          fetchExisting: async () => null,
        },
        async () => {
          throw new Error("unreachable");
        },
        { profile: SOTAC_PROFILE, thresholds: {}, useRaw: false },
      )(1, []),
    ).rejects.toThrow("gone");
  });
});

describe("the batch's own staging", () => {
  test("a local copy equal to what the batch staged last time is not an edit", async () => {
    const good = syntheticEpisode();
    const first = await runBatch({
      ...base({
        loadEpisode: async () => ({ data: good as unknown as EpisodeData }),
        listRawFiles: async () => [],
        fetchText: async () => "",
        fetchExisting: async () => null,
      }),
      episodes: [0],
      stage: () => true,
    });
    const stagedAtoms = first.files.get(0)!;
    expect(stagedAtoms.length).toBeGreaterThan(0);
    const again = await runBatch({
      ...base({
        loadEpisode: async () => ({ data: good as unknown as EpisodeData }),
        listRawFiles: async () => [],
        fetchText: async () => "",
        fetchExisting: async () => null,
        // the slot holds exactly what was staged, and the marker says so
        readLocal: () => stagedAtoms,
        readStaged: () => stagedAtoms,
      }),
      episodes: [0],
      stage: () => true,
    });
    expect(again.report.episodes[0].localEdits).toBe(false);
    expect(again.report.episodes[0].staged).toBe(true);
    // a slot content that matches nothing — not the Hub, not the proposal,
    // no marker — is an edit
    const edited = await runBatch({
      ...base({
        loadEpisode: async () => ({ data: good as unknown as EpisodeData }),
        listRawFiles: async () => [],
        fetchText: async () => "",
        fetchExisting: async () => null,
        readLocal: () => stagedAtoms.slice(1),
      }),
      episodes: [0],
      stage: () => true,
    });
    expect(edited.report.episodes[0].localEdits).toBe(true);
    expect(edited.report.episodes[0].staged).toBe(false);
  });

  test("a local copy that already equals the proposal is staged, not an edit", async () => {
    const good = syntheticEpisode();
    const first = await runBatch({
      ...base({
        loadEpisode: async () => ({ data: good as unknown as EpisodeData }),
        listRawFiles: async () => [],
        fetchText: async () => "",
        fetchExisting: async () => null,
      }),
      episodes: [0],
    });
    const proposal = first.files.get(0)!;
    const written: number[] = [];
    // no marker (a copy staged before markers existed), same content
    const again = await runBatch({
      ...base({
        loadEpisode: async () => ({ data: good as unknown as EpisodeData }),
        listRawFiles: async () => [],
        fetchText: async () => "",
        fetchExisting: async () => null,
        readLocal: () => proposal,
      }),
      episodes: [0],
      stage: (ep) => {
        written.push(ep);
        return true;
      },
    });
    expect(again.report.episodes[0].localEdits).toBe(false);
    expect(again.report.episodes[0].staged).toBe(true);
    expect(written).toEqual([0]); // the marker is written for next time
  });
});
