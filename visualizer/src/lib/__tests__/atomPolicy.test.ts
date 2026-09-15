import { describe, expect, test } from "bun:test";

import type { LanguageAtom } from "@/types/language.types";

import {
  atomsForSave,
  isAutoAtom,
  isAutoEventAtom,
  isInterpretationAtom,
  mergeAutoAtoms,
  sameAtomSet,
} from "../atomPolicy";
import { SOTAC_PROFILE, TEMPLATE_PROFILE } from "../rigProfile";

const atom = (
  style: LanguageAtom["style"],
  content: string,
  timestamp: number,
  role: LanguageAtom["role"] = "assistant",
): LanguageAtom => ({ role, content, style, timestamp, camera: null });

const humanNote = atom("interjection", "ball slipped here", 4.2, "user");
const verified = atom("interjection", "failed_attempt 0.70s (verified)", 3.1);
const autoEvent = atom(
  "interjection",
  "[auto:high] release f0 2.1N jaw+42.8u",
  9.9,
);
const autoRename = atom(
  "interjection",
  "[auto:high] finger_unload f0 2.1N (hand still holding)",
  8.1,
);
// the detector's subtask carries its mark; the panel's manual add and a
// dragged detector atom have the assistant role and no mark
const autoSubtask: LanguageAtom = {
  ...atom("subtask", "grasp", 6.1),
  origin: "auto",
};
const humanSubtask = atom("subtask", "grasp", 6.0);

describe("auto-atom predicates", () => {
  test("detector atoms vs human atoms", () => {
    expect(isAutoEventAtom(autoEvent)).toBe(true);
    expect(isAutoAtom(autoSubtask)).toBe(true);
    expect(isAutoAtom(humanSubtask)).toBe(false);
    expect(isAutoAtom(humanNote)).toBe(false);
    expect(isAutoAtom(verified)).toBe(false); // human-verified attempt
    expect(isInterpretationAtom(autoRename)).toBe(true);
    expect(isInterpretationAtom(autoEvent)).toBe(false);
  });
});

describe("mergeAutoAtoms (the per-episode replacement rule)", () => {
  const existing = [humanNote, verified, autoEvent, autoSubtask, humanSubtask];
  const recorded = [
    atom("interjection", "[auto:high] release f0 2.0N", 9.8),
    atom("subtask", "transport", 8.2),
  ];

  test("keeps every human atom, replaces the detector's", () => {
    const m = mergeAutoAtoms(existing, recorded);
    expect(m).toContain(humanNote);
    expect(m).toContain(verified);
    expect(m).toContain(humanSubtask);
    expect(m).not.toContain(autoEvent);
    expect(m).not.toContain(autoSubtask);
    expect(m.slice(-2)).toEqual(recorded);
  });

  test("events-only mode leaves auto subtasks alone and adds only events", () => {
    const m = mergeAutoAtoms(existing, recorded, true);
    expect(m).toContain(autoSubtask);
    expect(m).not.toContain(autoEvent);
    expect(
      m.filter((a) => a.style === "subtask" && a.content === "transport"),
    ).toHaveLength(0);
  });
});

describe("atomsForSave (Jingyi's unverified-profile rule)", () => {
  const atoms = [humanNote, autoEvent, autoRename, autoSubtask];
  test("a verified profile saves everything", () => {
    expect(atomsForSave(atoms, SOTAC_PROFILE)).toEqual(atoms);
  });
  test("no profile yet counts as unverified", () => {
    expect(atomsForSave(atoms, null)).not.toContain(autoRename);
    expect(atomsForSave(atoms, undefined)).toContain(humanNote);
  });
  test("an unverified profile keeps the base taxonomy and human atoms, drops the interpretation layer's", () => {
    const kept = atomsForSave(atoms, TEMPLATE_PROFILE);
    expect(kept).toContain(humanNote);
    expect(kept).toContain(autoEvent);
    expect(kept).toContain(autoSubtask);
    expect(kept).not.toContain(autoRename);
  });
});

describe("sameAtomSet", () => {
  test("order-insensitive, multiplicity-sensitive", () => {
    expect(sameAtomSet([humanNote, autoEvent], [autoEvent, humanNote])).toBe(
      true,
    );
    expect(sameAtomSet([humanNote], [humanNote, humanNote])).toBe(false);
    expect(sameAtomSet([autoEvent], [{ ...autoEvent, timestamp: 9.91 }])).toBe(
      false,
    );
  });
});
