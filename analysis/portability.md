# Portability audit: is the annotator generic?

2026-08-29, after Zheng's design challenge: "if our placement is not
logical settled rules, instead an enumeration of all conditions
satisfied under all episodes, this is not feasible... if we want this
annotator to be generic, this idea fails."

The test applied to every rule: **a rule is generic if its
justification is physics or task logic, and its constants are
re-derivable by a documented procedure on a new dataset.** A rule is
dataset-specific if it exists only because particular episodes demanded
it. There are no per-episode conditionals anywhere in the detector
(verified by grep — all episode references are provenance comments);
the audit below classifies what remains.

## Tier 1 — physical / task logic (ports as-is)

| Rule | Principle |
|---|---|
| Contact hysteresis + entry/exit debounce | standard signal conditioning |
| Adaptive baseline: init before first jaw close, track when idle, freeze under load | nothing can be grasp-loaded before the jaw ever closes; grip force must never be absorbed |
| Release requires net jaw-opening evidence | a hand releases by opening |
| Closing veto | an object that leaves DURING clamping was never released |
| finger_unload vs hand release | the hand's release is the one at the jaw opening; a single pad unloading while the partner holds is not a task event |
| sensor_residual | force outliving the hand's release, with contact predating it, is sensor discharge |
| Attempt = hand-level continuous loss, acted on (jaw re-opens) or terminal | one finger blinking out is normal grasp life; a retry requires reopening |
| Air-miss cycles | a close→reopen with no contact grabbed nothing |
| Pads-meet air_grasp | jaw at its mechanical floor has nothing between the pads |
| Squeeze-through | a jaw far below ITS OWN hold width with no force holds nothing (self-referenced — no cross-dataset constant) |
| Grasp anchor | the closing that leads to the trial containing the final stable hold; failed trials belong to approach |
| Transport anchor | first sustained arm motion at/after stability (lift-off definition, Zheng's ruling) |
| Place persistence + hygiene D2's principle | placement transfers weight permanently — grip force must not return before the finger unloads |
| Hygiene D1 | two placements cannot overlap on one finger: overlap = double-detection |
| Hygiene D3 | a dip before LOSING the object is not a placement |
| Hygiene D4 | nothing held in a pads-meet span, so nothing can be placed |
| Post-task gate | after place+release, re-entry into the grip requires the jaw to close again |
| Trial/bout segmentation | overlapping finger contact spans are one physical trial |

## Tier 2 — calibration constants (rule ports; NUMBER must be re-derived per rig/dataset)

Each constant has a derivation script in `scratchpad`-style tooling
(exit-audit, place-census, jaw surveys) — the calibration protocol is:
run the census, plot the two classes, place the threshold in the
margin, then video-verify the members nearest the line.

| Constant | Value (sotac) | Derivation basis | Margin quality |
|---|---|---|---|
| contactEnterN / ExitN | 0.15 / 0.10 N | sensor noise floor | good |
| weak-attempt line | 2.3 N | 7 video verdicts (false <=2.2, real >=2.4); ep35 phantom later hit 3.8 — WEAKENED | thin, known-violated above |
| pads-meet position | 2.0 units | ep0 dwell 0.5 vs foam-crush 2.8 | thin (0.8 u), rig-specific |
| release travel / windows | 2 u over [-0.5,+1.0 s] | churn max +0.7 vs release min +2.8 | ok |
| closing veto | -1 u / 0.5 s | ep47 split -5.7/+22.8 | good |
| hand-quiet | <1.0 N for 0.35 s | above 0.8 N standing phantom, below 1.4 N clamp; ep35 resurgence at +0.33 s | thin BOTH sides |
| jaw retry rise | 5 u in 2.5 s | +22.8/+24.7 real vs 0.0 false | wide |
| squeeze-through | 8 u below own hold | 17-19 observed vs 0 | wide |
| air-miss travel / reset window | 8 u / first 2 s | reset wiggles all in first ~1.5 s | ok |
| arm motion | 12 u/s for 0.15 s | bimodal 0-1 vs 30+ | wide valley |
| D2 recovery / carry-gap | 25% / 1.5 s | real staged max 1.43 s vs false min 1.7 s | THINNEST in the system |
| D5 post-anchor | 1.5 s | corpus gap | ok |
| merge/pairing gaps | 0.5-1.0 s | bout structure | conventional |

Added since the original audit (2026-08-31 rounds, all census-derived with
provenance comments at the constants):

| Constant | Value (sotac) | Derivation basis | Margin quality |
|---|---|---|---|
| sustained_slide: CoP travel / jaw open | 2 mm in 1 s / +1 u | 69-event census; survivors +5.1/+2.55 vs 62 closing events | ok / jaw gate moderate |
| slide squeeze-rebound veto | -5 u in prior 1.5 s | kills -26/-39/-15 preludes; survivors -0.3/0/+7.8 | wide |
| slide terminal veto | 1.0 s ahead (success eps only) | kills ep53 0.46 s vs keeps ep23 1.48 s | THIN |
| screen reference corpus + vote | 971 windows, 4/7 background | LOO: bg 88.6% self-ID, terminals 2.5-4.5% FA | per-rig artifact, regenerate |
| hesitation p90s + strong gate | 6.32/2.20/4.56/1.26 s, 1.2x | 62-ep census; fires 1.23x+ (verified), silent 1.16x ("not obvious") | strong gate THIN (1.16 vs 1.23) |
| short_transport | < 1.0 s | ep39 0.78 vs next 1.46, p5 1.55 | wide |
| attempt-merge reopen | < 5 u between spans | merge 0.1 u vs keep 17.2/17.4 u | wide |

Added 2026-09-03 (the post-release residual class — Zheng's rulings on
ep37; mechanism and census in the commit message of `76ec368`). The
first two are Tier 1 physics with one measured input; the gate's numbers
are Tier 2:

| Constant | Value (sotac) | Derivation basis | Margin quality |
|---|---|---|---|
| force quantum (`TactileSeries.quantumN`) | 0.2 N, MEASURED per series | smallest non-zero raw fz; identical in all 124 sidecar files (the datasheet's 0.1 N/LSB is not what the firmware emits) | measured, not tuned |
| single-taxel exit floor (`SINGLE_TAXEL_QUANTA`) | ≤1 raw-loaded taxel at ≤1.5 quanta | one stuck taxel with float/absorption margin, below any two-taxel contact (2 quanta) | physics |
| residual gate quiet margin / sustain | 1.0 N / 0.3 s | = idle-tracker margin and exit debounce; stuck taxels never reach it, bursts (≤0.16 s) never last | inherits their margins |
| residual gate arming: stuck taxels | ≤3 taxels at ≤3 quanta, jaw opened ≥5 u from the hold | ep25 tail 2 stuck, ep28 3 stuck; a thin 3-taxel hold with the jaw closed is a dip, not an exit (ep49) | ok, jaw-gated |
| residual gate retry confirm | sustained load within 3 s of a re-close | attempt rule: retry cycle completes within 2.5 s; post-task jaw reset (ep22 83→43 u, ep23 74→55 u) never confirms | wide |
| pre-grasp residual refusal | ≤3 taxels at ≤3 quanta while the jaw is not closing | start residuals (ep25/ep36, 1 taxel at 0.2 N) vs grazes (≥11 taxels, ep9/16/23/54) | wide on taxel count; ep40's 1-taxel table touch is the one known casualty |

Porting note: the residual class is finger- and session-specific (15/124
post-release windows on sotac, ALL finger 1, one block of sessions, the
same physical taxels; 1 of 6 checked episodes of the later contributed
data). The census script (`scratchpad/post_release_census.py` pattern:
post-release loaded fraction, stuck taxels, burst count per finger) is
the diagnostic to rerun on any new rig before trusting the gate's numbers.

## Step ZERO (2026-08-31): measure the axis before anything else

The sotac sidecars are logger-clocked (90.88 Hz fixed loop) over a
change-gated device (≤83 Hz, ~84% duplicate rows). Every derivative-based
statistic — hf above all — is calibrated ON that axis and shifts up to 8x on
an arrival-driven axis; stage anchors and the artifact classes are
axis-stable (verified: full detector on a corrected 83.33 Hz grid matches
stages 63/63 and preserves phantoms/residuals; only slip churns ~13%).
Porting to any rig therefore starts with: measure the duplicate rate and
logging discipline of the new recorder; if it logs on arrival, every hf/rate
constant must be re-derived, not scaled. Details:
`analysis/duplicate-investigation.md`.

## Tier 3 — structural assumptions (preconditions to CHECK, not rules)

1. **Single-cycle, single-object episodes.** Breaks: post-task gate,
   hygiene D5, attempt boundary "before last release", D2's re-press
   case. Multi-cycle data needs cycle segmentation FIRST.
2. **Episodes start with the jaw not yet closed on the object.**
   Plateau baseline degrades gracefully (0.4 s window) if violated.
3. **Two-finger parallel jaw**, one gripper channel with opening =
   increasing position (sign convention must be verified per rig).
4. **Raw sidecar and table clocks agree** (~2 ms verified on sotac;
   company data needs the content-matching check before trusting).
5. **Success-template default with signal-side failure override** —
   result metadata, when available, should replace the override.

## Verdict on Zheng's challenge

No rule is an enumeration over episodes. The genuine exposure is
Tier 2's thin-margin constants — especially D2's 0.27 s margin and the
weak-attempt line — which are honest calibration parameters, not
logic, but calibrated on few verdicts. Porting procedure: check
Tier 3 preconditions, rerun the census scripts on the new corpus,
re-derive every Tier 2 constant from its own margins, video-verify the
members nearest each line. The census scripts ARE the calibration
protocol.
