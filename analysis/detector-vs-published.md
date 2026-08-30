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

## Addendum 6: release/drop decoupled from place (Zheng's circularity catch)

Zheng flagged a circular dependency in the exit classifier: release
leaned on "a place just happened" (the ep25 rescue rule), while place is
itself backfilled FROM releases, and the post-task phantom gate leaned on
both. One bad place could then manufacture a release, which manufactured
a place, which armed the gate. Ruling: place may derive from release,
never the reverse.

**Audit of all 150 terminal events** (scratch `exit-audit.ts`): the old
two-instant jaw-velocity test handled 121; 11 real releases fell between
its two samples (ep48: twin fingers exit 0.02 s apart, one caught, one
missed); 5 had jaw opening only >1 s away; 13 had none. The place-rescue
was found to have already produced a false release: **ep24 @5.23 —
video-confirmed fumble** with the jaw closing 16 units, promoted to
"release" by a false place during approach, which then backfilled
another false place. ep21 @4.46 has the identical signature.

**New classifier (no place anywhere):**
- *Net-travel rule*: release iff net jaw-opening travel ≥ 2 units over
  [exit −0.5 s, +1.0 s]. NET keeps attempt churn as drops (jaw jiggles
  open but closes overall: ep16 −13, ep22 −15, ep49 −7 units); threshold
  sits between the largest churn travel (+0.7) and the smallest real
  release (+2.8). Asymmetric window covers weight-transfer lag (ep33:
  exit 0.52 s before opening) and adhesion (ep50: opening 0.78 s first).
- *Peel rule* (cross-finger, jaw-invisible exits): a drop whose finger
  HELD in that bout (last grasp_stable inside it), with no re-contact
  within 1.5 s, adjacent to the partner's jaw-visible release — early
  peel: partner still holding, its release ≤3 s later (ep25 @11.68,
  video-verified); late peel: partner released ≤1.5 s before while this
  finger was already in contact (ep41 @7.34). The stable-inside-bout
  guard rejects post-place grazes (ep33 @10.24, 0.8 N).
- *Rejected*: force-decay shape — measured peels cliff in 0.01 s while
  real drops can fade over 1.2 s; distributions fully overlap.

**Corpus delta: exactly 4 label flips** — ep21 @4.46 and ep24 @5.23
release→drop (the circular FPs; ep24's false backfilled place dies with
it), ep36 @9.61 and ep47 @4.57 drop→release (late peel / net-travel;
both queued for video). All video-anchored releases survive on the new
evidence (ep25 @11.68 via early peel, ep41 via late peel, ep33/48/50 via
net travel).

**Bycatch — post-task gate bug (shipped with Addendum 5's follow-up,
uncommitted):** the gate paired terminals with the last place *seen so
far* in one forward scan, so an early false place + churn terminal
marked a finger "done" at ~5 s and silently downgraded the REAL
grasp/carry to low on ep0/21/24/31/32/38/47/56. Fixed: the finger's
final place is computed over the full list first. The 8 wrongly-lowed
real releases returned to medium/high; genuine spans (ep25 14.1–16.6,
ep33 9.0–10.2) survive.

Checks: attempts 51/59 unchanged; video-anchored subtask boundaries
unchanged (ep2 6.138/7.007, ep24 grasp 5.303, ep30 5.728, ep56 8.736,
ep25 place_release 13.805); 157/157 tests. Residual (pre-existing, out
of scope): weak grazes whose exit coincides with pre-grasp jaw opening
still label "release" (ep25 @1.83, identical before/after) — candidate
for a bout-peak gate, to be decided with the place-precision work.

### Addendum 6 correction: the closing veto (Zheng's ep47 video verdict)

The ep36/ep47 "drop→release" line above is half-retracted. Zheng
video-checked ep47 @4.575: **the ball escapes while the jaw is still
clamping** — a squeeze-out, then the retry's pre-open (+22.8 units)
lands inside Rule 1's forward window and read as a release. Measured
split at the exit: back −5.7 (closing), forward +22.8. This is exactly
the trap the net-travel design was supposed to avoid; the net test
alone cannot see it when the retry opens big enough to swamp the
squeeze.

Fix: **closing veto** — release evidence at an exit is void if the jaw
moved ≤ −1 unit in the 0.5 s before it (actively closing when the force
died = the object left DURING clamping, never a let-go). Applied to
Rule 1 and to the peel rules' partner checks.

Corpus effect: exactly 4 flips vs the pre-veto state — ep47 @4.57 back
to drop (its backfilled false place dies too), plus ep31 @5.03, ep31
@7.14, ep32 @6.50 release→drop: all three carry the identical
squeeze-out signature (closing at exit, retry pre-open right after),
sitting in the squeeze phase Zheng already video-described on ep31
("gripper closing while arm moving"). Long-standing mislabels, not new
behavior. All peel survivors intact; attempts 51/59; 157/157.

ep47's missing failed_attempt flag is NOT from this round: finger 0's
standing phantom contact (onset 1.41 s, never exits until 14.61 s)
bridges every trial into ONE bout, so no bout precedes the grasp bout
and the flag loop has nothing to flag — it also corrupts ep47's grasp
anchor (3.71 vs ~8.3 real). That is the parked phantom/recorder-re-zero
issue, now with a second concrete casualty (flag + anchor). A
finger-level attempt rule (f1's own 3.98–4.57 drop span inside the
merged bout) is the candidate detector-side mitigation, to be designed
with the result-aware segmentation work.

### Addendum 6b: finger-level attempts inside a welded bout

Detector-side mitigation for the ep47 flag casualty, shipped: when a
standing phantom bridges every trial into one bout, failed attempts are
recovered from the individual finger's own spans. A finger span counts
as an attempt when it (1) ends in a drop (trustworthy post
closing-veto), (2) lies inside the grasp bout, (3) ends before the
hand's first grasp_stable of that bout (excludes mid-carry slips), and
(4) is followed by ≥1.0 s of dead time before that finger re-contacts
(regrip churn re-grabs in ~0.1 s; distinct trials sit seconds apart).
Same weak/strong split at 2.3 N, flags only. Corpus effect: fires on
exactly ONE episode — ep47 gains failed_attempt@4.0-4.6s, zero
collateral; attempts agreement 51/59 -> 52/59 (ep47 now matches her
hand count). ep47's grasp anchor (3.71 vs ~8.3) remains phantom-
corrupted — that needs the context-gated re-zero, not flag logic.

### Addendum 6c: Zheng's sweep — late-peel falsified, attempt rule rebuilt

Sweep verdicts (2026-08-29): ep36 weak span 1.2-3.1 = drift, finger in
air (gate worked); ep36 true task end at 8.4, the 9.61 "release" is a
NON-RE-ZEROED SENSOR RESIDUAL, not contact; ep41 same mechanism. **The
late-peel rule is falsified as gel adhesion — both corpus firings are
phantom residuals after the true release.** The early-peel case (ep25
@11.68, before the jaw opens) stands video-verified. Late-peel labels
kept until the context-gated re-zero lands (it erases these residuals
at the source; the rule is then deleted). ep21 @4.5 = real light touch
=> drop + attempt flag correct, her metadata undercounts. ep33 @8.1:
hand still HELD the ball while f1 read zero — the "official release"
is 9.12; per-finger release markers overstate task semantics (see
marker-contamination note below). ep32 @6.5 = real failed attempt.

Attempt rule rebuilt on ep32's evidence (its failed touch reached
momentary stability AND retried 0.4 s later — both old guards wrong):
a finger span ending in a drop inside the grasp bout is an attempt
UNLESS the hand still held the object (only possible after the bout's
first stability with another finger in contact) or the finger's task
was already release-completed (a drop-completed "task" = false place on
a failed engagement, ep45, and does not suppress). Corpus: recovers
ep32 @4.7-6.5 (video-anchored) and ep45 @6.5-7.6 (failure ep, toward
her count of 2), keeps ep47; adds five UNVERIFIED candidates, all
squeeze-out-signature: ep19 @3.3-3.7, ep22 @6.0-10.8, ep33 @4.3-4.5,
ep35 @3.9-4.5, ep40 @3.4-8.7. Agreement vs her metadata 52 -> 50/59 —
the five candidates await Zheng's video, and her counting semantics
(does an escape-and-immediate-regrab count as an extra attempt?) is a
Jingyi question.

Marker-contamination issue (Zheng): auto events remain in the atom
stream even when phantom-classified (downgraded low + flagged), and
per-finger releases read as task events — a training/eval consumer that
does not filter inherits them. Policy fork to decide: (a) machine-
readable phantom marking + filtered export, (b) suppress phantom-
classified events from atoms entirely, (c) two-tier output (hand-level
task events + finger-level sensor markers). Affects the deliverable
format — raise with Jingyi.

### Addendum 6d: sweep round 2 — the attempt rule is now fully measured

Zheng's second sweep falsified all five candidate flags from 6c's
partner-in-contact rule (ep19: ball slid into the clamp, no loss; ep22
@6.0-10.8: post-release phantom residual; ep33 @4.3-4.5: migration
during grasp; ep35: phantom span; ep40: off-pad pinch carried the ball)
and set the design principle: an attempt requires the HAND to lose the
object in a continuous chunk — a single finger blinking out is normal
grasp life. ep25 @11.68 was also inspected at data level after Zheng
saw arrows while the detector said zero: table and raw agree (mapping
r=.998/.996), f1 truly zeroes ~11.9-14.0 while f0 holds ~4 N to 14.0 —
ep25 joins ep33/ep50 as asymmetric unloading during placement; "early
peel" was never a peel, and the per-finger "release" NAME is the
marker-policy issue, not a signal bug.

Final rule (every constant measured, no fitted guesses): a span ending
in a drop inside the grasp bout, before the last release, is an attempt
iff the hand goes quiet (total force < 1.0 N — above ep47's 0.8 N
standing phantom, below ep19's 1.4 N clamp — for 0.35 s, inside ep32's
0.41 s retry gap, past ep35's phantom resurgence at +0.33 s) AND the
jaw re-opens within 2.5 s (+22.8/+24.7 on real attempts, 0.0 on every
false case). Corpus delta vs session baseline: EXACTLY ep32 @4.7-6.5
and ep47 @4.0-4.6, both video-verified. Agreement 53/59.

Two structural findings for the Jingyi list:
- ep40: an off-pad pinch carries the object at 0.1 N — the tactile
  channel is blind to the entire successful task; jaw never re-opens
  before recording ends. Data-quality issue (sensor placement/grip
  style), and it makes ep45 (true terminal loss, identical hand+jaw
  signature) UNFLAGGABLE without episode-result metadata —
  result-aware segmentation is the fix; ep45/ep39 stay as documented
  under-counts until then.
- ep35: a motion-coincident phantom peaked 3.8 N, breaking the 2.3 N
  weak-contact calibration ("every false bout <= 2.2 N") — the gate
  cannot be trusted alone above that line anymore; second casualty
  count for the context re-zero.

### Addendum 6e: air_grasp — Zheng's jaw-position insight, measured and shipped

ep0 @2.2-2.7 verdict: real contact, but pads touching EACH OTHER — an
air-close, not an object attempt — and Zheng's suggestion (read it off
the gripper motor) is fully supported by measurement: the air-close
dwells at jaw position 0.5, the ONLY sub-2.0 dwell in all 63 episodes;
the nearest real hold compresses the foam ball to 2.8 (ep37 — thin
margin, re-derive for harder objects). Shipped: any attempt-classified
span whose jaw bottoms below 2.0 becomes `air_grasp@span` (excluded
from attempt counting). Also noted: ep0's first grasp_stable at 2.5 s
fired ON the pad-pad contact — false stability on an air-close is now a
known mode. ep22 @2.9-3.1 video-confirmed as a real touch-the-ball
failed attempt (her metadata undercounts, like ep21/ep54).

Attempt agreement 54/59; all five residual disagreements are resolved:
ep21/ep22/ep54 = our flags video-verified correct (her hand counts
undercount), ep39/ep45 = unreachable without episode-result metadata
(result-aware segmentation). Attempt detection is DONE for sotac.

### Addendum 6f: context-gated re-zero — what shipped, what failed, what it proves

Shipped (safe): the per-taxel zero now initializes from the median over
the whole APPROACH PLATEAU instead of the first 0.4 s — the plateau
ending at the first 2-unit closing from the jaw's RUNNING MAXIMUM
(episodes can start mid-closed from the previous reset: ep47 begins at
18 and opens to 39 at 1.5 s, so start-position-based windows silently
become the whole episode). Gripper context is plumbed through
detector, runner, auto-label panel, and every display component — one
correction everywhere, unchanged when no gripper exists. Corpus effect:
two weak-flag noise changes (ep38 loses a phantom weak span, ep40
gains an early one), zero anchor changes, zero attempt changes
(54/59), 157/157 tests.

Failed and reverted, with evidence (both attempts preserved in git
history via this doc):
1. Fast-tau tracking over jaw-open windows: absorbed ~half of every
   transient graze into the baseline and poisoned the rest of the
   episode (ep24 place_release slid 10.97 -> 9.61, video-anchored).
2. Max-open post-release window: ate the tails of REAL releases while
   the fingers were still unloading (ep31 -1.1 s).

What ep47 proves: its finger-0 phantom is a WANDERING 0.8-1.8 N signal
across the whole episode — not a step offset. Medians cannot remove it
(it rides above its own median exactly in the retry gap, keeping the
weld); only continuous tracking can, and continuous tracking is
globally unsafe (above). Combined with the zero-frame census (steady
vs blinking inverted) this is the third independent proof that the
settled/wandering phantom class is NOT separable in software.
**Recorder-side per-episode re-zero is the fix — this is now the
evidence package for the Jingyi request.** ep47's grasp anchor stays
corrupted (3.71 vs ~8.3) until then; its attempt flag survives via the
finger-level rule. Candidate v2 mitigation if the recorder fix stalls:
long-span blink-rate analysis (a >8 s sub-2.3 N span with zero
firmware dropouts is phantom-like; real contact blinks).

### Addendum 6g: grasp definition formalized, ep45's two attempts recovered

**Formal grasp-start definition** (Zheng asked; now explicit in code):
the grasp subtask begins at the onset of the sustained jaw-closing
motion that leads to the REAL grasp trial's contact — where the trial's
contact is dated per finger by its latest non-LOW contact_onset at or
before the deciding grasp_stable, weld-suspect candidates more than 2 s
older than the newest discarded, earliest survivor wins. (Previously
the reference was the grasp BOUT's first contact, which ep47's phantom
weld dragged to 0.26 s, latching the selector onto the failed squeeze's
closing at 3.7 s — a flagged failed attempt INSIDE the grasp segment,
Zheng's catch.) Corpus effect: exactly one anchor changed — ep47 grasp
3.71 -> 7.67; every other episode, video-anchored set included,
bit-identical. Low-onset exclusion matters: ep25's gate-downgraded
post-task chain otherwise drags the anchor to 13.8.

**ep45's two failed attempts, both recovered without result metadata**
(Zheng: "following our condition we can surely get those two" — right):
1. air-miss @3.4-4.1: jaw closes 27->14 into empty air and reopens to
   45, zero force on both pads. New gripper-only detector: a >=8-unit
   close->reopen cycle with no finger span overlapping it, before the
   grasp bout, past the 2 s episode-start reset window (the reset
   guard kills false cycles on ep24/26/42/53/60).
2. squeeze-through @6.5-7.6: after the stable 24 N hold, the ball
   escapes and the jaw runs to 5 — >=8 units BELOW its own hold
   position — with the hand quiet. New terminal-loss path beside the
   jaw-reopen test; gated on span peak >= 5 N (ep35's 3.8 N motion-
   phantom "stable" otherwise resurrects; ep40's residual drop is safe,
   its jaw sits 36 units ABOVE its hold).

Attempts 55/59. All four residual disagreements are HER metadata's
errors per Zheng's video: ep21 (real touch, hers=1), ep22 (real touch,
hers=1), ep54 (two real brief attempts, hers=2 vs our 3... hers
undercounts, video-verified), ep39 (Zheng counts ONE attempt on video,
hers=2). Two new air_grasp candidates for video: ep16 @3.0-4.1 and
ep22 @3.1-5.3 (post-graze whiff cycles).

Sweep corrections recorded: ep28 — both fingers real during the task;
the anomaly is f1 never emits a terminal (residual holds it "in
contact" past f0's 12.44 release, plus a phantom place @15.0) —
residual family. ep22 f0 is fully normal (contact->stable->place->
release 8.92); the earlier "silent finger" wording was wrong — the
observation is f1 never RELEASES: its last exit is the verified
residual drop @10.76. ep40 decoded: grab 3.2, carry at jaw 26, TRUE
release ~6.9 (jaw 26->62) — which is exactly what its
unlabeled_transition@6.9s changepoint marks — then drift; f1's drop
@8.74 is a residual tail. ep39: correct through transport; the ball
was dropped in AIR instead of the bowl — tactilely indistinguishable
from a correct place; vision or human judgment territory. ep38 weak
removal video-confirmed correct. ep36/41 set-zero question answered:
post-place absorption was tried twice and reverted — the real
slow-unload class (ep50, 0.95 s lag, video-verified) and the residual
class (1.16-1.27 s) OVERLAP in time; separation is impossible at any
threshold, not a noise-amplitude issue.
