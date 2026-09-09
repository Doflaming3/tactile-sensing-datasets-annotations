import { describe, expect, test } from "bun:test";

import type { EpisodeData } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import type { LanguageAtom } from "@/types/language.types";

import {
  flagHistogram,
  flagWeight,
  isFlaggedRow,
  runBatch,
  sortTriage,
  type BatchLoaders,
  type BatchRow,
} from "../batchAnnotate";
import { SOTAC_PROFILE } from "../rigProfile";
import { syntheticEpisode } from "./annotateEpisode.test";

const human: LanguageAtom = {
  role: "user",
  content: "checked on video",
  style: "interjection",
  timestamp: 4.0,
  camera: null,
};
const staleAuto: LanguageAtom = {
  role: "assistant",
  content: "[auto:low] contact_onset f0 0.4N",
  style: "interjection",
  timestamp: 1.0,
  camera: null,
};

function loaders(): BatchLoaders & { fetched: number[] } {
  const good = syntheticEpisode();
  const empty = syntheticEpisode(false);
  const fetched: number[] = [];
  return {
    fetched,
    loadEpisode: async (ep) => {
      fetched.push(ep);
      if (ep === 1) return { error: "parquet chunk missing" };
      return { data: (ep === 2 ? empty : good) as unknown as EpisodeData };
    },
    listRawFiles: async () => [],
    fetchText: async () => "",
    fetchExisting: async (ep) =>
      ep === 0 ? { atoms: [human, staleAuto] } : null,
  };
}

describe("runBatch", () => {
  test("annotates, merges with the Hub file, and reports a triage list", async () => {
    const L = loaders();
    const progress: number[] = [];
    const { report, files } = await runBatch({
      repoId: "org/name",
      episodes: [0, 1, 2],
      profile: SOTAC_PROFILE,
      profileSource: "registry",
      thresholds: {},
      useRaw: true,
      loaders: L,
      onProgress: (_row, done) => progress.push(done),
      now: () => new Date("2026-09-09T00:00:00Z"),
    });
    expect(progress).toEqual([1, 2, 3]);
    expect(report.summary).toEqual({
      total: 3,
      ok: 1,
      flagged: 1,
      failed: 1,
      noTactile: 1,
      changed: 1,
      staged: 0,
      localEdits: 0,
    });
    // failed first, then the rest by weight
    expect(report.episodes.map((r) => r.status)).toEqual([
      "failed",
      "no_tactile",
      "ok",
    ]);
    expect(report.episodes[0].error).toContain("parquet");
    const ok = report.episodes.find((r) => r.episode === 0)!;
    expect(ok.rawFallback).toBe(true);
    expect(ok.weight).toBeGreaterThan(0);
    expect(ok.flags.some((f) => f.startsWith("failed_attempt"))).toBe(true);
    // the merged file keeps the human atom and drops the stale auto atom
    const merged = files.get(0)!;
    expect(merged).toContain(human);
    expect(merged).not.toContain(staleAuto);
    expect(merged.some((a) => a.content?.startsWith("[auto:"))).toBe(true);
    // an episode with no tactile data and no file on the Hub changes nothing
    expect(files.has(2)).toBe(false);
    expect(report.profile).toEqual({
      id: SOTAC_PROFILE.id,
      source: "registry",
      verified: true,
      interpretation: true,
    });
    expect(report.startedAt).toBe("2026-09-09T00:00:00.000Z");
  });

  test("a stop request ends the run and the report says so", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { report, files } = await runBatch({
      repoId: "org/name",
      episodes: [0, 1],
      profile: SOTAC_PROFILE,
      profileSource: "registry",
      thresholds: {},
      useRaw: false,
      loaders: loaders(),
    });
    expect(report.aborted).toBe(false); // not aborted: the signal was not passed
    expect(files.size).toBe(1);
    const stopped = await runBatch({
      repoId: "org/name",
      episodes: [0, 1],
      profile: SOTAC_PROFILE,
      profileSource: "registry",
      thresholds: {},
      useRaw: false,
      loaders: loaders(),
      signal: ctrl.signal,
    });
    expect(stopped.report.aborted).toBe(true);
    expect(stopped.report.episodes).toEqual([]);
  });
});

describe("triage order", () => {
  const row = (
    episode: number,
    status: BatchRow["status"],
    flags: string[],
    rawFallback = false,
  ): BatchRow => ({
    episode,
    status,
    source: "raw",
    rawFallback,
    flags,
    localEdits: false,
    staged: false,
    events: 0,
    atoms: 0,
    changed: false,
    ms: 0,
    weight: flagWeight(flags, rawFallback),
  });
  test("failed, then no tactile, then heaviest flags, then episode order", () => {
    const rows = [
      row(5, "ok", ["base_mode"]),
      row(3, "ok", ["failed_attempt@2.9-5.3s"]),
      row(9, "failed", []),
      row(1, "ok", ["hesitation", "no_arm"]),
      row(2, "ok", [], true),
      row(7, "no_tactile", []),
    ];
    expect(sortTriage(rows).map((r) => r.episode)).toEqual([9, 7, 3, 1, 2, 5]);
  });
});

describe("staging into the browser's local copies", () => {
  const good = syntheticEpisode();
  const base = (): BatchLoaders => ({
    loadEpisode: async () => ({ data: good as unknown as EpisodeData }),
    listRawFiles: async () => [],
    fetchText: async () => "",
    fetchExisting: async (ep) =>
      ep === 0 ? { atoms: [human, staleAuto] } : null,
  });
  const run = (
    loaders: BatchLoaders,
    stage?: (ep: number, atoms: LanguageAtom[]) => boolean,
  ) =>
    runBatch({
      repoId: "org/name",
      episodes: [0, 3],
      profile: SOTAC_PROFILE,
      profileSource: "registry",
      thresholds: {},
      useRaw: false,
      loaders,
      stage,
    });

  test("a changed episode is staged when this browser holds no edits of its own", async () => {
    const staged: number[] = [];
    const { report } = await run(
      // ep 0's local copy is exactly the Hub file: nothing to protect
      { ...base(), readLocal: (ep) => (ep === 0 ? [human, staleAuto] : null) },
      (ep) => {
        staged.push(ep);
        return true;
      },
    );
    expect(staged).toEqual([0, 3]);
    const byEp = Object.fromEntries(report.episodes.map((r) => [r.episode, r]));
    expect(byEp[0].changed).toBe(true);
    expect(byEp[0].localEdits).toBe(false);
    expect(byEp[0].staged).toBe(true);
    expect(byEp[3].staged).toBe(true);
    expect(report.summary.staged).toBe(2);
    expect(report.summary.localEdits).toBe(0);
  });

  test("unsaved local edits are never overwritten", async () => {
    const staged: number[] = [];
    const { report } = await run(
      // ep 0's local copy differs from the Hub file: someone edited it here
      { ...base(), readLocal: (ep) => (ep === 0 ? [human] : null) },
      (ep) => {
        staged.push(ep);
        return true;
      },
    );
    expect(staged).toEqual([3]);
    const r0 = report.episodes.find((r) => r.episode === 0)!;
    expect(r0.changed).toBe(true);
    expect(r0.localEdits).toBe(true);
    expect(r0.staged).toBe(false);
    expect(report.summary.localEdits).toBe(1);
    expect(report.summary.staged).toBe(1);
  });

  test("without a stage hook nothing is staged; a refused write is reported", async () => {
    const plain = await run(base());
    expect(plain.report.episodes.every((r) => !r.staged)).toBe(true);
    expect(plain.report.summary.changed).toBe(2);
    const refused = await run(base(), () => false);
    expect(refused.report.episodes.every((r) => !r.staged)).toBe(true);
    expect(refused.report.summary.staged).toBe(0);
  });
});

describe("flag histogram", () => {
  const row = (episode: number, flags: string[]): BatchRow => ({
    episode,
    status: "ok",
    source: "raw",
    rawFallback: false,
    flags,
    events: 0,
    atoms: 0,
    changed: false,
    localEdits: false,
    staged: false,
    ms: 0,
    weight: flagWeight(flags, false),
  });

  test("counts the episodes raising each flag kind, most frequent first", () => {
    const rows = [
      row(0, ["hesitation@1.0-2.0", "hesitation@5.0-6.0", "weak_contact"]),
      row(1, ["hesitation@3.0-4.0"]),
      row(2, []),
    ];
    expect(flagHistogram(rows)).toEqual([
      { kind: "hesitation", count: 2 },
      { kind: "weak_contact", count: 1 },
    ]);
    expect(isFlaggedRow(rows[0])).toBe(true);
    expect(isFlaggedRow(rows[2])).toBe(false);
  });
});
