# Exit signature study: loss vs deliberate exit, tactile only

Dump: `our-atoms-18`. Windows: 1.0 s before to 0.3 s after each exit, raw 91 Hz sidecar, both fingers' data, no jaw, no arm, no outcome.

Exits: 143 — {'deliberate': 118, 'loss': 20, 'unload': 5}. `loss` = detector drops (+ ep48's escape exits 12.18/12.20 by video); `deliberate` = releases; `unload` = finger_unload (reported, not trained on).

## 1. Standard statistics (loss vs deliberate)

Median [IQR] per class, Mann-Whitney U p (two-sided), and where the four slide-exits fall as class percentiles (loss-percentile / deliberate-percentile).

| feature | loss median [IQR] | deliberate median [IQR] | p | AUC(loss>deliberate) |
|---|---|---|---|---|
| active_hold | 1.66 [0, 6.5] | 12.3 [7.81, 19.7] | 2.7e-07 | 0.14 |
| copy_travel_near_mm | 1.18 [0.0377, 2.26] | -0.184 [-1.08, 0.0389] | 2.5e-06 | 0.85 |
| fs_hold_N | 0.313 [0, 1.82] | 3.57 [2.52, 4.67] | 4.2e-06 | 0.18 |
| unload_80to20_s | 0 [0, 0.00825] | 0.0938 [0.0287, 0.326] | 1.2e-05 | 0.20 |
| fn_hold_N | 0.333 [0, 2] | 4.14 [2.54, 7.27] | 1.7e-05 | 0.20 |
| cop_speed_near_mm_s | 1.7 [0.148, 8.79] | -0.429 [-2.13, 0.105] | 7.2e-05 | 0.79 |
| tau_hold | 0.0023 [0, 0.972] | 1.16 [0.331, 3.03] | 0.00014 | 0.23 |
| partner_fn_near_N | 0 [0, 4.1] | 3.66 [2.16, 6] | 0.0023 | 0.29 |
| mu_slope_near | -0.00299 [-0.435, 0.0906] | 0.152 [0.0107, 0.411] | 0.0044 | 0.29 |
| active_slope_near | 3.41 [-3.48, 19.2] | -3.72 [-9.76, 0.295] | 0.009 | 0.68 |
| hf_hold | 5.26 [0, 12.7] | 12.3 [3.46, 23] | 0.009 | 0.32 |
| fn_near_ratio | 1.52 [0.893, 5.69] | 0.934 [0.843, 0.987] | 0.022 | 0.71 |
| copy_hold_mm | 5.08 [1.1, 13] | 1.79 [0.635, 3.51] | 0.03 | 0.70 |
| fs_near_N | 2.06 [0.782, 4.13] | 3.29 [2.5, 4.25] | 0.039 | 0.35 |
| fn_post_N | 0 [0, 0.0174] | 0 [0, 0] | 0.097 | 0.57 |
| partner_mu_near | 0.494 [0.301, 1.05] | 0.998 [0.522, 1.17] | 0.12 | 0.34 |
| copx_travel_near_mm | -0.402 [-1.62, 0.00441] | 0 [-0.948, 0.826] | 0.13 | 0.39 |
| partner_fn_post_N | 0 [0, 0.974] | 0 [0, 0.0152] | 0.17 | 0.58 |
| fn_near_N | 3.21 [0.7, 6.79] | 3.69 [2.42, 6.33] | 0.25 | 0.42 |
| partner_slope_near_rel | -0.352 [-0.629, -0.141] | -0.621 [-1.21, -0.163] | 0.36 | 0.60 |
| hf_max_near | 64.2 [47, 82.6] | 55.5 [42.4, 78.7] | 0.39 | 0.56 |
| mu_max_near | 1.11 [1.03, 1.21] | 1.23 [1, 1.41] | 0.4 | 0.44 |
| fn_slope_near_rel | -0.676 [-1.63, -0.284] | -0.569 [-0.959, -0.143] | 0.44 | 0.43 |
| active_last | 11.8 [7, 14.7] | 12.3 [8.54, 15.2] | 0.59 | 0.46 |
| shear_swing_deg | 7.64 [1.29, 36.2] | 5.37 [1.54, 15.2] | 0.65 | 0.54 |
| mu_near | 1.02 [0.526, 1.08] | 1.01 [0.626, 1.17] | 0.79 | 0.48 |
| mu_hold | 1.02 [0.471, 1.07] | 0.956 [0.341, 1.16] | 0.88 | 0.49 |
| fn_last_N | 3 [2.01, 5.42] | 2.85 [2.08, 4.9] | 0.98 | 0.50 |
| tau_max_near | 3.38 [1.38, 8.83] | 3.76 [1.4, 8.29] | 1 | 0.50 |

Four slide-exits on the eight most separating features (value, then loss-pct / deliberate-pct):

| exit | active_hold | copy_travel_near_mm | fs_hold_N | unload_80to20_s | fn_hold_N | cop_speed_near_mm_s | tau_hold | partner_fn_near_N |
|---|---|---|---|---|---|---|---|---|
| ep23 loosening slide @10.2 (kept) f0 @11.87 | 7.82 (80/26) | 0 (22/73) | 1.97 (75/12) | 0 (75/17) | 1.56 (70/8) | -3.7 (6/12) | 0.511 (65/31) | 3.41 (70/46) |
| ep23 loosening slide @10.2 (kept) f1 @12.01 | 16.6 (95/64) | -2.14 (0/11) | 3.4 (85/45) | 0.792 (100/97) | 3.31 (80/40) | -3.23 (6/16) | 1.1 (75/48) | 1.08 (55/13) |
| ep48 ESCAPE slide @11.1 (vetoed) f1 @12.18 | 6.33 (75/16) | -0.0457 (11/56) | 2.34 (80/21) | 0.0661 (85/39) | 9.85 (90/81) | 0.121 (28/76) | 1.36 (85/53) | 16.4 (95/95) |
| ep48 ESCAPE slide @11.1 (vetoed) f1 @12.2 | 6.33 (75/16) | -0.0457 (11/56) | 2.34 (80/21) | 0.0661 (85/39) | 9.85 (90/81) | 0.121 (28/76) | 1.36 (85/53) | 16.4 (95/95) |
| ep50 settling slide @10.9 (vetoed) f1 @12.18 | 15.8 (95/62) | -2.69 (0/5) | 6 (95/90) | 0.246 (95/69) | 22.6 (100/96) | -6.59 (0/4) | 4.25 (95/78) | 3.34 (70/45) |
| ep50 settling slide @10.9 (vetoed) f0 @13.13 | 11.4 (90/47) | -0.457 (6/40) | 3.12 (85/36) | 0.0436 (80/30) | 2.94 (75/34) | -0.344 (17/54) | 0.12 (55/14) | 0 (55/3) |
| ep53 placing slide @9.7 (vetoed) f0 @10.85 | 7.76 (80/24) | -0.0697 (6/54) | 3.21 (85/39) | 0.749 (100/92) | 8.88 (85/81) | -0.114 (22/65) | 1.15 (75/50) | 7.62 (85/83) |
| ep53 placing slide @9.7 (vetoed) f1 @10.96 | 6.22 (70/16) | -0.0562 (6/56) | 2.63 (80/27) | 0 (75/17) | 7.74 (85/77) | -1.53 (11/32) | 0.53 (65/31) | 3.61 (70/49) |

## 2. KNN on the features (leave-one-episode-out)

| model | balanced acc. | ROC-AUC | loss recall | deliberate recall |
|---|---|---|---|---|
| KNN k=5, features | 0.64 | 0.78 | 0.30 | 0.98 |
| KNN k=7, features | 0.67 | 0.82 | 0.35 | 0.99 |
| KNN k=11, features | 0.53 | 0.81 | 0.05 | 1.00 |

## 3. Small models (leave-one-episode-out)

| model | balanced acc. | ROC-AUC | loss recall | deliberate recall |
|---|---|---|---|---|
| MLP 32-16 on features | 0.70 | 0.80 | 0.45 | 0.95 |
| MLP 64-16 on raw windows (7ch x 40) | 0.75 | 0.79 | 0.55 | 0.96 |
| 1-D CNN (2 conv x 16) on raw windows | 0.85 | 0.85 | 0.75 | 0.94 |

## 4. Where the slide-exits fall (probability of LOSS, model trained on all other episodes)

| exit | KNN k=5, features | KNN k=7, features | KNN k=11, features | MLP 32-16 on features | MLP 64-16 on raw windows (7ch x 40) | 1-D CNN (2 conv x 16) on raw windows |
|---|---|---|---|---|---|---|
| ep23 loosening slide @10.2 (kept) f0 @11.87 (dump label release) | 0.00 | 0.00 | 0.00 | 0.01 | 0.00 | 0.00 |
| ep23 loosening slide @10.2 (kept) f1 @12.01 (dump label release) | 0.00 | 0.00 | 0.00 | 0.00 | 0.01 | 0.00 |
| ep48 ESCAPE slide @11.1 (vetoed) f1 @12.18 (dump label release) | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| ep48 ESCAPE slide @11.1 (vetoed) f1 @12.2 (dump label release) | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| ep50 settling slide @10.9 (vetoed) f1 @12.18 (dump label finger_unload) | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | n/a |
| ep50 settling slide @10.9 (vetoed) f0 @13.13 (dump label release) | 0.00 | 0.00 | 0.00 | 0.01 | 0.00 | 0.00 |
| ep53 placing slide @9.7 (vetoed) f0 @10.85 (dump label release) | 0.00 | 0.00 | 0.00 | 0.01 | 0.11 | 0.00 |
| ep53 placing slide @9.7 (vetoed) f1 @10.96 (dump label release) | 0.00 | 0.00 | 0.00 | 0.01 | 0.01 | 0.02 |

Reading: a value near 1 means 'looks like the losses', near 0 'looks like the deliberate releases'. ep48's exits are the only ones whose gold label (loss, by video) disagrees with the template's label (release).

## 5. The four slide windows, per-taxel descriptive statistics

Window: 0.5 s before the flagged slide instant to 1.0 s after, slide finger (from the detector's slide flag) — force trend, contact spread, CoP travel along the finger (+ = toward the fingertip end of the layout), shear-to-normal ratio, partner finger.

| slide | fn start→end (N) | active taxels start→end | CoP Y travel (mm) | mu start→max | tau max (N mm) | partner fn start→end (N) |
|---|---|---|---|---|---|---|
| ep23 f0 (slide finger) — loosening, kept | 2.1→1.8 | 10→9 | +0.1 | 1.36→1.41 | 3 | 3.5→3.1 |
| ep23 f1 — loosening, kept | 3.5→3.1 | 17→16 | -0.2 | 1.04→1.18 | 6 | 2.1→1.8 |
| ep48 f1 (slide finger) — ESCAPE, vetoed | 9.8→11.3 | 5→8 | +1.3 | 0.26→0.28 | 2 | 0.0→16.9 |
| ep48 f0 — ESCAPE, vetoed | 0.0→16.9 | 0→9 | -3.3 | nan→0.34 | 2 | 9.8→11.3 |
| ep50 f1 (slide finger) — settling onto bowl, vetoed | 30.4→2.2 | 7→11 | +9.0 | 0.24→0.88 | 22 | 15.2→3.3 |
| ep50 f0 — settling onto bowl, vetoed | 15.2→3.3 | 5→12 | +0.9 | 0.30→1.09 | 1 | 30.4→2.2 |
| ep53 f0 (slide finger) — placing, vetoed | 14.7→4.3 | 6→15 | +0.9 | 0.30→0.75 | 6 | 18.7→8.4 |
| ep53 f1 — placing, vetoed | 18.7→8.4 | 7→22 | +3.7 | 0.29→0.47 | 20 | 14.7→4.3 |

## 6. Interpretation (2026-09-04)

**What the classifiers learned, and why they put ep48 at 0.00.** The corpus's
"loss" class is 20 exits, and 14 of them are light touches that vanish
instantly (hold under 1 N, one or two taxels, 80-to-20% unload in 0 s):
failed grazes and quiet exits. Deliberate releases come from full holds
(4 N, 12 taxels, unload over 0.1 s). Every model, KNN to CNN, learned
"light and abrupt = loss, heavy and gradual = deliberate" (CNN balanced
accuracy 0.85), which is real but is not the escape question. ep48's exits
are a HEAVY-hold loss (9.9 / 17.8 N, partner 16 / 11 N, unload 0.07-0.11 s,
indistinguishable from a release on every exit feature), and the corpus has
five heavy-hold losses in total (ep31 @5.03, ep32 @6.50, ep45 @7.57, ep48 x2):
too few to learn from, and only ep48 is an escape. Exit-window classification
is the wrong place to look.

**What the slide windows say (section 5).** The four slides differ in a way
the exits do not:

- placing (ep53) and settling (ep50): BOTH fingers unload together during
  the slide (14.7→4.3 with partner 18.7→8.4; 30.4→2.2 with partner
  15.2→3.3), the contact spreads (6→15, 7→11 taxels: the object pressed
  flat onto its support), and the shear-to-normal ratio climbs (0.30→0.75,
  0.24→0.88: shear persists while normal force leaves);
- the escape (ep48): the slide finger LOADS (9.8→11.3) while the partner
  is EMPTY at the slide start (0.0 N) and then slams to 16.9 N — a
  one-finger pivot (Zheng's earlier reading of the 2-D anatomy: the cup
  peels off f0 at 10.1, pivots on f1, wall-slams back at 11.4). Its
  shear-to-normal ratio is low and flat (0.26→0.28): the CoP travels by
  rolling, not friction slip;
- the loosening slide (ep23): both fingers lightly loaded and barely
  changing (2.1→1.8, 3.5→3.1), spread stable, ratio saturated at 1.4 (true
  friction slip).

**The tactile discriminator for the veto.** A placement needs both pads on
the object until the release; a slide while the partner pad carries
nothing is an object pivoting on one finger, which is never placing. On the
corpus: partner force at the slide instant is 0.0 N for the escape versus
15.2 and 18.7 N for the two placements and 3.5 N for the loosening slide —
a structural margin, not a tuned one. Proposed result-free rule: the
terminal veto does not apply when the partner finger is unloaded (below
the slide load floor, 1.0 N) at the slide instant. Corpus effect: ep48's
slide returns; ep50/ep53 stay vetoed; no other candidate exists. Known
theoretical exposure: an asymmetric placement in which one finger has
already let go while the other slides (ep25/ep33-style unloading) has no
slide candidate in this corpus.

A second observation for the rotation work: the escape's shear-to-normal
ratio stays near 0.27 while its CoP travels (rolling), whereas the
loosening slide sits at 1.4 (sliding) — a candidate feature for telling
rotation from slip that does not depend on torque amplitude.

## 7. The general rule: load retention (2026-09-04, after Zheng's objection)

Zheng: "one finger empty while the other slides is largely a special case."
Agreed — the pivot is one escape geometry. The general fact under the four
windows is load transfer: a placement takes the hand's load AWAY while the
object moves (the jaw opens to set it down), an in-grip slide moves the
object while the hand KEEPS its load, and the escape moved the cup while the
hand's load rose. Measured tactile-only as retention = total normal force
(both fingers) over the last 0.2 s of a 1-s window / over its first 0.2 s
(`scripts/load_transfer_stats.py`):

| population | n | retention median [IQR] | tail |
|---|---|---|---|
| in-grip micro-slips, no exit within 1 s | 118 | 1.03 [0.88, 1.61] | p5 0.53, min 0.33 (ep48 @9.65, the cup peeling off f0) |
| placements (place -> release) | 106 | 0.00 [0.00, 0.01] | p95 0.18, max 0.60 (ep39 @4.73, a failure episode's dubious place) |

Mann-Whitney p = 1.5e-39, AUC 0.999. Threshold 0.5: 3.4% of in-grip slips
below, 0.9% of placements above. The four sustained slides: ep23 0.88
(loosening, keep), ep48 2.88 (escape: load rises while the cup moves, keep),
ep50 0.12 and ep53 0.38 (load being removed: veto).

Proposed veto (replaces the outcome switch): the terminal veto applies only
when a placement-type exit lies within SLIDE_TERMINAL_VETO_S ahead AND load
retention over the slide window is below 0.5. It can only rescue slides
(an added condition), never veto more; exposure = placements above 0.5
(0.9%). Margins on the four: ep53 0.12 below the line, ep23 0.38 above.
