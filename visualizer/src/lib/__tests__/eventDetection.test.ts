import { describe, expect, it } from "bun:test";

import {
  BRIEF_CONTACT_STRONG_N,
  WEAK_ATTEMPT_MAX_N,
  resultToAtoms,
  resultToRecordedAtoms,
  type AutoLabelResult,
} from "../eventDetection";

// Shaped like sotac ep25: a real task, then a post-task phantom span on
// finger 1 (14.1-16.6 s) whose events the gate downgraded to low. The
// OTHER finger's genuine release at 14.18 sits INSIDE that span and must
// survive recording.
const ep25ish: AutoLabelResult = {
  subtasks: [
    { label: "approach", startS: 0, endS: 8.4 },
    { label: "grasp", startS: 8.4, endS: 9.2 },
    { label: "transport", startS: 9.2, endS: 13.8 },
    { label: "place_release", startS: 13.8, endS: 17.0 },
  ],
  events: [
    // the weak-graze span's events (flagged weak_contact, phantom by the
    // 2.3 N calibration) — its exit escapes as a MEDIUM release
    {
      label: "contact_onset",
      startS: 1.35,
      endS: 1.35,
      finger: 1,
      confidence: "low",
    },
    {
      label: "release",
      startS: 1.834,
      endS: 1.834,
      finger: 1,
      confidence: "medium",
    },
    {
      label: "contact_onset",
      startS: 8.5,
      endS: 8.5,
      finger: 1,
      confidence: "high",
    },
    {
      label: "release",
      startS: 11.68,
      endS: 11.68,
      finger: 1,
      confidence: "high",
    },
    {
      label: "release",
      startS: 14.179,
      endS: 14.179,
      finger: 0,
      confidence: "medium",
    },
    // the phantom chain (gated to low)
    {
      label: "contact_onset",
      startS: 14.113,
      endS: 14.113,
      finger: 1,
      confidence: "low",
    },
    {
      label: "grasp_stable",
      startS: 15.537,
      endS: 15.537,
      finger: 1,
      confidence: "low",
    },
    {
      label: "drop",
      startS: 16.577,
      endS: 16.577,
      finger: 1,
      confidence: "low",
    },
  ],
  flags: ["post_task_contact@14.1-16.6s", "weak_contact@1.3-1.8s"],
  spans: [
    { kind: "post_task_contact", startS: 14.1, endS: 16.6, finger: 1 },
    { kind: "weak_contact", startS: 1.3, endS: 1.8, finger: 1 },
  ],
};

describe("resultToRecordedAtoms", () => {
  it("drops low-confidence events inside post_task_contact spans", () => {
    const recorded = resultToRecordedAtoms(ep25ish);
    const contents = recorded.map((a) => a.content);
    expect(contents).not.toContain("[auto:low] contact_onset f1");
    expect(contents).not.toContain("[auto:low] grasp_stable f1");
    expect(contents).not.toContain("[auto:low] drop f1");
  });

  it("keeps the other finger's genuine terminal inside the span", () => {
    const recorded = resultToRecordedAtoms(ep25ish);
    expect(recorded.map((a) => a.content)).toContain(
      "[auto:medium] release f0",
    );
  });

  it("drops ALL events inside weak_contact spans, medium included", () => {
    const recorded = resultToRecordedAtoms(ep25ish);
    const contents = recorded.map((a) => a.content);
    expect(contents).not.toContain("[auto:medium] release f1");
    expect(contents).not.toContain("[auto:low] contact_onset f1");
  });

  it("keeps everything outside the spans, subtasks included", () => {
    const recorded = resultToRecordedAtoms(ep25ish);
    const contents = recorded.map((a) => a.content);
    expect(contents).toContain("[auto:high] release f1");
    expect(contents).toContain("place_release");
    expect(recorded.length).toBe(resultToAtoms(ep25ish).length - 5);
  });

  it("is the identity when no phantom span exists", () => {
    const noSpan: AutoLabelResult = {
      ...ep25ish,
      // a LOW event outside any span must survive (low != phantom:
      // real quiet drops are low too)
      events: ep25ish.events.filter((e) => e.startS > 2),
      flags: [],
      spans: [],
    };
    expect(resultToRecordedAtoms(noSpan)).toEqual(resultToAtoms(noSpan));
  });
});

describe("slide data suffix", () => {
  it("serializes slide (signed mm) and jaw travel on an enriched slip", () => {
    const withSlide: AutoLabelResult = {
      subtasks: [],
      events: [
        {
          label: "slip",
          startS: 10.3,
          endS: 10.5,
          finger: 0,
          confidence: "medium",
          data: { slide: -2.47, jaw: 5.11 },
        },
      ],
      flags: ["sustained_slide@10.2s"],
      spans: [],
    };
    const contents = resultToAtoms(withSlide).map((a) => a.content);
    expect(contents).toContain(
      "[auto:medium] slip f0 0.20s slide-2.5mm jaw+5.1u",
    );
  });
});

describe("finger-scoped span deletion (Jingyi's blocker 3)", () => {
  // finger 1 grazes 1.3-1.8 s (weak_contact, phantom by calibration) while
  // finger 0 has a REAL medium event inside that window
  const base: AutoLabelResult = {
    subtasks: [],
    events: [
      {
        label: "contact_onset",
        startS: 1.35,
        endS: 1.35,
        finger: 1,
        confidence: "low",
      },
      {
        label: "release",
        startS: 1.8,
        endS: 1.8,
        finger: 1,
        confidence: "medium",
      },
      {
        label: "contact_onset",
        startS: 1.5,
        endS: 1.5,
        finger: 0,
        confidence: "medium",
      },
    ],
    flags: ["weak_contact@1.3-1.8s"],
    spans: [{ kind: "weak_contact", startS: 1.3, endS: 1.8, finger: 1 }],
  };

  it("a one-finger span deletes only that finger's events", () => {
    const contents = resultToRecordedAtoms(base).map((a) => a.content);
    expect(contents).not.toContain("[auto:low] contact_onset f1");
    expect(contents).not.toContain("[auto:medium] release f1");
    expect(contents).toContain("[auto:medium] contact_onset f0");
  });

  it("a hand-level span (finger null) covers both fingers", () => {
    const hand: AutoLabelResult = {
      ...base,
      spans: [{ kind: "weak_contact", startS: 1.3, endS: 1.8, finger: null }],
    };
    const contents = resultToRecordedAtoms(hand).map((a) => a.content);
    expect(contents).not.toContain("[auto:medium] contact_onset f0");
    expect(contents.length).toBe(0);
  });

  it("post_task_contact drops only its finger's LOW events", () => {
    const pt: AutoLabelResult = {
      ...base,
      events: base.events.map((e) => ({ ...e, confidence: "low" as const })),
      flags: ["post_task_contact@1.3-1.8s"],
      spans: [{ kind: "post_task_contact", startS: 1.3, endS: 1.8, finger: 1 }],
    };
    const contents = resultToRecordedAtoms(pt).map((a) => a.content);
    expect(contents).toEqual(["[auto:low] contact_onset f0"]);
  });
});

describe("weak line and brief-contact bar are one calibration", () => {
  it("the reporting bar sits a declared margin below the weak line", () => {
    expect(BRIEF_CONTACT_STRONG_N).toBeLessThan(WEAK_ATTEMPT_MAX_N);
    expect(BRIEF_CONTACT_STRONG_N).toBeCloseTo(2.0, 6);
    expect(WEAK_ATTEMPT_MAX_N).toBeCloseTo(2.3, 6);
  });
});
