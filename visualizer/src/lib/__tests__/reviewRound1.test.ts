// Jingyi's review of PR #3, items 1 and 2: the two ways the batch can lose
// a person's annotations. Written RED against the current code — each test
// states the behaviour she asked for — and turned green by the fix round.
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { EpisodeData } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import type { LanguageAtom } from "@/types/language.types";
import { fetchAnnotationsFromHub } from "@/utils/hubCommit";

import { isAutoAtom, mergeAutoAtoms } from "../atomPolicy";
import { runBatch, type BatchLoaders } from "../batchAnnotate";
import { resultToRecordedAtoms } from "../eventDetection";
import { SOTAC_PROFILE } from "../rigProfile";
import { syntheticEpisode } from "./annotateEpisode.test";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function hubAnswering(status: number, body = "") {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(body, { status })),
  ) as unknown as typeof fetch;
}

describe("item 1 — a Hub error is not an empty file", () => {
  test("404 means no file: null", async () => {
    hubAnswering(404);
    expect(await fetchAnnotationsFromHub("org/name", 3)).toBeNull();
  });

  test("429, 5xx and a 401 must throw, never read as empty", async () => {
    for (const status of [429, 500, 502, 503, 401]) {
      hubAnswering(status);
      await expect(fetchAnnotationsFromHub("org/name", 3)).rejects.toThrow(
        String(status),
      );
    }
  });

  test("a throwing fetch fails the row and stages nothing", async () => {
    const good = syntheticEpisode();
    const staged: number[] = [];
    const loaders: BatchLoaders = {
      loadEpisode: async () => ({ data: good as unknown as EpisodeData }),
      listRawFiles: async () => [],
      fetchText: async () => "",
      fetchExisting: async (ep) => {
        if (ep === 1) throw new Error("429 on annotations/episode_000001.json");
        return null;
      },
    };
    const { report, files } = await runBatch({
      repoId: "org/name",
      episodes: [0, 1],
      profile: SOTAC_PROFILE,
      profileSource: "registry",
      thresholds: {},
      useRaw: false,
      loaders,
      stage: (ep) => {
        staged.push(ep);
        return true;
      },
    });
    const r1 = report.episodes.find((r) => r.episode === 1)!;
    expect(r1.status).toBe("failed");
    expect(r1.error).toContain("429");
    expect(r1.staged).toBe(false);
    expect(files.has(1)).toBe(false);
    expect(staged).toEqual([0]);
  });
});

// what the panel's manual subtask add and a dragged detector atom look
// like: the assistant role and a canonical label, no mark
const handGrasp: LanguageAtom = {
  role: "assistant",
  content: "grasp",
  style: "subtask",
  timestamp: 4.5,
  camera: null,
  tool_calls: null,
};

describe("item 2 — only the detector's own subtask atoms are replaced", () => {
  test("the detector marks its subtask atoms; an unmarked one is not auto", () => {
    const good = syntheticEpisode();
    const recorded = resultToRecordedAtoms(
      // any result with subtasks will do: run the detector on the fixture
      // through the batch below; here only the shape matters
      {
        subtasks: [{ label: "grasp", startS: 3.9, endS: 5.0 }],
        events: [],
        flags: [],
        spans: [],
      } as never,
    );
    const sub = recorded.find((a) => a.style === "subtask")!;
    expect(isAutoAtom(sub)).toBe(true);
    expect(isAutoAtom(handGrasp)).toBe(false);
    expect(good).toBeTruthy();
  });

  test("a hand-placed or dragged subtask survives a batch run at its own time", async () => {
    const good = syntheticEpisode();
    const loaders: BatchLoaders = {
      loadEpisode: async () => ({ data: good as unknown as EpisodeData }),
      listRawFiles: async () => [],
      fetchText: async () => "",
      fetchExisting: async () => ({ atoms: [handGrasp] }),
    };
    const { files } = await runBatch({
      repoId: "org/name",
      episodes: [0],
      profile: SOTAC_PROFILE,
      profileSource: "registry",
      thresholds: {},
      useRaw: false,
      loaders,
    });
    const merged = files.get(0) ?? [];
    const grasps = merged.filter(
      (a) => a.style === "subtask" && a.content === "grasp",
    );
    expect(grasps.length).toBe(1);
    expect(grasps[0].timestamp).toBe(4.5);
  });

  test("a legacy file's unmarked subtasks do not get a second set", () => {
    const legacy: LanguageAtom[] = [
      "approach",
      "grasp",
      "transport",
      "place_release",
    ].map((label, i) => ({
      role: "assistant",
      content: label,
      style: "subtask",
      timestamp: i * 2,
      camera: null,
      tool_calls: null,
    }));
    const recorded: LanguageAtom[] = [
      "approach",
      "grasp",
      "transport",
      "place_release",
    ].map((label, i) => ({
      role: "assistant",
      content: label,
      style: "subtask",
      timestamp: i * 2 + 0.3,
      camera: null,
      tool_calls: null,
      origin: "auto",
    }));
    const merged = mergeAutoAtoms(legacy, recorded);
    expect(merged.filter((a) => a.style === "subtask").length).toBe(4);
    expect(merged.map((a) => a.timestamp)).toEqual([0, 2, 4, 6]);
  });
});
