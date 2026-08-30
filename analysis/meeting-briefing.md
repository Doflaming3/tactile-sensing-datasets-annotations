# SoTac Annotator Briefing

## Executive Summary

We optimized the tactile auto-annotation pipeline for the SoTac dataset in an independent repository, without touching the original code or data, for a single reviewed merge at the end. Every rule in the detector is a generic physical or task-logic rule; there are no per-episode conditionals (verified: all 55 episode references in the detector file are provenance comments).

Headline numbers: attempt counts now match the hand-recorded metadata on 55 of 59 episodes, and all four remaining disagreements are errors in the metadata itself, proven by video. The place-event census went from 130 events to 107 after five artifact classes were removed on physical grounds. Thirteen markers received honest names (finger unload, sensor residual, phantom). The unit test suite is 162 tests, all passing.

## 1. The pipeline

1. Data: pinned local mirrors of both datasets (main table at 30 Hz plus raw 91 Hz sensor sidecar files per episode).
2. Detector: one shared implementation drives the web visualizer and an offline runner, validated bit-exact against the app.
3. Verification loop: the offline runner replays all 63 episodes per change; every corpus-wide diff is enumerated before a change is kept; video verdicts arbitrate.
4. Recording policy: the visualizer displays every sensor-true marker; the saved annotation set keeps only real events.

## 2. Demo script

Launch: `cd visualizer`, then `bun --bun run dev --port 3005`, open `http://localhost:3005`, pick the episode, press Auto-label. Six episodes, each making one point. For each: what to show, what to say, and what on screen may look wrong — with the answer.

### 2.1 `ep24` — what the annotator does on a normal episode

Show: the four-phase segmentation, the event timeline, the three-dimensional force arrows while scrubbing, then click "tune thresholds" in the Auto-label panel (right column) and drag a slider to recompute live.

Say: "This is the default behavior. The robot fumbles its first touch — the system flags that span as a weak contact and marks the lost touch as a drop. The real grasp starts where the jaw closes on the ball, transport starts where the arm actually lifts it, and the place-release phase closes the task. Everything recomputes live when I change a threshold."

Heads-up: the fumble's markers are visible on the timeline but are excluded from saved annotations — displays show sensor truth, recordings keep real events. That split is deliberate and comes up again on `ep25`.

### 2.2 `ep45` — what happens when the task fails

Show: the timeline has no grasp, transport, or place-release segments; two flags carry the story.

Say: "Before, every episode got the same success story of grasp, transport, and place, even when nothing was ever picked up. Now the annotator recognizes there was no completed task: the whole episode is approach, plus two failed-attempt flags. And the flags match the video exactly: first the gripper closes on empty air and reopens — a miss; then it grabs the cup, loses it, and squeezes shut through the space where the cup was — 17 units below its own holding width, with zero force on the pads."

Heads-up: contact and stable-grip markers are still visible inside the attempt spans. That is sensor truth (the pads really touched); the interpretation — failed attempt — is carried by the flags.

### 2.3 `ep25` — markers that say what they mean

Show: the marker at 11.68 named `finger_unload`, the chain at 14.1-16.6 named `phantom`, then the annotations list after auto-label.

Say: "Every marker is what the sensor reported, but not everything the sensor reports is real, and the names now say which is which. At 11.68 one finger genuinely unloads while the hand is still holding the ball. That used to say release, which overstates it; now it says finger unload. After the task ends, the pads keep reporting force while touching nothing — those markers say phantom. The display shows all of it; the saved annotations keep the real events and drop the phantoms."

Heads-up: if someone asks why we keep phantom markers visible at all — because the reviewer needs to see what the sensor claimed to trust what the annotator excluded.

### 2.4 `ep47` — the case for a recorder change

Show: finger 0's contact starting near 0.3 seconds and never ending; the failed-attempt flag at 4.0-4.6; the grasp segment starting at 7.67.

Say: "Finger 0 reports contact for 14 straight seconds; on video it touches nothing for most of that. Its zero-point wandered mid-episode between 0.8 and 1.8 newtons. We built three software fixes; each one measurably damaged real episodes (one shifted a video-verified boundary by 1.4 seconds), and we can show this signal class is not separable in software. One line in the recorder removes the entire class: re-zero the sensors at each episode start, when the hand is provably empty. Until then the annotator works around it: the real failed squeeze at 4.0-4.6 is still flagged, and the grasp anchor is recovered by dating the trial from the healthy finger."

Heads-up: the never-ending finger 0 contact is the exhibit, not a bug — say so before anyone asks.

### 2.5 `ep48` — the limits, honestly

Show: the five slip markers during the hold; the `result_failure` flag; the release markers at 12.18.

Say: "The metadata says this episode failed; the touch data looks like a complete task. What failed is invisible to force alone: the foam cup rotated out of the bowl after the jaw opened. The spin-torque channel actually spikes right at the turn — but at 15 newton-millimeters, and ordinary handling reaches 30 to 48 in episodes with no rotation at all, so amplitude cannot detect rotation; a pattern-based rotation detector is planned, and this episode is its calibration case. Meanwhile the annotator does the honest thing: it flags the contradiction for human review instead of guessing."

Heads-up: the marker at 12.18 still says release. That is correct at the signal level, since the jaw did open; the failure lives in the flag. Also say: the slips during the hold were confirmed correct on video — the grasp really was unstable.

### 2.6 `ep0` — ten-second close

Show: the `air_grasp` flag at 2.2-2.7.

Say: "The gripper closes on air and the pads touch each other. Jaw position alone identifies it: the jaw bottoms out at 0.5, and the tightest real hold in the whole corpus never compresses below 2.8. Flagged as an air grasp and excluded from attempt counting."

## 3. The rules, in plain English

How every rule was set, in one paragraph: we state the rule as physics or task logic, measure every instance of it across all 63 episodes (the census scripts are kept in `scripts/calibration/`), place each threshold inside the measured gap between the two classes it separates, and hand the borderline cases to video review. A video verdict against a rule re-opens the rule, not just the number. For other datasets: the logic ports as-is, the numbers are re-derived by re-running the same censuses, and a short list of structural preconditions is checked first (single-cycle episodes, jaw starting open, sign conventions, clock agreement) — all documented in `analysis/portability.md`.

### 3.1 Zeroing the sensors

The firmware zeroes the sensors once per session, so later episodes read force while touching nothing. Two mechanisms fix that, and both work per taxel: each of the 52 sensing points on each finger keeps its own zero.

First, the starting zero. From the start of the episode until the jaw first closes — "closes" meaning its position drops 2 units below the most-open position it has reached, a position test, not a speed test — the hand cannot be holding anything. Whatever each taxel reads in that window is offset, and its median becomes that taxel's zero.

Second, drift tracking. After that, the zero keeps slowly following the signal (a time constant of 1.5 seconds), but only while the finger is quiet: quiet means the finger's total corrected force (the sum over its taxels after zero subtraction, checking both the normal push and the sideways shear) stays under 1 newton. The moment that total reaches 1 newton, the zero freezes where it is, and stays frozen until the finger is quiet again. The freeze is the guarantee that real grip force is never absorbed into the zero.

How it was set: the known cost of the quiet rule is that a touch creeping in slower than the tracker, never exceeding about 1 newton, is absorbed as drift; fast touches keep full sensitivity. We also tried more aggressive zeroing (following the signal whenever the jaw was open), and it ate the tails of real releases, moving video-verified boundaries by up to 1.4 seconds. Both aggressive variants were reverted; that evidence is the core of the recorder request.

### 3.2 Touching and letting go

A finger counts as touching when its total force stays above 0.15 newtons for a fifth of a second, and as having let go when force stays below 0.10 newtons for three tenths. The gap between the two levels and the hold times exist so approach brushes and single-frame sensor dropouts cannot create fake touch events.

These thresholds apply to the corrected force, after the zero from 3.1 is subtracted — 0.15 newtons means 0.15 above the finger's own current zero. The two processes cannot fight each other: the zero drifts on a 1.5 second time constant while a real touch crosses the threshold within a couple of frames, and once force passes 1 newton the zero is frozen anyway.

### 3.3 Release or drop

When a finger's force disappears, we ask one question: did the jaw actually open around that moment? We total the jaw's net movement from half a second before the loss to one second after; at least 2 units of net opening means release, otherwise drop.

Why net movement: during fumbles the jaw twitches open but is closing overall, and net movement ignores twitches. Why 2 units: across all 150 force-loss events in the corpus, fumbles never net-open more than 0.7 units and real releases never less than 3.6 — the threshold sits in that gap. One veto on top: if the jaw was actively closing when the force vanished, it is never a release — the ball was squeezed out; we watched exactly that happen on video. One special case: a finger may let go early while the other still holds; that counts as a release only when the partner's own jaw-opening release follows within 3 seconds and the finger never touches again.

What we removed: release used to consult whether a "place" had just happened. Place is itself reconstructed from releases, so that was circular — and it manufactured two false releases before we caught it on video and deleted it.

### 3.4 Honest marker names

A release marker must mean the hand released the object. Three situations used to borrow that word and now have their own names. When a single finger unloads while the hand still holds (the ball resting into the bowl, one pad losing pressure), the marker says finger unload; real signal, kept in recordings. When force lingers after the hand's release because the sensor is still discharging, it says sensor residual; excluded from recordings, along with place events built from the same discharge. When contact appears after the task is over, on pads touching nothing, it says phantom; excluded. The reference point for "the hand's release" is the jaw opening.

### 3.5 Where grasp and transport begin

Grasp begins at the jaw-closing motion that leads to the real grip — "real" meaning the contact that becomes the final stable hold, so failed tries stay in the approach phase. Each finger dates the trial by its latest trustworthy contact; a finger whose contact is seconds older than its partner's is a welded phantom and is ignored (that one guard recovered a grasp anchor by 4 seconds while changing nothing else in the corpus). If the chosen closing happened more than 2 seconds before the touch, the jaw was merely pre-positioned and the arm descended — then the anchor sits just before the touch, matching hand-set boundaries that lead contact by 0.2 to 1.5 seconds.

Transport begins when the arm starts moving after the grip is stable. Our agreed definition: transport is the object leaving its resting plane. A light foam ball's weight transfer is invisible in grip force, so arm motion is the only reliable lift-off signal; the motion threshold sits in an empty measured valley (parked joints jitter at 0-1 units per second, carrying runs at 30 and above). If the jaw is still actively squeezing, transport is postponed — repositioning while gripping is not carrying; that came from a video verdict.

### 3.6 Failed attempts

A failed attempt means the hand lost the object — not a finger. One finger blinking out is normal grasp life: contact migrates as the ball slides into the clamp, one pad unloads while the object rests on the bowl. We learned this the hard way when five finger-level attempt flags were all refuted on video in a single sweep.

The rule now: total force across both fingers must drop below 1 newton for a third of a second, and the loss must be acted on — either the jaw reopens to retry (on the two video-verified real attempts it reopened by 22 and 25 units; on every false case, zero) or the jaw squeezes straight through where the object was, at least 8 units below its own holding width. The thresholds sit between measured neighbors: 1 newton is above a 0.8 newton standing phantom and below a 1.4 newton clamp; the timing sits inside a 0.41 second retry gap.

Two more attempt types come from the jaw alone. Closing at least 8 units into empty air and reopening with no contact is a miss; the first 2 seconds of each episode are excluded because the previous episode's reset motion still settles there. And closing until the pads touch each other — an air grasp, identified by the jaw bottoming below 2.0 where the tightest real hold never goes below 2.8; excluded from attempt counting.

### 3.7 Placements

A real placement has three properties: it sits at the end of the task, the grip force never comes back (the weight went to the table for good), and the finger lets go soon after. We measured all 130 place events in the corpus against those properties and deleted seven violation classes: duplicates (two detection paths firing on one placement, about 14 events); dips where the grip recovered by a quarter or more and the carry continued (settling wobbles — one recovered seven-fold); dips right before the object was lost (a dip before losing is not placing); "places" during air grasps (nothing held, nothing placeable); after the task (residual discharge); before anything was ever carried (a failed trial's decay reconstructed as a place); and dips where the jaw never began opening while the hold simply went on (measured: real late placements open by 4 to 15 units; the false one closed by 0.6).

The protections for real placements are measured too: staged placements, where the object is set into the bowl in two steps, survive because their finger unloads within a second and a half. That margin (1.43 seconds on the real side against 1.7 on the false side) is the thinnest in the system, and it is documented as such.

### 3.8 Trials, phantoms after the task, and outcomes

Touches group into trials: overlapping finger contacts merge, and the trial containing the last stable grip is the grasp — everything before it is a flagged failed trial. Keying on the first stability instead would mistake a failed trial's brief false stability for the grasp; a two-trial episode proved that on video.

After a finger has placed and released its object, new contact on it cannot be a grasp — nothing re-enters the grip without the jaw closing again, and a real re-grab is a new approach (a taxonomy ruling). Such contacts are downgraded and flagged.

When the recorded outcome says failure but the touch data looks like a complete task, the annotator does not guess: the episode is flagged for human or vision review, because a ball released over the wrong spot feels identical to the sensors.

## 4. Results

1. Attempt counts match the hand-recorded metadata on 55 of 59 episodes; the four disagreements are metadata errors, each proven by video.
2. The grasp, transport, and place-release anchors on the video-anchored episode set are stable across every change; one phantom-welded grasp anchor was recovered by 4 seconds with zero other anchors moving.
3. Places: 130 events reduced to 107; every deletion class is physical, and spot-checked deletions were confirmed on video.
4. Thirteen markers renamed across six episodes, each on a video-verdict location; recordings exclude the non-real classes.
5. 162 unit tests pass; the detector file is lint-clean; the full corpus runs without errors.

## 5. Findings for the group

1. Recorder re-zero request. The firmware zeroes once per session; standing and wandering offsets create phantom contacts software cannot remove (three strategies built and reverted on measured evidence). A per-episode re-zero at recording time, with the hand provably empty, resolves the class.
2. Sensor-blind grips. Three video-verified cases where real contact produced no measurable signal: an edge touch, an off-pad pinch carrying the object at 0.1 newtons, and a light pre-grasp touch reading zero. A sensor-placement and grip-style conversation.
3. Metadata errors. Five hand-recorded fields contradicted by video: four attempt counts and one "partial" outcome with nothing visible on video.
4. Naming. Three marker names (finger unload, sensor residual, phantom) are outside the established event taxonomy; one reaches the recorded set and needs a naming decision.
5. Definitions to align. Transport = the object leaves its resting plane. Grasp start = the closing motion leading to the real trial's contact. Both are formal in code and should be agreed across the team.

## 6. Limits and next steps

1. We audited hard for false events, meaning events that should not be there. We have not systematically audited for missed events, meaning ones the detector should have found but did not. Those only show up when someone watches an episode. So if an episode looks thin on markers, suspect a miss first; we have one documented example.
2. Two detectors do not really work on this data. Lift never fires, because the foam ball is too light to leave a force signature. Rotation fired once in 63 episodes, and when we found a real rotation on video, its torque spike was smaller than what ordinary handling produces in other episodes, so no threshold can fix it; rotation needs a smarter pattern-based detector, and we know exactly which episode to build it against.
3. The rules are tuned for this robot and this dataset. On new data, three steps come before trusting anything: check the assumptions (one task per episode, jaw starting open, same sign conventions, clocks agreeing), rerun our measurement scripts on the new corpus, and re-derive every number the same way we derived it here.
4. Coming next: the merge-back conversation with the evidence package we assembled, support for episodes with several pick-and-place cycles (the company data will have them), and the pattern-based rotation detector.

## Notation, units and abbreviations

- N: newton (force). Hz: hertz (sample rate). s: seconds.
- Jaw positions and travel are in the gripper's raw position units (about 0-60 over its range; only differences are used). Spin torque is in newton-millimeters.
- Taxel: one sensing element of the fingertip array (52 per finger, three force axes each).
- `ep24` style tokens are episode indices; `weak_contact@4.7-5.2s` style tokens are review flags with time spans.
