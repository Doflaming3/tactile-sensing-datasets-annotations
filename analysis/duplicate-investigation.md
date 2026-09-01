# Duplicate-frame investigation — check plan and findings

2026-08-31. Trigger: Zheng's manual check — the Paxini spec caps the device at
83 Hz, but the raw sidecars carry 90.88 rows/s. Confirmed: the CSV cadence is
a fixed 11.00 ms logger loop snapshotting a latest-frame buffer; rows contain
duplicated device frames. Question under investigation: **what do the
duplicates actually do to our derived signals and artifact classes (re-zero /
phantom / residual / emptiness), measured properly — not asserted.**

My earlier "dedup can't help" call was made from two coarse probes (span-level
duplicate fractions, exact-equality freshness). This plan re-does it with
structure: where duplicates sit, what a corrected time axis looks like, and
whether any derived quantity or label changes on the corrected stream.

Verdict codes per checkpoint: **CONFIRMS** (earlier call stands, now with
evidence), **OVERTURNS** (earlier call wrong), **NEW** (fact we didn't have).

---

## CP1 — Duplicate structure census (corpus-wide, all 126 files)

Where do duplicates appear?

- 1a. Fraction + run-length distribution per file; vintage split (episode
  recording date before/after the 2026-08-26 recorder change).
- 1b. **Phase attribution**: duplicate rate inside approach / grasp /
  transport / place spans (anchors from the current detector dumps).
- 1c. **Event-window attribution**: duplicate rate inside ±0.35 s of detected
  events vs elsewhere — do the windows the screen featurizes sit on cleaner
  or dirtier stream?
- 1d. **Finger correlation**: the two CSVs share the logger's timestamps
  row-for-row; are duplicates synchronized between fingers (device/board
  stall) or independent (per-finger quiet signal)?

Pass criterion: a defensible statement of where duplication concentrates.

## CP2 — Near-duplicate structure (the equality-threshold check)

Exact equality is the wrong lens if the device re-emits a stale state with
±1 LSB ADC flicker. Per consecutive row pair: number of changed taxel-axes
and max |Δ|. Classes: exact (Δ=0), LSB-flicker (max |Δ| ≤ 0.1 N and ≤ 8
axes changed), real change.

- 2a. Re-run the phantom-vs-real-hold freshness comparison counting
  LSB-flicker as NOT fresh. **This is the checkpoint that can overturn the
  "phantoms are fresh frames" conclusion** — if phantom spans are stale
  states + flicker, a staleness gate exists after all.

## CP3 — Corrected time axis (device-arrival reconstruction)

Collapse duplicate runs (keep first row of each), giving fresh-frame arrival
times.

- 3a. Inter-arrival distribution during dynamic stretches: does the device
  emit near a clean ~12 ms (83 Hz) grid, or bursty?
- 3b. Rolling effective device rate over episodes: does it DROP during
  specific conditions (arm motion, both-finger load = board contention)?
- 3c. Same with LSB-collapse (CP2 classes) as the stricter variant.

## CP4 — Artifact classes re-measured on the corrected stream

- 4a. **Re-zero / baselines**: per-taxel first-1 s median baselines, original
  vs dedup stream, all 63 episodes — does any baseline move ≥ 1 LSB? Do the
  ep43 1.8 N / ep47 0.8 N standing offsets change?
- 4b. **Blink census**: the settled-phantom "no gate" conclusion rested on
  zero-frame blink rates (real grazes blink 30–64%, phantoms steady).
  Recompute blink rates on the dedup axis for the adjudicated spans — does
  separation appear?
- 4c. **Residual decay shapes**: ep36 @9.61 / ep41 @7.34 tail durations on
  the corrected axis (duplicates could stretch apparent fades; the
  cliff-vs-fade release evidence used 0.01 s vs 1.2 s).
- 4d. **Derivative signals**: |dFn/dt| and hf-proxy distributions, original
  vs dedup, sample episodes — how much do duplicates deflate them?

## CP5 — Label impact (the decisive test)

Add a dedup option to the raw-series builder (drop a time sample only when
BOTH fingers' frames are exact duplicates — per-finger dedup would desync the
shared time base), run the full detector over all 63 episodes on the
corrected stream, diff atoms + flags against the current corpus output.

- Bit-identical → duplicates are immaterial to labels (CONFIRMS, strongest
  form).
- Labels move → material; classify which rules are sensitive and decide
  per-rule corrections/recalibration.

## CP6 — Verdict + actions

Write findings here, update SOTAC-_1.MD addendum + Jingyi items
(logger-clock disclosure, arrival-driven logging request), and decide whether
the dedup option ships as default-off analysis tooling or stays a probe.

---

## Findings

### CP1 — NEW: the stream is 84% duplicates, concentrated where nothing happens

- Corpus mean duplicate rate **84.2%** per finger-file (range 57–99%; longest
  frozen run 4,190 rows ≈ 46 s). My earlier "10–30%" came from loaded/dynamic
  subsets only.
- By phase: approach **95.3%**, place tail **95.4%**, grasp 70.0%, transport
  57.6%. Event windows (±0.35 s): **59.0%** vs 91.4% elsewhere — the windows
  the screen featurizes sit on the freshest stream in the corpus.
- Finger sync: phi ≈ 0.32 (partially synchronized) — a mix of board-level and
  per-finger quietness, not a pure shared stall.

### CP2/CP2a — CONFIRMS (no staleness gate), with one near-miss

- Pair classes: 85.7% exact, 2.6% LSB-flicker, 11.7% real change. Counting
  flicker as stale does not rescue the staleness gate.
- Real-change rates: settled phantoms WANDER (ep47 weld 49 Hz, ep43 60 Hz,
  ep25 tail 24 Hz) while heavy real holds FREEZE (ep50 30 N: 0.3 Hz, ep47
  clamp: 5 Hz) — a promising inversion, **but it fails exactly in the
  confusable zone**: a light real hold (ep13, 1.4 N) wanders at 46 Hz,
  indistinguishable from ep47's 2.3 N phantom at 49 Hz. Wander-rate joins
  blink-rate in the graveyard for the low-force boundary. (Fourth+ proof the
  settled-phantom class needs the recorder-side fix.)

### CP3 — NEW: the device is CHANGE-GATED, not 83 Hz-capped

- Fresh-frame rate by load: **no load 6.4 Hz, one finger 52.9 Hz, both
  fingers 67.4 Hz**. The 83 Hz manual figure is the ceiling; actual emission
  scales with activity. "91 Hz raw" was always the logger's clock.
- Fresh inter-arrivals during dynamics: main mode ~9–13 ms with heavy tails
  (21–100 ms) — bursty, not a clean grid.
- "Emptiness" is thereby EXPLAINED: quiet stretches are logger fill over a
  near-silent device.

### CP4 — mixed: re-zero survives; two old conclusions were axis artifacts

- 4a CONFIRMS: baselines shift ≤ 0.2 N (2 LSB) under dedup — **dedup cannot
  clear the re-zero/standing-offset problem.** (Note: in most files the first
  second is so duplicate-heavy that fewer than 5 fresh frames exist to
  re-estimate from — the approach plateau is logger fill.)
- 4b **OVERTURNS the blink census**: on the corrected axis real grazes stop
  "blinking" (ep16 54%→8%, ep21 48%→5%) — the blink signature that killed the
  phantom gate, and the blink-rate v2 candidate built on it, were logger
  artifacts. Both retired.
- 4c **REOPENS decay-shape**: ep41's residual "0.005 s cliff" is a 0.391 s
  fade on the device axis. The peel-cliff/drop-fade rejection used distorted
  measurements; decay-shape rules are candidates again — on the device axis
  only.
- 4d NEW: derivative stats inflate 1.3–8x on the corrected axis (|dFn/dt| p90
  18.5→148.4 N/s worst case). Every hf threshold is logger-axis-bound:
  self-consistent for sotac, NOT portable to an arrival-driven recorder.

### CP5 — OVERTURNS "immaterial": 0/63 episodes bit-identical under dedup

Full detector on the deduplicated stream: every episode's atoms change —
anchors move, events appear/disappear (ep1 gains failed_attempt@6.7-7.0s,
ep2 gains seven slips and loses its places), per-event forces shift (same
timestamp, different baseline/smoothing samples). The label set is
axis-dependent END TO END. This does NOT mean the dedup labels are better:
every threshold and all ~60 video verdicts bind to the logger axis. It means
the axis is part of the calibration.

### CP6 — Verdict and actions

Answering the motivating question ("can dedup clear re-zero / phantoms /
residuals / emptiness?"):

| problem | dedup helps? | evidence |
|---|---|---|
| re-zero / standing offsets | **No** | CP4a: ≤ 2 LSB baseline shift |
| phantoms | **No** | CP2a: wander-rate fails at the low-force boundary (ep13 vs ep47) |
| residuals | **Partially — reopens a rule** | CP4c: decay-shape evidence was axis-distorted; retest on device axis |
| emptiness | **Explained, not cleared** | CP3: change-gated device + logger fill |

Actions:
1. The logger-axis pipeline stays canonical (verdicts bind to it). The
   `dedupFrames` builder option + `run-detector --dedup` ship default-OFF as
   the investigation instrument.
2. Retired: blink-rate v2 candidate. New v2 candidate: decay-shape on the
   device axis (residual separation).
3. Jingyi items (now with a full evidence package): (a) sidecar rows are
   logger-clocked, 84% duplicated, device change-gated ~6-67 Hz — the "91 Hz
   raw" framing needs this footnote everywhere; (b) arrival-driven logging
   would make the sidecars honest for free; (c) per-episode re-zero request
   unchanged and unreplaceable.
4. Portability: any rig that logs at arrival rate needs FULL threshold
   re-derivation (CP4d: derivative statistics shift up to 8x) — added to the
   porting recipe as step zero: measure the duplicate rate first.

---

## CP7 — Zheng's beat-model plan (2026-08-31, follow-up round)

Hypothesis under test: the artifacts ("sensor loses info while grabbing",
"sensor feels something when not attached") are a SYNCHRONIZATION problem —
a regular 83.33 Hz (12 ms) device polled at ~91 Hz, duplicates = beat
re-reads; correcting the axis should change the annotator's story.

- **Step 1 (discover + rate fit)**: fitting (period, phase) against observed
  duplicate positions in dynamic stretches: balanced accuracy 0.56–0.63 vs
  chance 0.5, FLAT over 10.9–12.8 ms, no peak at 12.00. **The regular-grid
  beat model is rejected** — duplicates are not phase-locked re-reads.
  (`scripts/beat_model_fit.py`)
- **Step 2 (correct the axis, time preserved)**: `deviceGridHz` builder
  option — first frame per 12 ms slot, stamped at the slot boundary; uniform
  83.33 Hz axis without compressing real time (supersedes the CP5 collapse,
  which deleted held time and scrambled every rule). `run-detector
  --device-grid`.
- **Step 3 (rerun annotator)**: stages match **63/63** episodes (all four
  anchors within 0.033 s ≈ 3 device frames). Abnormal interjections
  **persist**: phantoms 5/5, sensor_residuals 5/5, finger_unloads 3/3, drops
  24/25, contact/release/place ≥96% stable. Only slip churns (28 lost / 40
  gained of 247 ≈ 13%) — hf texture statistics are sampling-sensitive
  (calibration effect, not artifact causation).

**CP7 verdict: synchronization hypothesis tested and closed.** The artifact
classes are value-level device output; they reproduce identically on the
corrected axis. Slip is the one detector whose calibration is axis-bound —
already covered by the porting recipe's step zero.
