# SoTac Annotation Pipeline — Teardown and Work Plan

Working notes on Jingyi Zou's tactile auto-labeler, written to support code work on it.
Read from public artifacts on 2026-08-26. Nothing here came from her directly.

**Status of the central claim:** she said the labeling is "not detailed enough." She did not
say which part. Section 3 is my ranked inference from the code, not her statement. Section 6
lists the questions that would settle it in one conversation.

---

## 1. Where things live

**Algorithm** — HF Space `Jingyi-Z/lerobotac-dataset-visualizer`

| Path | Size | What it is |
|---|---|---|
| `src/lib/eventDetection.ts` | 32 KB | The entire detector. Pure module, no React, no fetch. |
| `src/lib/taxel-layouts.ts` | 29 KB | Per-taxel (x,y,z) mm coordinates |
| `src/components/auto-label-panel.tsx` | 15 KB | UI driver for the detector |
| `src/components/annotations-panel.tsx` | 31 KB | Annotation editor |
| `src/context/annotations-context.tsx` | 13 KB | Annotation state |
| `src/utils/annotationsClient.ts`, `hubCommit.ts` | 5 + 6 KB | Persistence back to the Hub |
| `backend/app.py` | 33 KB | Server |

**Data** — `Jingyi-Z/sotac` (63 curated episodes / 25,401 frames), `Jingyi-Z/sotac_raw` (append-only archive)

**Output** — `annotations/episode_0000NN.json`, currently episodes 0–5 only

**Referenced but not public** — `annotation_pipeline_technical.md` (her project notes),
"group dataset supplement, Table VIII" (the 9-class taxonomy source), checklist item "C6"

---

## 2. Pipeline, six stages

Input: 30 Hz main table `(2,52,3)` or raw ~91 Hz sidecar CSVs (91 Hz is the default as of
commit `7dcc6fe`), plus gripper trajectory (derivative sign only).

1. **Reduce.** 52 taxels x 3 axes collapse to six scalars per finger: normal force (sum of fz),
   shear magnitude, spin-torque proxy about the center of pressure, edge/center shear-direction
   divergence, edge/center shear-rate ratio, high-frequency shear energy. Edge/center split =
   active taxels ranked by CoP distance, cut at the 60th percentile.
2. **Clean.** Median-5 on fn, fs, tauZ. Sample-and-hold repair for firmware frames where all
   taxels read zero but the sensor's own resultant channel reports force.
3. **Threshold.** Nine event classes with hysteresis (enter 0.15 N, exit 0.10 N) and separately
   debounced edges (`ENTER_MIN_S = 0.2`, `EXIT_MIN_S = 0.3`).
4. **Corroborate.** Independent binary-segmentation changepoints on normalized Fn+Fs (max 14
   segments, penalty 0.02). Event within 0.12 s of a changepoint gets promoted to high
   confidence; changepoint with no event nearby emits `unlabeled_transition@Xs`.
5. **Order.** State machine drops impossible sequences. `contact_onset(0) -> grasp_stable(1) ->
   {lift, slip, rotation, incipient_slip}(2) -> place(3) -> {release, drop}(4)`. Slip is exempt
   from requiring a prior stable grasp.
6. **Segment and serialize.** Four subtasks from jaw motion. Output as language atoms —
   subtasks tagged `role: assistant`, events tagged `role: user`.

Classes: `contact_onset`, `grasp_stable`, `lift`, `incipient_slip`, `slip`, `rotation`,
`place`, `release`, `drop`. Subtasks: `approach`, `grasp`, `transport`, `place_release`.

Incipient slip cites [arXiv:2307.04011](https://arxiv.org/abs/2307.04011) (PapillArray, 95.6%
offline / 96.8% transferred). Note that paper's method is *learned*; hers is a hand-crafted
geometric proxy for it.

---

## 3. The detail gap — ranked inference

### 3.1 Computed detail is discarded at serialization

`DetectedEvent` carries an `info` field. It is populated at two sites — incipient slip
(`slipDiv max ${...}`) and backfilled place (`"inferred"`). In `resultToAtoms`, the content
string is built as:

```ts
content: `[auto:${e.confidence}] ${e.label}${finger}${span}${""}`
```

The trailing `${""}` is an empty slot where `e.info` belongs. **The detail is computed and
dropped.** One-line fix, and the most literal reading of "not detailed enough."

### 3.2 Events carry no magnitude

An atom is `[auto:medium] slip f1 0.11s` — label, finger, duration. Everything the detector
knew at that instant is absent: normal force, shear magnitude and direction, torque, distance
from the slip boundary, whether it recovered.

### 3.3 All spatial information collapses in stage 1

52 taxels with known mm coordinates reduce to sums and averages. Lost: contact location on the
pad, patch size, patch shape, tip-vs-base position, centroid migration over time. The center of
pressure survives internally for the torque proxy and the edge/center split, and is never
reported.

This is the sharpest mismatch in the pipeline — the dataset's stated differentiator is the full
per-taxel map, and the annotations derived from it are spatially blind.

### 3.4 Two schema fields are defined and never filled

Every atom carries `camera: null` and `tool_calls: null`. The `camera` field being empty means
the tactile timeline is not grounded to anything visual, in a visuo-tactile dataset. The fields
exist because something was intended to go in them.

### 3.5 Enum tokens in a language schema

Content is `grasp`, `contact_onset f1`. The `role` / `tool_calls` structure is chat-completion
format, which implies a VLM consumer. Terse enums waste the format.

### 3.6 Missing classes — real, but smaller than 3.1–3.3

- **No retries.** One linear pass; the state machine resets phase on a terminal event. Her
  episode-level metadata tracks *attempt count*, so multi-attempt episodes exist and the
  timeline cannot represent them.
- **No inter-finger relations.** Events are per-finger and independent. Nothing describes one
  finger slipping while the other holds, asymmetric loading, or the object rolling between pads.
- **Nothing inside `transport`**, which is most of the episode.

---

## 4. Separate defects (not about detail)

1. **No validation numbers anywhere.** No precision, no recall, no ground-truth comparison.
   Episodes 0–5 are human-corrected and constitute an unscored validation set.
2. **Thresholds tuned at 30 Hz, default path is now 91 Hz.** Code comment: "hf is heavy-tailed:
   p90 ~ 3-5, p99 ~ 50 on sotac (30 Hz)", and `hfEnter = 15` was set against that. The rate
   correction is `hf.map(v => v / Math.max(rateHz/30, 1))` — linear, and hf is an RMS of a
   derivative over a *fixed 0.11 s window*, so it does not scale linearly with sample rate.
   Expect a systematic shift in slip sensitivity between the two input paths.
3. **One global threshold set.** `DEFAULT_THRESHOLDS` is a single constant. Grip forces in SoTac
   span ~4 N to ~50 N peak (12x). `stableMinN = 0.3 N` and `hfEnter = 15` cannot behave
   consistently across that range.
4. **`drop` vs `release` rests on one gripper-velocity sample.** `opening = gvel[exitIdx] > eps
   || gvel[i] > eps`. `drop` is emitted at *low* confidence unless hf is high. This is the least
   robust label in the file and the one a reflex controller depends on most.
5. **Silent blind spot.** `splitD` needs >=5 active taxels, else `Infinity` — every taxel becomes
   "center", `edgeN = 0`, and `slipDiv` / `edgeRateRatio` stay pinned at 0. On light contacts
   incipient slip is undetectable and nothing is flagged.
6. **Non-causal in three places** — `place` looks 0.7 s forward for recovery, place-backfill
   walks backward from a release, `median5` is centered. Correct for offline labels, unusable
   online without paying the lookahead as latency.
7. **Episodes 0–5 predate the debounce fix.** Saved 00:24–01:28; `ENTER_MIN_S` debounce landed
   at 01:17 (commit `da167ee`). Episode 0 shows contact -> grasp_stable -> release in 530 ms,
   three seconds before the `grasp` subtask starts — an approach brush labeled as a grasp.

---

## 5. Work plan

Ordered by value per unit of coordination needed. Each item states its verification.

### Tier 1 — no coordination required, do first

**T1.1 Score the detector against episodes 0–5.**
Compare auto output to the human-corrected files, per class. Report precision, recall, and
timing error.
*Verify:* a table with per-class counts and a stated matching tolerance. This is the number her
dataset paper needs and does not have.

**T1.2 Restore `e.info` in `resultToAtoms`.**
*Verify:* regenerated atoms carry the info string; diff against a current file shows only
additions.

**T1.3 Quantify the 30 Hz vs 91 Hz threshold shift.**
Run both input paths over the same episodes, compare event counts and hf distributions.
*Verify:* if p90/p99 of hf differ by more than the linear correction predicts, the correction
is wrong and needs re-derivation.

**T1.4 Fix the <5-taxel blind spot.**
*Verify:* emit a flag when incipient-slip detection is disabled by insufficient active taxels;
count how many episode-seconds that covers.

### Tier 2 — needs her input first

**T2.1 Add per-event attributes** (force, shear direction, contact centroid, patch size).
Requires knowing whether this is what she meant. See Section 6.

**T2.2 Per-episode threshold normalization** by grasp force.
*Verify:* re-score against T1.1 baseline; normalization should not make any class worse.

**T2.3 Regenerate episodes 0–5** against the current detector.
Hers to decide — they are her corrections.

### Tier 3 — research, after the deadline

**T3.1 Causal variant of the detector** for online control. Drop the lookahead in `place`,
replace centered median with trailing, measure the resulting latency and accuracy cost.
*Verify:* accuracy delta vs. the offline detector at matched latency budgets. This is the number
that determines whether a tactile reflex loop is feasible on this sensor at 91 Hz.

---

## 6. Questions for her

1. **"Detailed how — richer attributes on existing events, or more event classes?"** This picks
   between §3.1–3.3 and §3.6, which lead to different work.
2. **What is in Table VIII of the group dataset supplement?** If it specifies attributes per
   class, "not detailed enough" means the implementation has not caught up to a spec that
   already exists. This is my leading hypothesis.
3. **What is checklist item C6?** `incipient_slip` is marked "always low confidence pending C6."
4. **Can I read `annotation_pipeline_technical.md`?**
5. **Were episodes 0–5 regenerated after the debounce fix?**

---

## 7. Not verified

- Everything in Section 3 is inference. She has not said which part is insufficient.
- Table VIII, `annotation_pipeline_technical.md`, and C6 are referenced in code comments only.
- I have not run the detector. All behavior claims are from reading, not execution.
- Her GitHub (`Jingyi-Z/lerobotac`, `Jingyi-Z/paxini-sdk`) did not respond to API requests
  on 2026-08-26. **Resolved 2026-08-27** — both repos plus `robotics_notes` read; see Section 8.
- No claim here about her intent, plans, or submission targets.

---

## 8. Addendum (2026-08-27) — recording-side code and docs read

Both repos responded this time. Read: `lerobotac` (full clone, branch diffed against
upstream), the `paxini-sdk` README, and `robotics_notes` (README + docs 06/07/08).
This section records what changes or sharpens Sections 1–7.

### 8.1 Where the recording-side code actually lives

`lerobotac`'s `main` is an untouched upstream mirror (0 commits ahead, 272 behind).
All work is on branch **`hall-sensor`**: 31 commits, 2026-05-12 → 2026-08-26,
+2,649/−52 lines over 32 files.

| Area | Files | What |
|---|---|---|
| Sensor framework | `src/lerobot/sensors/`, `FeatureType.SENSOR`, `so_sensor_follower` robot | Generic streaming-sensor modality; each sensor records to `observation.sensors.<name>` |
| Paxini driver | `sensors/paxini.py` (1,030 lines) | Shared-board multi-fingertip streaming; `combined` company-format mode; raw ~91 Hz CSV sidecars + `alignment.json` |
| ACT tactile | `policies/act/tactile_encoder.py`, `processor_act.py`, `configuration_act.py`, `processor/tactile_processor.py` | Two tactile-integration routes — see 8.4 |
| Curation | `merge_tactile_datasets.py` | Merges timestamped recordings into one dataset, renumbers raw sidecars, runs sidecar integrity checks |

### 8.2 Recording-side facts that bear on Section 4

1. **The 30 Hz main table is a sample-and-hold of the 91 Hz stream, not a decimation.**
   In `combined` mode the driver keeps the latest frame per finger at full stream rate
   and the recorder snapshots it at observation time — no averaging, no anti-aliasing.
   The detector's two input paths (§4.2) therefore differ in *kind*, not just rate:
   aliased snapshots vs. the full stream. The linear `rateHz/30` correction on hf is
   doubly suspect. T1.3 stands, at higher priority.

2. **The zeroed-taxel firmware artifact is patched at the recorder as of 2026-08-26**
   (commit `0484f77`; the code comment cites "observed on sotac raw ep6 finger 0").
   When a frame carries a live resultant but an all-zero distributed block, the recorder
   now holds the last taxel frame. Two consequences: (a) the detector's stage-2 repair
   and the recorder's guard now coexist, applied to different data vintages — scoring
   work (T1.1) must track which episodes predate the guard; (b) the guard writes the
   *held* frame into the raw CSV as well, so `sotac_raw` sidecars recorded after
   08-26 are repaired, not raw, despite the archive's "append-only raw" framing.

3. **Sidecar timestamps are synthetic.** `timestamp_ns` and `calibrated_timestamp_ns`
   are both host `time.time_ns()` at frame receipt; `frame_status` and
   `time_calibration_offset_ns` are hard-coded 0. The 91 Hz timing carries USB and
   thread-scheduling jitter, not device time. Bears on the 0.12 s changepoint
   corroboration window and any timing-error metric in T1.1.

4. **Quantization floor.** Force decoding is 0.1 N/LSB on every axis, both boards
   (verified against vendor scripts per the SDK docs). The detector's hysteresis
   (enter 0.15 N / exit 0.10 N) sits at 1.5 / 1 LSB, and `stableMinN = 0.3 N` at
   3 LSB — contact-onset detection operates at the sensor's resolution floor.
   Context for §4.3 and §4.5.

5. **Hardware identified.** The 52-taxel sensor is the DP-S2015-Elite 15 mm fingertip;
   two of them sit on one High-Speed board as modules 10 (middle-tip slot) and 18
   (little-tip slot). Finger order in `(2, 52, 3)` = `module_indices` list order, so
   the f1/f2 in the annotations is that list order, not a physical left/right.

### 8.3 "Company format" — the partner spec exists

The recording mode is explicitly designed to be schema-compatible with a partner
organization's 91 Hz files, byte-for-byte (UTF-8 BOM, identical column schema).
`alignment.json` exists because the partner's own format is alignable only to ~1 s via
first-sample heuristics. The visualizer handles "ours and the company's" datasets; the
company layout carries `task.json` with 成功/失败 badges, and its video containers have
broken clocks (~3 ms residual after a `timestamp.csv` fix). This supports the Q2
hypothesis: "group dataset supplement, Table VIII" is plausibly the partner's spec that
the annotations must conform to.

### 8.4 Consumer side — the ablation grid decoded

`configuration_act.py` defines exactly three configurations, matching the
`mlxtac_act_*` model grid on her HF profile (baseline / tactile_env / tactile_token,
× redball / elastic / stackcup):

- `baseline` — no tactile input.
- `tactile_env` — `tactile_as_env_state=True`: sensor arrays flattened and folded into
  `observation.environment_state`, dataset stats remapped to match.
- `tactile_token` — `use_tactile=True`: a selectable encoder (linear / MLP / CNN / TCN /
  transformer, in `tactile_encoder.py`) maps all tactile features to **one** extra
  transformer token.

Relevance to the annotation work: these policies consume raw tactile tensors, not the
language atoms. The atoms' consumer is the VLM path (`pi0_so101` is on the profile),
consistent with §3.5's chat-format observation.

### 8.5 robotics_notes

- Docs 06 (MLX Hall sensor), 07 (noise characterization), 08 (Paxini integration) read.
  The "blocker table" referenced from the fork README is doc 08 §6 — hardware/serial
  failure modes, nothing annotation-related.
- Doc 08 §7 documents the visualizer's annotation tab: time-segment labels
  ("grasp/slip/…, custom allowed"), Grounded-VQA-style on-video bbox/keypoint marks,
  episode result + quality grade + notes, JSON export. The raw-stream viewer includes a
  "shear/normal slip indicator" (±1.5 s window around the playhead).
- **`docs/09_tactile_act_experiments.md` is listed in the README's doc table but absent
  from the repo** — the tactile-ACT experiment writeup is referenced-but-not-public,
  same status as `annotation_pipeline_technical.md`. Add to Section 6: can I read doc 09?

### 8.6 Annotation state as of 2026-08-27 evening (supersedes "episodes 0–5 only")

Pulled the `sotac` Hub history. Every visualizer save is one commit
("annotations: episode N (X atoms)"), which gives a full audit trail:

- **2026-08-26 23:49 → 08-27 01:28 UTC** — first session: episodes 0–5, with
  re-saves whose atom counts changed (ep0 24→29, ep1 21→19, ep2 20→15). The
  human corrections are recoverable as the *diff between consecutive saves* —
  edited atoms keep their `[auto:]` prefix, so the prefix alone cannot
  identify them. Pre/post pairs preserved in `data/annotation-history/`.
- **2026-08-27 14:56 → 20:46 UTC** — mass sweep: episodes 6–61 in index
  order, ~2 min/episode, **zero non-auto atoms in any file**. Pure detector
  output with at most a glance, despite `episode_annotations.json` marking
  all 63 episodes `reviewed: true` (that flag tracks episode-level metadata —
  task, result, attempts — not timeline correctness).
- `episode_annotations.json` also confirms §3.6's retry gap is not
  hypothetical: **10 of 63 episodes have `attempts > 1`** (16, 31, 32, 39,
  45, 47, 49, 50, 54, 56), and results split 57 success / 3 failure /
  3 partial. None of the multi-attempt structure is representable in the
  current event timeline.
- `curation_map.json` maps `sotac_raw` source episodes → curated indices
  (task-grouped reordering). Raw episode numbers in code comments (e.g.
  "sotac raw ep6") must be translated through it before touching curated data.
- Consequence for T1.1: the scoring baseline is *smaller and different* than
  planned — the auto-vs-corrected comparison is the save-pair diffs on 0–2
  (plus whatever eps 3–5 changed vs. a fresh detector run), not six
  independently trustworthy files. And episodes 0–5 were labeled by the
  pre-debounce detector, so a fresh run diffs against them in both directions.

### 8.7 Delta audit (2026-08-27, later): episodes 0–5 are NOT human-corrected

Supersedes the ground-truth reading in 8.6. Mechanical classification of the
save-pair deltas (`scripts/extract_deltas.py`, full writeup in
`analysis/ground-truth-deltas.md`): zero atoms moved, zero text-edited,
every added/deleted atom is auto-formatted, and each delta matches a
detector commit landing between the saves (`52b4b11` place backfill 00:09,
`8c3be6c` raw dropout hold 01:11, `da167ee` contact debounce 01:17 — all
UTC). The ep45 double-save control is bit-identical, so saves are
deterministic.

Consequences:

- **The dataset has no annotation ground truth.** Episodes 0–5 are
  regression snapshots of an evolving detector. T1.1 changes from "score
  against 0–5" to "create a hand-labeled scoring set" (stratify across the
  10 multi-attempt and 6 failure/partial episodes).
- **The §3.1 info-drop is deliberate.** Commit `bd55a13` ("compact event
  labels, drop wordy info suffix", 00:16 UTC) removed it on purpose. T1.2
  is not a revert; the detail should come back as a structured field on the
  atom (precedent: the unused `camera` / `tool_calls` slots), not as longer
  content strings.
- Section 6 question 5 is answered (0–5 track detector versions); replace
  it with: "which episodes have you verified by hand, and may we hand-label
  N episodes as the scoring set?"

### 8.8 Offline runner + full-corpus diff: her corrections recovered (2026-08-27, latest)

`scripts/run-detector.ts` replays the app's auto-label pipeline offline on the
local mirrors; 24/59 published episodes reproduce **bit-exactly**, validating
the harness. Diffing the rest against fresh default runs recovers the manual
corrections that 8.7 could not see (they live inside every save, not between
saves). Full writeup: `analysis/detector-vs-published.md`. Summary:

- **30 subtask-boundary drags on 24 episodes** — `grasp` start dragged later
  by ≈3.2 s median (29/30 later). The segmenter's "first sustained closing"
  anchor fires during approach; threshold explanations tested and excluded.
  Her most frequent manual fix, and a directly implementable detector repair:
  anchor grasp to the closing bout that leads to contact.
- **73 event deletions** — labeled false positives, by class: place 26,
  contact_onset 17, slip 13, drop 6, release 4, grasp_stable 4. By deleted
  confidence: medium 59, low 6, high 5.
- So T1.1 has a **precision** signal after all (73 labeled FPs + 30 correct
  grasp boundaries); **recall** still requires fresh hand labels.
- Amends 8.7: "no human edits" holds for the event timeline *between saves*;
  subtask boundaries in 0–5 were in fact hand-dragged before the first save
  and preserved by events-only re-runs.

### 8.9 First detector fix + a fourth defect: cross-stream clock skew

- **Grasp-anchor fix shipped** (`eventDetection.ts`, the only file changed):
  grasp anchors to the closing motion leading to the stable grasp's contact,
  walking connected closing bouts back as one motion. Against her 30 dragged
  boundaries: median |error| 3.48 s → 1.88 s, disagreeing episodes 18 → 14.
  Tests 157/157; her repo's lint fails on a pre-existing error we left alone.
- **Clock-skew claim RETRACTED (verified same day).** Content-matching the
  table's sample-and-hold tactile frames against raw rows recovers the
  table→raw clock map with no model; on sotac it is identity to ~2 ms. The
  "skew" was a misread of ep30 causality (arm-descent causes first contact
  while the jaw is stationary; the squeeze comes after). Event timestamps
  ARE trustworthy vs video, and T1.3 is not contaminated. The instrument
  survives as `buildTableToRawClockMap` — per-episode alignment check on
  sotac, and the missing-alignment supplier for company-format data. Not
  safe as a gripper-time transform (sparse anchors → non-monotone map;
  corpus 23 → 2 when tried; removed). Residual grasp-boundary error is her
  placement tolerance plus arm-caused-contact ambiguity — anchor tuning
  stopped at median 1.88 s. Details: `analysis/detector-vs-published.md`.

### 8.10 Section 7 status after this pass

| Item | Status |
|---|---|
| GitHub repos unread | Resolved — this section |
| Table VIII / `annotation_pipeline_technical.md` / C6 | Still unread; doc 09 joins the list |
| Detector never executed | Unchanged — all §3 behavior claims still from reading |
| Her intent / submission targets | Unchanged — no claim |
