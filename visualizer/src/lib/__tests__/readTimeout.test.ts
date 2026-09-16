import { describe, expect, test } from "bun:test";

import type { EpisodeData } from "@/app/[org]/[dataset]/[episode]/fetch-data";

import {
  EPISODE_READ_TIMEOUT_MS,
  episodeReader,
  runBatch,
  type BatchLoaders,
} from "../batchAnnotate";
import { readEpisodeHere } from "../batchWorkers";
import { SOTAC_PROFILE } from "../rigProfile";
import { syntheticEpisode } from "./annotateEpisode.test";

const never = new Promise<never>(() => {});

/** episode 1 never loads (a stalled fetch); the others are synthetic */
function loaders(): BatchLoaders {
  const good = syntheticEpisode();
  return {
    loadEpisode: (ep) =>
      ep === 1
        ? never
        : Promise.resolve({ data: good as unknown as EpisodeData }),
    listRawFiles: async () => [],
    fetchText: async () => "",
    fetchExisting: async () => null,
  };
}

describe("an episode read has a deadline", () => {
  test("the batch page's limit is three minutes", () => {
    expect(EPISODE_READ_TIMEOUT_MS).toBe(180_000);
  });

  test("the reader gives up after its limit", async () => {
    const read = episodeReader(
      loaders(),
      async () => {
        throw new Error("not reached");
      },
      { profile: SOTAC_PROFILE, thresholds: {}, useRaw: false, timeoutMs: 20 },
    );
    await expect(read(1, [])).rejects.toThrow("no answer");
  });

  test("a stalled episode fails its row and the run goes on", async () => {
    const { report } = await runBatch({
      repoId: "org/name",
      episodes: [0, 1, 2],
      profile: SOTAC_PROFILE,
      profileSource: "registry",
      thresholds: {},
      useRaw: false,
      loaders: loaders(),
      readTimeoutMs: 30,
      concurrency: 2,
      now: () => new Date("2026-09-15T00:00:00Z"),
    });
    expect(report.summary.total).toBe(3);
    expect(report.summary.failed).toBe(1);
    const stalled = report.episodes.find((r) => r.episode === 1)!;
    expect(stalled.status).toBe("failed");
    expect(stalled.error).toContain("no answer");
    expect(
      report.episodes
        .filter((r) => r.status !== "failed")
        .map((r) => r.episode),
    ).toEqual([0, 2]);
  });

  test("the worker's fallback on this thread has the same deadline", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => never) as unknown as typeof fetch;
    try {
      await expect(
        readEpisodeHere(
          {
            profile: SOTAC_PROFILE,
            org: "org",
            dataset: "name",
            root: null,
            token: null,
            episode: 3,
            rawPaths: [],
            useRaw: false,
            thresholds: {},
          },
          20,
        ),
      ).rejects.toThrow("no answer");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
