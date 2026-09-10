import { describe, expect, test } from "bun:test";

import type { StorageLike } from "../localAtoms";
import type { TrimProposal } from "../trimDetect";
import {
  clearTrim,
  cutsFromDecisions,
  decisionFromProposal,
  listTrims,
  readTrim,
  trimKey,
  writeTrim,
} from "../trimStore";

type Store = StorageLike & {
  map: Map<string, string>;
  length: number;
  key: (i: number) => string | null;
};

function fakeStorage(): Store {
  const map = new Map<string, string>();
  const st: Store = {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
  return st;
}

const proposal: TrimProposal = {
  startFrame: 64,
  endFrame: 374,
  startS: 64 / 30,
  endS: 375 / 30,
  onsetFrame: 77,
  motionEndFrame: 358,
  nFrames: 420,
  fps: 30,
  flags: ["arm_moving_at_start"],
};

describe("trim decisions", () => {
  test("a proposal becomes a rule decision; round trip; list; cuts", () => {
    const st = fakeStorage();
    const d = decisionFromProposal(
      proposal,
      () => new Date("2026-09-09T00:00:00Z"),
    );
    expect(d).toEqual({
      startFrame: 64,
      endFrame: 374,
      nFrames: 420,
      fps: 30,
      source: "rule",
      reviewed: false,
      flags: ["arm_moving_at_start"],
      savedAt: "2026-09-09T00:00:00.000Z",
    });
    expect(readTrim("org/name", 3, st)).toBeNull();
    expect(writeTrim("org/name", 3, d, st)).toBe(true);
    expect(readTrim("org/name", 3, st)).toEqual(d);
    writeTrim(
      "org/name",
      1,
      { ...d, startFrame: 10, source: "adjusted", reviewed: true },
      st,
    );
    st.map.set(trimKey("other/name", 9), JSON.stringify(d));
    const all = listTrims("org/name", st);
    expect([...all.keys()]).toEqual([3, 1]);
    expect(cutsFromDecisions(all)).toEqual({ "1": [10, 374], "3": [64, 374] });
    clearTrim("org/name", 3, st);
    expect(readTrim("org/name", 3, st)).toBeNull();
  });

  test("a broken or foreign entry reads as nothing; no storage is fine", () => {
    const st = fakeStorage();
    st.map.set(trimKey("org/name", 2), "{not json");
    expect(readTrim("org/name", 2, st)).toBeNull();
    st.map.set(trimKey("org/name", 2), JSON.stringify({ startFrame: "x" }));
    expect(readTrim("org/name", 2, st)).toBeNull();
    st.map.set(
      trimKey("org/name", 4),
      JSON.stringify({ startFrame: 1, endFrame: 5, nFrames: 10 }),
    );
    expect(readTrim("org/name", 4, st)).toEqual({
      startFrame: 1,
      endFrame: 5,
      nFrames: 10,
      fps: 30,
      source: "rule",
      reviewed: false,
      flags: [],
      savedAt: "",
    });
    expect(readTrim("org/name", 4, null)).toBeNull();
    expect(writeTrim("org/name", 4, decisionFromProposal(proposal), null)).toBe(
      false,
    );
    expect(listTrims("org/name", null).size).toBe(0);
  });
});
