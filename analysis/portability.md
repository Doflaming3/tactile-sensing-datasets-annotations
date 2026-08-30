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
