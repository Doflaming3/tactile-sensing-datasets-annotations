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

**RETRACTION (verified same day, later): there is NO clock skew on sotac.**
The skew hypothesis came from misreading ep30 causality — the first contact
there is caused by the *arm descending* onto the foam ball while the jaw is
stationary; the jaw squeeze at 6.6 s happens after first touch, which is
physically fine. The decisive instrument: every 30 Hz table frame's tactile
field is a sample-and-hold snapshot of the latest 91 Hz raw row, so matching
frames to rows **by content** recovers (tableT, rawT) anchor pairs with no
clock model. On sotac the recovered map is **identity to ~2 ms across the
whole episode**. Event timestamps are therefore trustworthy relative to the
video timeline; a constant-shift estimator tried earlier was correctly
reverted, but for the wrong reason.

The instrument survives as `buildTableToRawClockMap` in `eventDetection.ts`:
a per-episode alignment *check* on sotac, and the missing-alignment supplier
for per-episode-folder company-format data (only first-sample-alignable,
~1 s error). **Do not use it as a gripper-time transform on sotac**: anchor
pairs exist only during contact, and interpolation between sparse anchors
can go non-monotone, corrupting the velocity resampler (measured: corpus
match rate collapsed 23 → 2 with remapping enabled; removed).

Residual grasp-boundary errors after the anchor fix are therefore her
placement tolerance (drags land 0.2–1.5 s before the kept first contact)
plus genuinely ambiguous cases where contact comes from arm motion with the
jaw already positioned — not a timestamp defect. Further anchor tuning
would be fitting hand jitter; stopped at median 1.88 s.

## Addendum 2: failed-attempt detection (flags-only, validated vs her metadata)

Motivated by ep49 (gripped → ball slid out → re-gripped, confirmed on
video): the detector now emits a `failed_attempt@Xs` **flag** for each
pre-grasp drop cluster (drops within 0.5 s = one physical loss). Flags
only — the Table VIII taxonomy has no retry class, so nothing enters the
event stream until that question is settled with Jingyi.

Validation against `episode_annotations.json`'s hand-recorded `attempts`
field: **45/59 episodes agree** (detected = 1 + failed-attempt flags).
The 14 disagreements split into exactly the two expected failure modes:

- **7 over-counts** (eps 21, 25, 36, 37, 40, 42): our flag rests on a drop
  event *she deleted as a false positive* — the attempt detector inherits
  the drop detector's precision problem, nothing new.
- **8 under-counts** (eps 16, 31, 32, 39, 45, 47, 54, 56): failed attempts
  with no tactile drop signature — most plausibly the jaw closed on air
  (no contact ⇒ no tactile event possible) or the object slipped without
  force fully exiting. Detecting these needs the gripper trajectory
  (pre-grasp closing bouts with no contact), a natural v2.

Note ep16 appears both here (attempts=2) and as the grasp-anchor
regression: with two genuine attempts, "where grasp starts" is ambiguous
even for a human — her boundary sits on attempt 1, ours on attempt 2.

**Ep16 deep-dive (video + raw trace): the "invisible" attempt is neither
air nor sub-threshold.** The failed grab used the *edge* of the sensor pad
and left a real burst — 1.4→3.8 N across up to 19 taxels for ~0.17 s at
2.64 s — which the 0.2 s contact-entry debounce (`ENTER_MIN_S`) erased.
Sub-duration, not sub-threshold. (Side observation: during the burst the
firmware's own resultant channel read ~0.1 N while the taxel sum hit
3.8 N — edge contact appears to break the resultant computation.)

Corpus scan of that "strong brief burst" signature (sum fz > 0.15 N for
0.03–0.20 s, peak ≥ 1 N): **recall is there — 7 of the 8 under-counted
multi-attempt episodes contain one** (all but ep32). But **precision is
hopeless ungated: 47 of 63 episodes** have such bursts (grasp settling,
slip transients, place impacts, episode-start artifacts).

**What shipped (after two rejected designs):** the entry debounce now has
a strength exception, evaluated on the **unfiltered** force (`fnRaw` — the
median-5 smoothing that protects sustained detection flattens 3–4-sample
grazes below every threshold). A sub-0.2 s run yields a low-confidence
`contact_onset` + `drop` pair when it lasts ≥ 0.03 s, peaks ≥ 2 N, starts
after the 0.5 s episode-start settling window (ep58 has a 2.2 N start-up
spike), and precedes the finger's first held contact. Existing taxonomy
classes; the drop-based `failed_attempt` flag counts them automatically.

Video-verified wins: ep16 (`brief 3.8N` @ 2.64) and **ep54 with BOTH
failed attempts** (`@2.4s` f1 5.2 N, `@3.4s` f0 2.4 N — Zheng confirmed
two failed grabs on video; her metadata records only 2 total attempts, so
the `attempts` field itself undercounts and is label-noisy as a validation
target). Corpus: metadata agreement 43/59, exact bit-matches 23 → 21 —
both drops are recovered-attempt pairs the published files lack, i.e.
correct differences. Awaiting video verdicts (real attempt vs approach
nudge): ep9 @2.8, ep22 @2.9, ep23 @5.0. Two rejected designs for the
record: burst-must-overlap-jaw-closing (zero yield — grazes precede the
close) and jaw-close-with-no-contact (user rejected non-tactile judgment).
Still invisible: ep31/32/39/45/47/56 — below 2 N or under 3 raw frames;
those need her metadata or video.

## Addendum 3: trial-aware segmentation (ep56, video-verified failure)

Ep56 exposed the structural gap behind every remaining anchor patch: the
pipeline had no concept of a *trial*. Its trial 1 (5.1–6.8 s) reaches a
brief false stability (object squeezed against the surface), the FIRST
`grasp_stable` captured the grasp anchor, and transport started
mid-failure — the real grasp only begins at 9.0 s.

Reworked: per-finger contact spans (contact_onset → release/drop) merge
across fingers into hand-level **bouts** (= trials); the bout holding the
**last** `grasp_stable` is the grasp; the anchor chain never crosses into
a previous trial and the grasp start clamps to the previous trial's end.
Every earlier bout becomes `failed_attempt@start-end` — subsuming the
drop-cluster logic and catching losses classified as `release` ("lost,
not dropped").

Result: ep56 → `approach 0–6.8 (containing failed_attempt@5.1-6.8s) →
grasp 6.8–9.4 → transport 9.4–12.9` (her hand-dragged transport: 11.3;
previous auto: 5.5). Metadata agreement 45/59 with ep31, ep39, ep56 newly
agreeing; ep49/16/54 unchanged.

**Scope limit (by design): single-cycle episodes only.** "Grasp = bout
with the last stable" is correct for sotac because every episode is one
pick-and-place. A multi-cycle episode (place into bowl, pick up again,
drop) would shove the first — successful — cycle into approach and flag
it failed. The general fix is bout-CONTENT classification (bout ends in a
real place+release ⇒ completed cycle, gets its own subtask segments;
otherwise ⇒ failed attempt), which strictly generalizes the current rule
— but it is gated on place-detector precision: ep56's failed trial itself
contains two FALSE place events, so today the predicate would misfire.
Order of work: place precision → bout-content classification →
cycle-aware segmentation (repeated subtask segments = output-convention
change, Table VIII conversation). Still open: ep45-class losses *inside*
the final grasp bout (secured-then-lost with no re-grasp — a definition
question), ep32 (zero trace), ep47 (sub-2 N touches), and a ~10-episode
judgment queue (0, 9, 21, 22, 23, 25, 36, 37, 40, 42) where flagged bouts
await video verdicts against the known-undercounting `attempts` metadata.

- **A per-class precision signal**: the 73 deletions are labeled false
  positives. No recall signal exists (nothing tells us what the detector
  *missed*) — fresh hand-labeling is still needed for that.
- **A concrete, high-value fix**: anchor the `grasp` subtask start to the
  closing bout that *leads to contact* (symmetric with how `place_release`
  anchors to the final release), instead of the first sustained closing.
  That directly eliminates her most frequent manual correction.
- **Ranked precision work**: `place` first (26), contact debounce second
  (17), late-episode slip bursts third (13).
