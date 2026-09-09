// What the auto-labeler may replace, what it may save, and how a batch run
// merges with what is already on the Hub. Pure functions shared by the
// per-episode panel, the batch runner and the Hub save path, so the three
// never disagree about whose atoms are whose.
import type { LanguageAtom } from "@/types/language.types";

import type { RigProfile } from "./rigProfile";

/** Subtask labels the detector emits; a subtask atom with one of these and
 * the assistant role is the detector's, not a person's. */
export const AUTO_SUBTASK_LABELS = new Set([
  "approach",
  "grasp",
  "transport",
  "place_release",
]);

/** Auto-generated tactile EVENT atoms only (slip, contact, place, ...). */
export function isAutoEventAtom(a: LanguageAtom): boolean {
  return a.style === "interjection" && !!a.content?.startsWith("[auto:");
}

/** Every atom the detector wrote: its event interjections and its subtask
 * segments. Human-verified attempts (`failed_attempt ... (verified)`) and
 * hand-added atoms are not auto. */
export function isAutoAtom(a: LanguageAtom): boolean {
  if (isAutoEventAtom(a)) return true;
  if (
    a.style === "subtask" &&
    a.role === "assistant" &&
    a.content != null &&
    AUTO_SUBTASK_LABELS.has(a.content)
  )
    return true;
  return false;
}

/** Labels only the interpretation layer produces (the marker-honesty
 * renames). Base mode never emits them; an opted-in run does. */
const INTERPRETATION_LABEL =
  /^\[auto:\w+\] (finger_unload|sensor_residual|phantom)\b/;

export function isInterpretationAtom(a: LanguageAtom): boolean {
  return isAutoEventAtom(a) && INTERPRETATION_LABEL.test(a.content ?? "");
}

/** The per-episode run's replacement rule, as a pure function: keep every
 * human atom of `existing`, drop its auto atoms (or only its auto EVENT
 * atoms in events-only mode), then append what the detector recorded. */
export function mergeAutoAtoms(
  existing: LanguageAtom[],
  recorded: LanguageAtom[],
  eventsOnly = false,
): LanguageAtom[] {
  const drop = eventsOnly ? isAutoEventAtom : isAutoAtom;
  const kept = existing.filter((a) => !drop(a));
  const added = eventsOnly
    ? recorded.filter((a) => a.style === "interjection")
    : recorded;
  return [...kept, ...added];
}

/** Jingyi's save rule (PR #2 merge note): "when profile_unverified is set,
 * Save will skip the interpretation layer atoms so template runs can be
 * viewed on a new rig but never committed until a verified profile exists."
 * With a verified profile (or none known) everything saves; with an
 * unverified one the interpretation-layer atoms stay out of the file.
 * Human atoms always save. To be reconciled with her own commit on main. */
export function atomsForSave(
  atoms: LanguageAtom[],
  profile: RigProfile | null | undefined,
): LanguageAtom[] {
  if (!profile || profile.verified) return atoms;
  return atoms.filter((a) => !isInterpretationAtom(a));
}

/** Identity of an atom for change detection (4 decimals = sub-frame). */
export function atomKey(a: LanguageAtom): string {
  return `${a.style ?? ""}|${a.role}|${a.timestamp.toFixed(4)}|${a.content ?? ""}`;
}

/** True when the two sets carry the same atoms (order-insensitive). */
export function sameAtomSet(a: LanguageAtom[], b: LanguageAtom[]): boolean {
  if (a.length !== b.length) return false;
  const count = new Map<string, number>();
  for (const x of a) count.set(atomKey(x), (count.get(atomKey(x)) ?? 0) + 1);
  for (const y of b) {
    const k = atomKey(y);
    const n = count.get(k);
    if (!n) return false;
    if (n === 1) count.delete(k);
    else count.set(k, n - 1);
  }
  return count.size === 0;
}
