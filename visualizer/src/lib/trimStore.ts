// The reviewer's trim decision per episode, kept in this browser: the
// rule's proposal until someone drags a handle (then `adjusted`), and a
// `reviewed` mark. The trim page reads them all, the trim panel edits one,
// the executor (backend /api/trim) receives them as cuts. Same storage
// discipline as the annotation copies (localAtoms.ts).
import { browserStorage, type StorageLike } from "./localAtoms";
import type { TrimProposal } from "./trimDetect";

export const TRIM_PREFIX = "lerobot-trim:v1:";

export interface TrimDecision {
  /** first kept frame */
  startFrame: number;
  /** last kept frame, inclusive */
  endFrame: number;
  nFrames: number;
  fps: number;
  source: "rule" | "adjusted";
  reviewed: boolean;
  flags: string[];
  savedAt: string;
}

export function trimKey(repoId: string, episodeId: number): string {
  return `${TRIM_PREFIX}${repoId}::${episodeId}`;
}

export function decisionFromProposal(
  p: TrimProposal,
  now: () => Date = () => new Date(),
): TrimDecision {
  return {
    startFrame: p.startFrame,
    endFrame: p.endFrame,
    nFrames: p.nFrames,
    fps: p.fps,
    source: "rule",
    reviewed: false,
    flags: [...p.flags],
    savedAt: now().toISOString(),
  };
}

export function readTrim(
  repoId: string,
  episodeId: number,
  storage: StorageLike | null = browserStorage(),
): TrimDecision | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(trimKey(repoId, episodeId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<TrimDecision>;
    if (
      typeof d.startFrame !== "number" ||
      typeof d.endFrame !== "number" ||
      typeof d.nFrames !== "number"
    )
      return null;
    return {
      startFrame: d.startFrame,
      endFrame: d.endFrame,
      nFrames: d.nFrames,
      fps: typeof d.fps === "number" ? d.fps : 30,
      source: d.source === "adjusted" ? "adjusted" : "rule",
      reviewed: d.reviewed === true,
      flags: Array.isArray(d.flags) ? d.flags.map(String) : [],
      savedAt: typeof d.savedAt === "string" ? d.savedAt : "",
    };
  } catch {
    return null;
  }
}

export function writeTrim(
  repoId: string,
  episodeId: number,
  d: TrimDecision,
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(trimKey(repoId, episodeId), JSON.stringify(d));
    return true;
  } catch {
    return false;
  }
}

export function clearTrim(
  repoId: string,
  episodeId: number,
  storage: StorageLike | null = browserStorage(),
): void {
  try {
    storage?.removeItem(trimKey(repoId, episodeId));
  } catch {
    /* nothing to clear */
  }
}

/** Every decision of a dataset in this browser, by episode. */
export function listTrims(
  repoId: string,
  storage:
    | (StorageLike & { length?: number; key?: (i: number) => string | null })
    | null = browserStorage() as
    | (StorageLike & { length?: number; key?: (i: number) => string | null })
    | null,
): Map<number, TrimDecision> {
  const out = new Map<number, TrimDecision>();
  if (!storage || typeof storage.length !== "number" || !storage.key)
    return out;
  const prefix = `${TRIM_PREFIX}${repoId}::`;
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const ep = Number(k.slice(prefix.length));
      if (Number.isNaN(ep)) continue;
      const d = readTrim(repoId, ep, storage);
      if (d) out.set(ep, d);
    }
  } catch {
    /* storage unavailable */
  }
  return out;
}

/** Cuts for the executor: episode -> [first kept frame, last kept frame]. */
export function cutsFromDecisions(
  decisions: Map<number, TrimDecision>,
): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const [ep, d] of [...decisions].sort((a, b) => a[0] - b[0]))
    out[String(ep)] = [d.startFrame, d.endFrame];
  return out;
}
