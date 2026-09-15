// The viewer's per-episode local copy of an episode's annotation atoms
// (localStorage: written on every edit by the annotations context and read
// back before the Hub file). The batch page stages its proposals into the
// same slot, so clicking into an episode shows exactly what the batch would
// commit. One module owns the key so the two can never disagree.
import type { LanguageAtom } from "@/types/language.types";

export const LOCAL_ATOMS_PREFIX = "lerobot-annotations:v2:";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function localAtomsKey(repoOrPath: string, episodeId: number): string {
  return `${LOCAL_ATOMS_PREFIX}${repoOrPath}::${episodeId}`;
}

/** localStorage when it exists and can be touched (the accessor itself can
 * throw when site data is blocked); null otherwise. */
export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The local copy, or null when there is none (or it is unreadable). */
export function readLocalAtoms(
  repoOrPath: string,
  episodeId: number,
  storage: StorageLike | null = browserStorage(),
): LanguageAtom[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(localAtomsKey(repoOrPath, episodeId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LanguageAtom[]) : null;
  } catch {
    return null;
  }
}

/** Replace the local copy; false when storage is unavailable or full. */
export function writeLocalAtoms(
  repoOrPath: string,
  episodeId: number,
  atoms: LanguageAtom[],
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      localAtomsKey(repoOrPath, episodeId),
      JSON.stringify(atoms),
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- staging marker

/** What the batch itself staged into an episode's slot, kept beside the
 * slot: the next run treats a local copy equal to it as untouched (not
 * as unsaved edits), so re-running over staged episodes overwrites them. */
export const STAGED_MARKER_PREFIX = "lerobot-batch-staged:v1:";

export function stagedMarkerKey(repoId: string, episodeId: number): string {
  return `${STAGED_MARKER_PREFIX}${repoId}::${episodeId}`;
}

export function readStagedMarker(
  repoId: string,
  episodeId: number,
  storage: StorageLike | null = browserStorage(),
): LanguageAtom[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(stagedMarkerKey(repoId, episodeId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LanguageAtom[]) : null;
  } catch {
    return null;
  }
}

/** After a commit the marker has done its job. */
export function clearStagedMarker(
  repoId: string,
  episodeId: number,
  storage: StorageLike | null = browserStorage(),
): void {
  try {
    storage?.removeItem(stagedMarkerKey(repoId, episodeId));
  } catch {
    /* nothing to clear */
  }
}

/** Stage: the local copy AND the marker; false when either write failed. */
export function stageLocalAtoms(
  repoId: string,
  episodeId: number,
  atoms: LanguageAtom[],
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!writeLocalAtoms(repoId, episodeId, atoms, storage)) return false;
  if (!storage) return false;
  try {
    storage.setItem(stagedMarkerKey(repoId, episodeId), JSON.stringify(atoms));
    return true;
  } catch {
    return false;
  }
}
