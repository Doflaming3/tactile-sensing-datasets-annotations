# SoTac Annotator Briefing

## Executive Summary

We optimized the tactile auto-annotation pipeline for the SoTac dataset in an independent repository, without touching the original code or data, for a single reviewed merge at the end. Every rule in the detector is a generic physical or task-logic rule; there are no per-episode conditionals (verified: all 55 episode references in the detector file are provenance comments). Rules were developed in a fixed loop: propose a physical rule, measure every instance across all 63 episodes, place thresholds inside measured margins, then verify the borderline cases on video before keeping the rule.

Headline numbers: attempt counts now match the hand-recorded metadata on 55 of 59 episodes, and all four remaining disagreements are errors in the metadata itself, proven by video. The place-event census went from 130 events to 107 after five artifact classes were removed on physical grounds. Thirteen markers received honest names (finger unload, sensor residual, phantom). The unit test suite is 162 tests, all passing.

## 1. The pipeline

1. Data: pinned local mirrors of both datasets (main table at 30 Hz plus raw 91 Hz sensor sidecar files per episode).
2. Detector: one shared implementation drives the web visualizer and an offline runner, validated bit-exact against the app.
3. Verification loop: the offline runner replays all 63 episodes per change; every corpus-wide diff is enumerated before a change is kept; video verdicts arbitrate.
4. Recording policy: the visualizer displays every sensor-true marker; the saved annotation set keeps only real events (phantom and sensor-residual markers are excluded at save time).

## 2. Demo script

Launch: `cd visualizer` then `bun --bun run dev --port 3005`, open `http://localhost:3005`, open the dataset, pick an episode, press Auto-label.

1. `ep24` — the clean full story. A fumbled first touch is flagged `weak_contact@4.7-5.2s`, the lost graze is a drop at 5.23, grasp starts at 5.30, transport at 6.61, place and release end the task at 10.97-11.57. Show the four-phase segmentation, the event timeline, the three-dimensional force arrows, and the live threshold sliders.
2. `ep45` — a failure episode. The success template is suppressed (approach spans the episode) and the two real failed attempts are flags: an air-miss at 3.4-4.1 (the jaw closed 13 units into empty air and reopened) and the terminal loss at 6.5-7.6 (the jaw squeezed 17 units below its own hold width with zero force).
3. `ep25` — honest marker names. Finger 1 truly unloads at 11.68 while the hand still holds (`finger_unload`); the post-task chain at 14.1-16.6 is `phantom`; the recorded annotation set excludes the phantom chain while keeping finger 0's real release inside the same span.
4. `ep47` — the recorder evidence. A wandering 0.8-1.8 newton phantom on finger 0 spans the whole episode; three software removal attempts failed on measured evidence, which is the case for a per-episode re-zero in the recorder.
5. `ep48` — the special one. Unstable grasp with five slip events, then the foam cup rotates out of the bowl: the spin-torque channel spikes to 15 newton-millimeters at exactly 12.0 seconds. Amplitude cannot separate this rotation from routine handling (episodes with no rotation reach 30-48), so rotation detection is a planned pattern-based redesign with this episode as its calibration case.
6. `ep0` — quick close: the jaw bottoms out at position 0.5, the only sub-2.0 dwell in the corpus, and the pads touching each other are flagged `air_grasp`.

## 3. How rules are set

The method is the same for every rule.

1. State the rule as physics or task logic, never as a dataset pattern.
2. Run a census: measure the quantity for every instance in all 63 episodes (the census scripts are in `scripts/calibration/` and double as the porting protocol for new datasets).
3. Place the threshold inside the measured margin between the two classes, not at either edge.
4. Hand the members nearest the line to video review; a verdict against the rule re-opens the rule, not just the number.

Portability has three tiers, documented in `analysis/portability.md`. Tier 1 is pure logic and ports as-is. Tier 2 is calibration constants: the rule ports, the number is re-derived per rig by re-running the census. Tier 3 is structural preconditions to check before porting: single-cycle episodes, jaw starting open, sign conventions, clock agreement.

## 4. The rules

### 4.1 Baseline (software re-zero)

| Condition | How it was set |
|---|---|
| `per-taxel zero = median over the approach plateau` | The firmware zeroes once per session, so later episodes start with standing offsets. Nothing can be grasp-loaded before the jaw first closes, so the median over that whole window is a safe zero; the plateau ends at the first 2-unit closing from the jaw's running maximum, because episodes can begin with the jaw mid-closed from the previous reset. |
| `track the zero while idle (< 1 N, time constant 1.5 s); freeze under load` | Tracking absorbs slow drift; freezing guarantees grip force is never absorbed. Two aggressive variants (tracking during jaw-open windows) were reverted after they shifted video-anchored boundaries by up to 1.4 seconds. |

### 4.2 Contact

| Condition | How it was set |
|---|---|
| `enter: force > 0.15 N sustained 0.2 s` | Above the sensor noise floor; the debounce stops approach brushes from spamming contact-drop pairs. |
| `exit: force < 0.10 N sustained 0.3 s` | Hysteresis below the entry level; the debounce filters single-frame firmware dropouts. |

### 4.3 Release against drop

| Condition | How it was set |
|---|---|
| `release: net jaw opening >= 2 units over [-0.5 s, +1.0 s] around the exit` | An audit of all 150 terminal events showed instantaneous velocity misses real releases (twin fingers exiting 0.02 s apart: one caught, one missed). Net travel keeps retry churn as drops (the jaw jiggles open but closes overall: measured -13, -15, -7 units). Margin: churn maximum +0.7 against real minimum +3.6 units. |
| `closing veto: no release if the jaw closed > 1 unit in the prior 0.5 s` | Video verdict on `ep47`: the ball escaped while the jaw clamped, and the retry's re-open (+22.8 units) landed inside the forward window. An object that leaves during clamping was never released. |
| `early peel: an exit while the partner still holds, with the partner's jaw-visible release within 3 s` | One finger can unload before the hand releases; the partner's later jaw-visible release corroborates it. Guarded by requiring a stable hold in that same contact span and no re-contact within 1.5 s (a fumble re-grabs in 0.1 s). |
| `place context is never consulted` | The original rule "a place just happened, so call it a release" was circular (place is reconstructed from releases) and produced two video-verified false releases before removal. |

### 4.4 Marker names

| Condition | How it was set |
|---|---|
| `the hand's release = the first release at or after the place-release anchor (the jaw opening)` | Video ruling on `ep33`: one finger read zero at 8.11 while the gripper still held the ball; the real release is at the jaw opening. |
| `finger_unload: a release well before the hand's release, partner still holding` | Real signal, wrong task word: nothing was released. Kept in recordings. |
| `sensor_residual: a terminal lagging the hand's release > 0.5 s, contact predating it` | The non-re-zeroed sensor discharging after the true release (video-verified on three episodes). Excluded from recordings, along with place events built from the same discharge. |
| `phantom: events inside a post-task contact span` | After a finger has placed and released, re-entry into the grip requires the jaw to close again; the video-verified tail on `ep25` reads 0.2-0.8 newtons on pads touching nothing. Excluded from recordings. |

### 4.5 Grasp and transport anchors

| Condition | How it was set |
|---|---|
| `grasp starts at the sustained closing leading to the real trial's contact` | The real trial's contact is each finger's latest trustworthy contact before the deciding stable grip; candidates more than 2 s older than the newest are weld suspects (a phantom span otherwise drags the anchor 4 s early). Corpus effect of this reference: exactly one episode changed. |
| `arm-driven fallback: anchor at contact minus 0.3 s when the chosen closing precedes contact by > 2 s` | Video verdict on `ep30`: the selector had latched onto an invisible 2-unit jaw settle; the hand-set boundaries lead contact by 0.2-1.5 s. |
| `transport starts at the first sustained arm motion (12 units/s for 0.15 s) at or after grip stability` | Definition ruling: transport begins when the object leaves its resting plane. Grip statistics cannot mark lift-off for a light object; arm motion is the reliable signal. The threshold sits in a measured bimodal valley (parked joints 0-1 units/s, carrying 30 and above). Postponed while 8 or more units of jaw closing lie within the next second (squeezing in place is not carrying, video-verified). |

### 4.6 Attempts

| Condition | How it was set |
|---|---|
| `an attempt requires the hand to lose the object in a continuous chunk` | Design ruling after five false flags were video-refuted in one sweep: a single finger blinking out is normal grasp life (contact migration, pinch support). |
| `hand quiet: total force < 1.0 N for 0.35 s after the drop` | The 1.0 sits above a 0.8 newton standing phantom and below a 1.4 newton immediate clamp; the 0.35 s sits inside a 0.41 s retry gap and past a phantom resurgence at 0.33 s. Thin margins on both sides, documented. |
| `acted on: the jaw re-opens >= 5 units within 2.5 s, or squeezes >= 8 units below its own hold width` | Measured: +22.8 and +24.7 units of re-opening on the two video-verified real attempts, 0.0 on every false case. The squeeze-through path covers terminal losses nobody retries; it is self-referenced to the episode's own hold position and gated on a 5 newton real-hold peak. |
| `air-miss: a >= 8 unit close-reopen cycle with no contact, before the grasp, after the first 2 s` | The jaw closed into empty air and reopened; the first 2 seconds are excluded because the previous episode's reset motion still settles there. Contiguous with a touch attempt (0.5 s), it merges into one attempt span. |
| `air_grasp: an attempt span whose jaw bottoms below 2.0` | Pads touching each other: the corpus's only sub-2.0 dwell is at 0.5, and the tightest real hold compresses the foam to 2.8. Excluded from attempt counting. |

### 4.7 Place detection and hygiene

A real placement sits at the place-release anchor, never regains grip, and its finger next unloads or releases. Census over all 130 place events; seven deletion rules, each physical:

| Condition | How it was set |
|---|---|
| `D1: same-finger overlapping places are one detection` | Two placements cannot overlap on one finger; the main path and the backfill both fire on one placement (about 14 corpus events). |
| `D2: grip recovers >= 25 % and the carry continues > 1.5 s` | Placement transfers weight permanently. Settling dips recovered 36-706 percent; real staged placements survive through the unload-gap side (real maximum 1.43 s against false minimum 1.7 s — the thinnest margin in the system). |
| `D3: the finger's next terminal is a drop` | A dip before losing the object is not a placement. |
| `D4: inside an air-grasp span` | Nothing held, nothing placeable. |
| `D5: starting > 1.5 s after the place-release anchor` | Post-task artifacts from residual discharge. |
| `D6: ending before the grasp bout` | The object was never carried, so nothing could be placed (a failed trial's jaw-open decay had been reconstructed as a place). |
| `D7: no jaw opening around the place and the hold continues >= 1 s` | A real placement either unloads the finger promptly or coincides with the jaw starting to open (measured +4.2 and +15.3 units on real places, -0.6 on the false one). A dip with the jaw closed and the carry continuing is grip fluctuation. |

### 4.8 Trials, gates, outcome flags

| Condition | How it was set |
|---|---|
| `a trial = overlapping finger contact spans merged (0.5 s); the grasp is the trial holding the last stable grip` | Keying on the first stability mistakes a failed trial's brief false stability for the grasp (video-verified two-trial episode). Failed trials before the grasp are flagged. |
| `weak_contact: pre-grasp spans peaking < 2.3 N` | Calibrated on seven video verdicts (false spans at or under 2.2, real grabs at or over 2.4). One later phantom peaked 3.8, so the line is known-broken upward and downgrades only. |
| `post-task gate: contacts after a finger's own place-and-release are downgraded and flagged` | A real re-grab is a new approach (taxonomy ruling); the pairing uses the finger's final place, after a bug that paired with earlier false places silently downgraded eight episodes' real grasps. |
| `result_failure / result_partial: recorded outcome contradicts a full success template` | A wrong-location release is tactilely indistinguishable from success (video ruling); the tension is flagged for human or vision review, never guessed. |

## 5. Results

1. Attempt counts: 55 of 59 episodes match the hand-recorded metadata. The four disagreements are metadata errors, each proven by video (three undercounts of real touches, one count of two where the video shows one attempt).
2. Boundaries: the grasp, transport, and place-release anchors on the video-anchored episode set are stable across every change; a phantom-welded episode's grasp anchor was recovered from 3.71 to 7.67 seconds with zero other anchors moving.
3. Places: 130 events reduced to 107; every deletion class is physical, and spot-checked deletions were confirmed on video.
4. Marker honesty: 13 markers renamed across 6 episodes, each on a video-verdict location; recordings exclude the non-real classes.
5. Tests: 162 unit tests pass; the detector file is lint-clean; the full corpus runs without errors.

## 6. Findings for the group

1. **Recorder re-zero request.** The firmware zeroes once per session. Standing and wandering offsets create phantom contacts that software cannot remove: three removal strategies were built and reverted on measured evidence, and the wandering case is proven inseparable at signal level. A per-episode re-zero at recording time (with the hand provably empty) resolves the entire class.
2. **Sensor-blind grips.** Three video-verified cases where real contact produced no measurable signal: an edge touch, an off-pad pinch that carried the object at 0.1 newtons, and a light pre-grasp touch reading zero. A sensor placement and grip-style conversation.
3. **Metadata errors.** Five hand-recorded fields are contradicted by video: four attempt counts and one "partial" outcome with nothing visible on video.
4. **Naming.** Three marker names (finger unload, sensor residual, phantom) are outside the established event taxonomy; one of them reaches the recorded set and needs a naming decision.
5. **Definitions to align.** Transport = the object leaves its resting plane (lift-off). Grasp start = the closing motion that leads to the real trial's contact. Both are now formal in code and should be agreed across the team.

## 7. Limits and next steps

1. Recall is un-audited: the verification pressure went into false events and wrong labels; missed events surface only by watching (one known example is documented).
2. Rotation and lift detection are ineffective on this data; rotation needs a pattern-based redesign (calibration episode identified), lift never fires on the light foam object.
3. Three tiers of portability apply before any use on other datasets: check the structural preconditions, re-run the calibration censuses, re-derive every constant.
4. Next: the merge conversation (evidence package is complete in `analysis/`), multi-cycle support for company-format data, and the pattern-based rotation detector.

## Notation, units and abbreviations

- N: newton (force). Hz: hertz (sample rate). s: seconds. mm: millimeter.
- Jaw positions and travel are in the gripper's raw position units (about 0-60 over its range; only differences are used).
- Taxel: one sensing element of the fingertip array (52 per finger, three force axes each).
- `ep24` style tokens are episode indices; `weak_contact@4.7-5.2s` style tokens are review flags with time spans.
- D1-D7: the seven place-hygiene deletion rules in Section 4.7.
