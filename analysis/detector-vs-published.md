# Detector-vs-published audit: her manual corrections, recovered

2026-08-27. Produced by `scripts/run-detector.ts --all --compare --report
analysis/detector-vs-published.json` — the offline runner replays the app's
exact auto-label pipeline (raw 91 Hz sidecars, clipped to the table window,
default thresholds) on the pinned `data/sotac` mirror and diffs against the
published `annotations/*.json`.

## Harness fidelity

24 of 59 published episodes reproduce **bit-exactly** (timestamps to 4
decimals). Zero moved and zero modified atoms across all matches. The runner
is a faithful offline replica of the in-app pipeline.

## What the mismatches are: her corrections, invisible until now

The ground-truth audit (`ground-truth-deltas.md`) showed the 0–5 save pairs
contain no human edits *between saves*. Re-running the detector fresh reveals
the edits that were already inside every save. Three kinds:

**1. Subtask boundary drags — her most frequent fix (30 drags, 24 episodes).**
The auto segmenter anchors `grasp` at the first sustained jaw-closing bout;
on 40% of episodes that fires during approach, seconds early. She drags the
boundary to the real grasp: median shift ≈ **+3.2 s**, 29 of 30 shifts are
later-in-time (e.g. ep23: 0.87 → 7.53 s). Threshold explanations are ruled
out (`gripperVelEps` up to 6× default does not move the boundary; every
shared event stays bit-identical). Drags survive re-runs via the panel's
"events only (keep subtasks)" mode — which is why both ep0 saves already
carried grasp @ 5.371 while a fresh run says 1.87.

**2. Event deletions — 73 false positives removed.** Published files on 35
episodes are missing events a fresh default run produces, with survivors
bit-identical (strict-subset signature on 11 episodes; threshold changes
would perturb survivors, tested and excluded). By class:

| Deleted class | Count | Reading |
|---|---|---|
| `place` | 26 | worst precision offender despite the persistence check |
| `contact_onset` | 17 | approach brushes the 0.2 s debounce still misses |
| `slip` | 13 | mostly late-episode bursts (e.g. ep37: five f1 slips at 11–13 s) |
| `drop` / `release` / `grasp_stable` | 6 / 4 / 4 | |

By confidence of the deleted events: **medium 59, low 6, high 5** — her
deletions concentrate in `medium`, so the confidence tags carry real signal.

**3. Ten unexplained auto-format events** in her files that a fresh default
run does not produce (slip 4, drop 4, contact 1, release 1) — likely from
threshold-slider sessions; minor, flagged for the conversation with her.

## Addendum: grasp-anchor fix + the clock-skew discovery (same day, later)

**Fix shipped** in `visualizer/src/lib/eventDetection.ts` (+68/−19, the only
file changed): the `grasp` subtask now anchors to the closing motion that
leads to the grasp's contact — contact reference = the contact preceding the
first `grasp_stable` (approach brushes no longer pull it early), and
connected closing bouts (pauses ≤ 1 s) are walked back as one motion.
Result on the 30 dragged boundaries: disagreeing episodes 18 → 14, median
|error| **3.48 s → 1.88 s**; exact-match episodes 24 → 23 (ep16 regressed,
see below). Verified: `bun test` 157/157, type-check clean; `bun run lint`
fails on a pre-existing `react/no-unescaped-entities` error in upstream code
we did not touch.

**Why the residual errors will not yield to anchor tuning — the streams are
skewed in time.** Matching ep30's events against its jaw trace shows the
raw-sidecar clock and the main-table clock disagree by a **time-varying**
few hundred ms: the jaw-close plunge appears ~0.67 s *after* the contact it
causes; ~0.25 s at release. Cause is unresolved (raw rows are stamped with
host receipt time — USB batching jitter — while table timestamps are ideal
1/30 s ticks). A constant-shift correlation estimator was implemented,
found the offset non-constant, and was **reverted** — a scalar shift is the
wrong model. Consequences:

- Every gripper-gated decision (release-vs-drop, lift, place gating, all
  subtask boundaries) inherits the skew, in the app and offline alike.
- Auto event timestamps are skewed relative to the video timeline the
  annotator sees — plausibly part of why her boundary drags exist at all.
- `alignment.json` was created for exactly this and the visualizer ignores
  it; but the table side has no absolute anchor, so a proper fix needs a
  drift-aware alignment (or recorder-side wall-clock timestamps per frame —
  a `lerobotac` change to propose to Jingyi).
- This also contaminates T1.3 (30 vs 91 Hz comparison): the raw stream's
  effective sample spacing is receipt-jittered.

A `KNOWN DEFECT` comment marks the resample site in `eventDetection.ts`.

## What this gives us

- **A per-class precision signal**: the 73 deletions are labeled false
  positives. No recall signal exists (nothing tells us what the detector
  *missed*) — fresh hand-labeling is still needed for that.
- **A concrete, high-value fix**: anchor the `grasp` subtask start to the
  closing bout that *leads to contact* (symmetric with how `place_release`
  anchors to the final release), instead of the first sustained closing.
  That directly eliminates her most frequent manual correction.
- **Ranked precision work**: `place` first (26), contact debounce second
  (17), late-episode slip bursts third (13).
