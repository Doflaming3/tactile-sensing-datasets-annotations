// The last batch run of a dataset, kept in this browser so the batch page
// survives a trip into an episode and back (the run itself cannot: leaving
// the page stops it). The staged atoms live in the per-episode local copies
// (localAtoms.ts); this holds only the report.
import type { BatchReport } from "./batchAnnotate";
import { browserStorage, type StorageLike } from "./localAtoms";

export const BATCH_STORE_PREFIX = "lerobot-batch-report:v1:";

export interface StoredBatch {
  report: BatchReport;
  /** set once this run's staged files went to the Hub */
  committedAt: string | null;
}

export function batchStoreKey(repoId: string): string {
  return `${BATCH_STORE_PREFIX}${repoId}`;
}

export function saveStoredBatch(
  repoId: string,
  stored: StoredBatch,
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(batchStoreKey(repoId), JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

export function loadStoredBatch(
  repoId: string,
  storage: StorageLike | null = browserStorage(),
): StoredBatch | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(batchStoreKey(repoId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredBatch>;
    const report = parsed.report;
    if (
      !report ||
      report.schema !== "batch-report/1" ||
      !Array.isArray(report.episodes)
    )
      return null;
    // a report from before the parallel runner: nothing owed, one lane
    if (!Array.isArray(report.requested))
      report.requested = report.episodes.map((r) => r.episode);
    if (typeof report.concurrency !== "number") report.concurrency = 1;
    return { report, committedAt: parsed.committedAt ?? null };
  } catch {
    return null;
  }
}

export function clearStoredBatch(
  repoId: string,
  storage: StorageLike | null = browserStorage(),
): void {
  try {
    storage?.removeItem(batchStoreKey(repoId));
  } catch {
    /* nothing to clear */
  }
}
