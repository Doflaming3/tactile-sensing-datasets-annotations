import { describe, expect, test } from "bun:test";

import type { LanguageAtom } from "@/types/language.types";

import { DETECTOR_VERSION, type BatchReport } from "../batchAnnotate";
import {
  batchStoreKey,
  clearStoredBatch,
  loadStoredBatch,
  saveStoredBatch,
} from "../batchStore";
import {
  LOCAL_ATOMS_PREFIX,
  localAtomsKey,
  readLocalAtoms,
  readStagedMarker,
  stageLocalAtoms,
  stagedMarkerKey,
  writeLocalAtoms,
  type StorageLike,
} from "../localAtoms";

/** localStorage stand-in for bun:test; `full` makes every write throw. */
function fakeStorage(full = false): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      if (full) throw new Error("QuotaExceededError");
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

const atom: LanguageAtom = {
  role: "assistant",
  content: "[auto:high] contact_onset f0 1.2N",
  style: "interjection",
  timestamp: 2.5,
  camera: null,
};

describe("local atom copies", () => {
  test("the key is the annotations context's slot", () => {
    expect(localAtomsKey("Jingyi-Z/sotac", 23)).toBe(
      `${LOCAL_ATOMS_PREFIX}Jingyi-Z/sotac::23`,
    );
  });

  test("round trip, absent copy, unreadable copy, full storage", () => {
    const st = fakeStorage();
    expect(readLocalAtoms("org/name", 1, st)).toBeNull();
    expect(writeLocalAtoms("org/name", 1, [atom], st)).toBe(true);
    expect(readLocalAtoms("org/name", 1, st)).toEqual([atom]);
    st.map.set(localAtomsKey("org/name", 2), "{not json");
    expect(readLocalAtoms("org/name", 2, st)).toBeNull();
    st.map.set(localAtomsKey("org/name", 3), JSON.stringify({ atoms: [] }));
    expect(readLocalAtoms("org/name", 3, st)).toBeNull();
    expect(writeLocalAtoms("org/name", 1, [atom], fakeStorage(true))).toBe(
      false,
    );
    expect(readLocalAtoms("org/name", 1, null)).toBeNull();
    expect(writeLocalAtoms("org/name", 1, [atom], null)).toBe(false);
  });
});

describe("stored batch report", () => {
  const report: BatchReport = {
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
    detectorVersion: DETECTOR_VERSION,
    concurrency: 1,
    requested: [],
    startedAt: "2026-09-09T00:00:00.000Z",
    finishedAt: "2026-09-09T00:01:00.000Z",
    aborted: false,
    episodes: [],
    summary: {
      total: 0,
      ok: 0,
      flagged: 0,
      failed: 0,
      noTactile: 0,
      changed: 0,
      staged: 0,
      localEdits: 0,
    },
  };

  test("round trip keeps the report and the commit stamp", () => {
    const st = fakeStorage();
    expect(loadStoredBatch("org/name", st)).toBeNull();
    expect(saveStoredBatch("org/name", { report, committedAt: null }, st)).toBe(
      true,
    );
    expect(loadStoredBatch("org/name", st)).toEqual({
      report,
      committedAt: null,
    });
    saveStoredBatch(
      "org/name",
      { report, committedAt: "2026-09-09T00:02:00.000Z" },
      st,
    );
    expect(loadStoredBatch("org/name", st)?.committedAt).toBe(
      "2026-09-09T00:02:00.000Z",
    );
    clearStoredBatch("org/name", st);
    expect(loadStoredBatch("org/name", st)).toBeNull();
  });

  test("a report saved before the parallel runner is backfilled", () => {
    const st = fakeStorage();
    const legacy = {
      ...report,
      episodes: [{ episode: 4 }],
    } as unknown as Record<string, unknown>;
    delete legacy.requested;
    delete legacy.concurrency;
    st.map.set(batchStoreKey("org/name"), JSON.stringify({ report: legacy }));
    const loaded = loadStoredBatch("org/name", st)!;
    expect(loaded.report.requested).toEqual([4]);
    expect(loaded.report.concurrency).toBe(1);
  });

  test("a foreign or broken entry is ignored", () => {
    const st = fakeStorage();
    st.map.set(batchStoreKey("org/name"), JSON.stringify({ report: { x: 1 } }));
    expect(loadStoredBatch("org/name", st)).toBeNull();
    st.map.set(batchStoreKey("org/name"), "nope");
    expect(loadStoredBatch("org/name", st)).toBeNull();
    expect(
      saveStoredBatch(
        "org/name",
        { report, committedAt: null },
        fakeStorage(true),
      ),
    ).toBe(false);
  });
});

describe("staging marker", () => {
  test("staging writes the slot and the marker; a full store reports failure", () => {
    const st = fakeStorage();
    expect(readStagedMarker("org/name", 1, st)).toBeNull();
    expect(stageLocalAtoms("org/name", 1, [atom], st)).toBe(true);
    expect(readLocalAtoms("org/name", 1, st)).toEqual([atom]);
    expect(readStagedMarker("org/name", 1, st)).toEqual([atom]);
    expect(stagedMarkerKey("org/name", 1)).not.toBe(
      localAtomsKey("org/name", 1),
    );
    expect(stageLocalAtoms("org/name", 1, [atom], fakeStorage(true))).toBe(
      false,
    );
    expect(stageLocalAtoms("org/name", 1, [atom], null)).toBe(false);
  });
});
