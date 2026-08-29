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

## Addendum 5: phantom readings — two no-contact mechanisms, one fixed

Zheng video-verified that the flagged "attempts" on eps 25/42/9 involved
NO contact at all — fingertip pads in the air (jaw open at 26–82 units)
while the sensor read light force. Start-of-episode rest-force scan
across all 63 episodes splits the phenomenon:

1. **Baseline drift / LSB flicker** — firmware zeroes once per SESSION,
   at connect. Zheng's ep43 verdict ("air" at the 2.07 s contact) forced
   a closer look at the shape: NOT slow drift but **flicker** — 5–13
   taxels toggling at 1–2 LSB (0.1–0.2 N each), the finger sum swinging
   0 ↔ 2.6 N for seconds, with occasional full-zero frames, sometimes
   settling into a quasi-steady ~1.8 N phantom (ep43, ep47 f0). Partial
   fix shipped: per-episode per-taxel baseline (median of first 0.4 s)
   plus an ADAPTIVE tracker (tau 1.5 s) that follows the wandering zero
   while the finger is idle (< 1 N) and freezes under load. This absorbs
   the standing-offset family (0.2 N eps, ep25's 4.4 s phantom) but NOT
   the settled flicker (ep43 @2.07, ep47 @1.41 keep one phantom medium
   contact each). **Deliberately not chased further**: the next patch (a
   ~0.25 N per-taxel deadband) would erase the video-verified ep16 graze
   (real contact at the same ~0.2 N/taxel amplitude); flicker and real
   edge-grazes differ only in temporal persistence, and the damage is one
   phantom atom on two episodes — flags, counts, and boundaries all
   unaffected. The real fix is recorder-side per-episode re-zeroing
   (firmware calibrate per episode, or `software_baseline_frames`) —
   recommendation to Jingyi, now with the flicker evidence attached.
   **Blind-zone check passed (Zheng, video):** the two candidate episodes
   for real sub-1 N attempts (ep39 0–2.5 s, ep47 0–3.7 s — metadata says
   2 attempts on both; their weak bouts were absorbed by the baseline)
   show NO touching on video. The absorbed signal was phantom, the 1 N
   quiet margin stands, and those episodes' extra "attempts" never
   reached the sensing area — the true sensor floor.
   **Zero-frame census (last discriminator tested, inverted result):**
   real light grazes BLINK — 29–64% of frames inside the video-verified
   ep16/ep54 grazes are all-zero (firmware distributed-block dropouts +
   genuine 1–2 LSB toggling) — while ep43's phantom is 0% zeros
   (rock-steady) and ep47's is 24%. No gate exists in either direction.
   The settled phantom is hereby classified NOT SEPARABLE from real
   contact at signal level; residual = phantom force visible in panels +
   one phantom contact atom on eps 43/47. Remaining fixes are outside the
   signal path: recorder per-episode re-zero (Jingyi — her own ep43 note
   says "tactile baseline noise on finger 0 at episode start"), and the
   review workflow's episode-notes field. NEW sensor fact for C6/Paxini:
   real brief grazes are 30–60% firmware zero-dropouts — also why brief
   contacts interact badly with the median filter.
2. **Motion-coincident phantoms** — eps 25/9 rest at exactly 0.0 and the
   readings appear only while the arm moves, pads in air. Mechanism
   unknown (fz is UNSIGNED by sensor firmware design, so oscillation
   signatures are unobservable — a fact for the C6 conversation).
   Guarded by the 2.3 N weak-bout downgrade (`weak_contact` flags),
   calibrated on 7 video verdicts: false ≤ 2.2 N, real ≥ 2.4 N.

Attempt agreement after both: **51/59**, remaining disagreements fully
classified (54 = metadata undercount, we are right; 0/21/22 = strong
4.2–4.8 N bouts awaiting video verdicts; 32/39/45/47 = below sensor or
definition floor).

## Addendum 4: transport anchor — grasp-READY, not first-stability

Audit of her 12 hand-dragged transport boundaries: the old anchor (first
`grasp_stable`) was earlier than her value on **12 of 12**, median 0.91 s
— she consistently places transport after the grip has finished settling.
New anchor: **the latest of each finger's first `grasp_stable`** in the
grasp bout, capped at first-stability + 1.5 s (a second finger stabilizing
later than that is a re-grip, not settling — ep24). Dragged-set error
0.91 → 0.54 median with 5 of 12 (24, 30, 31, 32, 47) now agreeing
outright; ~20 previously accepted (unreviewed) boundaries shift 0.2–1.5 s
later — the same direction as every one of her corrections.

Two consequences recorded: (1) **the `lift` detector never fires on
sotac** — zero lift events across the corpus; the foam ball's weight
transfer stays under `liftRateNps` = 1.5 N/s while the jaw-static gate
also blocks it during tightening. (2) The exact-bit-match metric vs
published files is retired: it validated the offline harness, but
published boundaries reflect the old detector; the video-verified and
hand-dragged sets are the scores that matter now.

**Superseded same day — grip statistics cannot mark this boundary at
all.** Zheng video-verified ep2: the ball lifts at 6.9 s with the second
finger's grip still fluctuating (its flat-force stability only passes at
8.5 s), so the capped both-ready rule was 1.5 s late there, while
first-stability is 0.5–1.9 s early elsewhere — and no stability statistic
separates the two situations. Final anchor: **transport = first sustained
ARM motion (summed non-gripper |joint speed| > 12 units/s for 0.15 s) at
or after the grasp's first stability** — the arm starting to carry is the
one signal grip force cannot fake, and it is loud even for objects whose
weight transfer is invisible to the fingertips. New `ArmMotionSeries`
input, wired in both the runner (from observation.state) and the app
(from chart rows).

**Refinement (ep31, video-verified):** arm motion during an active
squeeze is repositioning, not carrying — ep31's arm moves at 9.1 s while
a 40-unit jaw squeeze runs 9.1–9.8 s; her boundary is 9.9 s. The
candidate is therefore postponed while **substantial jaw closing (≥ 8
units of travel) lies within 1 s ahead of it**; ongoing squeeze tails and
mid-carry micro-tightens (≤ ~5 units) do not postpone (ep2, ep24 — a
bout-start-time test was tried first and failed both directions).

**Tried and rejected — net joint displacement as the carry test.** To
cover the hypothetical "carrying while still squeezing hard" (which the
squeeze-postpone would wrongly delay), summed |net joint rotation| was
tested as a direction-aware discriminator: carrying goes somewhere,
adjustment jiggles. Measured result: ep31's grasp-phase repositioning is
itself directional (≥16 units net during the squeeze), so net motion
cannot separate the two cases and ep31 regressed to 9.11 s. Reverted.
The true separator is SIGNED lift-direction motion of the shoulder-lift
joint, which needs a per-robot sign convention — parked; the
`ArmMotionSeries` interface now carries per-joint positions so that
refinement is plumbing-ready. Until then, carry-during-fresh-squeeze is
a documented limit (boundary lands at squeeze end, typically < 1 s late).

**Definition adopted (Zheng, video-arbitrated): transport starts when the
object leaves the plane it rests on (lift-off).** Zheng judged OUR
boundaries correct on the "ours later" family (eps 15, 17, 21, 52, 59)
where hers sit 0.5–0.75 s earlier — those five are hereby definition
deltas, not errors, and her dragged values stop being the transport gold
standard. Her own definition is undocumented (annotation_pipeline_
technical.md / Table VIII, both unseen); from placement it reads as "grip
established" rather than lift-off. Definition alignment is now a
top-of-list question for Jingyi. What the code implements is a
direction-blind approximation of lift-off: sustained summed |rotation
rate| of the five non-gripper joints (> 12 units/s for 0.15 s) after
first grip stability, squeeze-postponed; the exact lift-off definition
needs signed shoulder-lift motion, blocked only on the SO-101 sign
convention (one question).

**Threshold provenance (asked and answered honestly):** ARM_MOVE_EPS = 12
was originally a two-point manual sweep (5, then 12) scored against her
dragged boundaries — metric-fitting, not derivation. Post-hoc derivation
from all 63 episodes (~40k samples of summed non-gripper joint speed):
bimodal — 16% of time parked at 0–1 units/s, 57% in full motion at 30+
(per-episode median speed 42), with a broad flat valley 1–30 holding the
acceleration ramps. Any threshold in ~3–25 separates the modes; the
within-valley choice slides the boundary ~0.1–0.3 s along the ramp — a
placement convention inside the lift-off definition, calibrated by
Zheng's video verdicts (ep2/24/31 + the 15/17/21/52/59 family). The
check that could have genuinely failed passes: the static floor and
moving mode are uniform across episodes, so a GLOBAL threshold is valid
here — unlike the force thresholds (12× per-episode grip-force range).

Final state: transport disagreements 13 → **8**, median 0.65 s;
video-verified ep2 ≈ exact, ep31 −0.19, ep24 = 6.271 vs her 6.27 exact;
ep27/30/32/33/34/35/47/49/53/58 agree. Remaining: six residuals ≤ 0.75 s
(0, 15, 17, 21, 52, 59) and ep56 at −1.5 s (arm repositions with the jaw
done before the true lift — would need direction-aware, e.g.
shoulder-lift-specific, motion to resolve).
