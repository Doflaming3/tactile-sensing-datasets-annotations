// What the auto-labeler may replace, what it may save, and how a batch run
// merges with what is already on the Hub. Pure functions shared by the
// per-episode panel, the batch runner and the Hub save path, so the three
// never disagree about whose atoms are whose.
import type { LanguageAtom } from "@/types/language.types";

import type { RigProfile } from "./rigProfile";

/** Subtask labels the detector emits. They do NOT identify the detector's
 * atoms: a hand-added subtask and a dragged detector atom carry the same
 * role and label (review of PR #3, item 2). The detector's mark does. */
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
  // a subtask atom is the detector's only when it carries the detector's
  // mark; an unmarked one (hand-added, or a detector atom someone dragged)
  // is a person's and survives every re-run
  return a.style === "subtask" && a.origin === "auto";
}

/** An atom a person changed — dragged on the timeline, edited in the
 * panel — is a person's from then on: the detector's mark goes, so no
 * later run replaces it. (Its events keep their `[auto:…]` prefix; that
 * is their label, not a mark.) */
export function editedAtom(
  a: LanguageAtom,
  updates: Partial<LanguageAtom>,
): LanguageAtom {
  const next: LanguageAtom = { ...a, ...updates };
  delete next.origin;
  return next;
}

/** Labels only the interpretation layer produces (the marker-honesty
 * renames). Base mode never emits them; an opted-in run does. */
const INTERPRETATION_LABEL =
  /^\[auto:\w+\] (finger_unload|sensor_residual|phantom)\b/;

export function isInterpretationAtom(a: LanguageAtom): boolean {
  return isAutoEventAtom(a) && INTERPRETATION_LABEL.test(a.content ?? "");
}

/** What the detector may add next to the atoms a run keeps: its events
 * (only those, in events-only mode) and its subtask segments, except a
 * segment whose label a kept atom already carries — a person's subtask,
 * or an unmarked one from a file written before the mark existed, wins at
 * its own time, so no episode gets a second set. */
export function autoAtomsToAdd(
  kept: LanguageAtom[],
  recorded: LanguageAtom[],
  eventsOnly = false,
): LanguageAtom[] {
  const taken = new Set(
    kept
      .filter((a) => a.style === "subtask" && a.content != null)
      .map((a) => a.content as string),
  );
  return recorded.filter((a) => {
    if (eventsOnly) return a.style === "interjection";
    if (a.style === "subtask" && a.content != null && taken.has(a.content))
      return false;
    return true;
  });
}

/** The per-episode run's replacement rule, as a pure function: keep every
 * atom of `existing` that is not the detector's own (or only drop its
 * EVENT atoms in events-only mode), then add what the detector recorded
 * through autoAtomsToAdd. */
export function mergeAutoAtoms(
  existing: LanguageAtom[],
  recorded: LanguageAtom[],
  eventsOnly = false,
): LanguageAtom[] {
  const drop = eventsOnly ? isAutoEventAtom : isAutoAtom;
  const kept = existing.filter((a) => !drop(a));
  return [...kept, ...autoAtomsToAdd(kept, recorded, eventsOnly)];
}

/** Jingyi's save rule (PR #2 merge note): "when profile_unverified is set,
 * Save will skip the interpretation layer atoms so template runs can be
 * viewed on a new rig but never committed until a verified profile exists."
 * With a verified profile everything saves; with an unverified one, or
 * none known yet, the interpretation-layer atoms stay out of the file.
 * Human atoms always save. To be reconciled with her own commit on main. */
export function atomsForSave(
  atoms: LanguageAtom[],
  profile: RigProfile | null | undefined,
): LanguageAtom[] {
  // no profile yet (the moment after a page load) counts as unverified:
  // the interpretation layer's atoms never reach a file on a guess
  if (profile?.verified) return atoms;
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
