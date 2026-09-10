# SoTac annotation workspace

Independent working repository for improving the tactile auto-annotation
pipeline of the SoTac dataset (`Jingyi-Z/sotac`), plus the raw-data studies
that grew out of it. Nothing here is a clone of the upstream repos — code is
vendored as plain snapshots, data as pinned local mirrors, and merging back
upstream happens once, at the end, as a reviewed diff (see
[DATA.md](DATA.md) for the working model and pinned revisions).

> This repo previously held a bilingual download guide for the full
> Jingyi-Z dataset/model collection; that era is superseded (the guide
> lives in git history). The layout below is the current truth.

## Repository map

| Path | What it is |
|---|---|
| `visualizer/` | Vendored snapshot of the HF Space `Jingyi-Z/lerobotac-dataset-visualizer` (base `e3714c1` = her main with PR A and PR B merged, 2026-09-07) carrying all of our detector and UI work. The instrument layer is `src/lib/tactileSeries.ts` (series builders, drift correction, raw-sidecar parser, clock map — Jingyi's PR A), the residual gate is `src/lib/residualGate.ts` and the detector is `src/lib/eventDetection.ts` (both PR B; the detector wraps the builders under their old names, so callers see one API); the artifact screen is `src/lib/signalScreen.ts`. |
| `data/` | Gitignored local mirrors: `sotac` (63 episodes, pinned `e0fcfeb3`), `sotac_raw` (pinned `18e0dfed`), plus `annotation-history/` (tracked — irreplaceable saved-revision evidence). |
| `scripts/` | The offline runner (`run-detector.ts`), the reference-corpus builder (`build-screen-reference.ts`), the Python studies and censuses, and `calibration/` — the per-rig threshold re-derivation toolkit. |
| `analysis/` | Findings documents and audit outputs (see the docs index below); `raw-sidecar-spec.md` is the proposed arrival-driven tactile sidecar format (`paxini-raw/1`, validator `scripts/validate_raw_sidecar.py`). |
| `SOTAC-_1.MD` | The original teardown + ranked work plan (historical, with addenda). |
| `DATA.md` | Data/upstream management: pinned revisions, re-sync policy, merge-back procedure. |

## Running things

**The app** (dev server, port 3105 — 3005 is inside a Windows excluded port
range):

```bash
bun --bun run --cwd visualizer dev --port 3105
```

Open `http://localhost:3105/Jingyi-Z/sotac/episode_N` → Annotations tab →
**Auto-label episode**. The app fetches episode data from the HF Hub, not
from the local mirrors: a plain reference reads `main` (renumbered on
2026-09-03, 163 episodes), and `org/dataset@rev` pins every read to a Hub
revision — `http://localhost:3105/Jingyi-Z/sotac@47d46cfb/episode_N` is the
63-episode state our notes, dumps and video verdicts use (old numbering).
Pinned views are read-only: saving to the Hub is refused there.

## Using the annotator on another dataset

The rules are physics, but the **numbers** (forces, jaw units, arm speed,
stage durations, the artifact-screen reference) were measured on sotac's rig
— Paxini DP-S2015-Elite fingertips on an SO-101 — and live in a *calibration
profile* (`visualizer/src/lib/rigProfile.ts`). The app resolves a profile in
this order:

1. the dataset's own file **`meta/annotator_profile.json`** (next to
   `info.json` in the dataset repo);
2. an explicit `?profile=<id>` in the URL (a known profile applied to a
   dataset recorded on that rig under another name);
3. the built-in registry by dataset id (`Jingyi-Z/sotac*` →
   `sotac-paxini-so101`);
4. otherwise the **template**: sotac's numbers, marked *unverified*.

With the template, a reminder appears in the Auto-label panel and every
result carries a `profile_unverified` flag until a verified profile exists.
To calibrate a new rig:

1. copy the template — `visualizer/public/annotator_profile.template.json`
   (served by the app at `/annotator_profile.template.json`, and linked from
   the reminder) — to `meta/annotator_profile.json` in the dataset;
2. edit the header (`id`, `label`, `sensor`, `gripper`); each number in
   `calibration` carries a `provenance` note saying whether it was *measured*
   on sotac (re-measure here) or came from a *video verdict* (verify here);
   the protocol is `analysis/portability.md` with the census scripts under
   `scripts/calibration/`; if the sensor's taxel count has no built-in
   table (the app then says `no_layout`), add its geometry under `layouts`,
   keyed by taxel count: `{ "<count>": { "model": "...", "points": [[x, y, z], ...] } }`
   in mm with the finger's long axis along +Y — the detector's CoP rules
   and the 3-D tiles use it;
3. decide the **interpretation layer**: `interpretation: false` (the
   default, *base mode*) runs only the base taxonomy, subtasks and
   capability flags, so nothing from the attempts / phantom and residual
   logic / hesitation / screen layer reaches the saved annotations;
   `interpretation: true` opts the dataset in. The Auto-label panel shows
   which mode it is in and offers a per-session opt-in;
4. set `verified: true` only after the numbers were checked on this rig —
   the flag and the reminder go away, and the artifact screen runs if a
   `screenReferencePath` points at a reference built with
   `scripts/build-screen-reference.ts` on this dataset.

Results also carry `no_layout` / `no_gripper` / `no_arm` when a dataset
lacks a taxel layout, a gripper channel or arm joints, instead of degrading
silently. The offline runner follows the same order
(`--profile <id>`, `--dataset-ref <org/name>`, the mirror's own file). A
user manual with this walkthrough is planned; this section is its seed.

**The offline runner** (drives the same detector on the local mirrors):

```bash
bun scripts/run-detector.ts --episode 23
```

Useful flags: `--all --compare` (corpus audit vs published annotations),
`--json out.json` (dump atoms + flags), `--th key=value` (threshold
override), `--base` (interpretation layer off — base-vs-full dumps),
`--dedup` / `--device-grid` (duplicate-investigation axes — see below; both
default off, the logger axis is canonical).

**Validation workflow** for any detector change: `bun run format && bun run
validate` in `visualizer/` (the unit suite; lint carries pre-existing
upstream hook-deps warnings only), then a full-corpus dump + diff against the previous
output — every changed atom/flag must be explained or the change is wrong.
Video verdicts (Zheng's) arbitrate anything the signal cannot.

**Python studies** need `numpy pandas scikit-learn scipy matplotlib
pyarrow`. To rebuild the artifact screen's reference corpus (per-rig
calibration artifact, written to `visualizer/public/screen-reference/` and
named by the sotac profile's `screenReferencePath`; the app fetches it on
demand, the runner reads it from disk): `bun scripts/build-screen-reference.ts`. The builder
lives in this workspace, not in the Space: it reads the local mirror through
the runner's loaders. The Space ships only the corpus itself, attached to the
sotac profile by path, out of the bundle; the screen module holds no reference of its own. Shipping the
builder with the Space is a PR-B item (Jingyi's review).

## Batch auto-annotation

**Batch** in the viewer's tab bar (or the "batch auto-label every episode"
line under the Auto-label panel) opens `/{org}/{dataset}/batch`, a
dataset-level page (`visualizer/src/app/[org]/[dataset]/batch/`). A run
goes over every episode (or a `from`/`to` range) in the browser, one at a
time: parquet rows and raw sidecars are fetched, the same pipeline as the
single-episode button runs (`visualizer/src/lib/annotateEpisode.ts`), and
the result is merged with the annotation file already on the Hub — human
atoms kept, the detector's atoms replaced (`lib/atomPolicy.ts`). Nothing
goes to the Hub during the run. Instead each changed episode is **staged**
into the browser's local copy of its annotations — the slot the viewer edits
(`lib/localAtoms.ts`) — unless that copy holds unsaved edits, which are
never overwritten (`localEdits` in the row). The page shows the run live:
progress with an estimate, counters, a per-flag histogram, and the triage
table (failed first, then the heaviest flags — `lib/batchAnnotate.ts`,
`FLAG_WEIGHTS`; sort by episode, filter to flagged / failed / changed).
Each row links to its episode on the Annotations tab, where the staged
atoms are what you see and adjust; the last run is kept in the browser
(`lib/batchStore.ts`) so the table is there when you come back.
**Commit N staged episode(s)** then writes every staged
`annotations/episode_XXXXXX.json` — the local copy, adjustments included —
plus `annotations/batch_report.json` (profile, thresholds, detector version,
the triage list) in ONE Hub commit as the signed-in user; pinned views and
unsigned sessions are refused, like the single Save. The save rule applies
to both: with an unverified profile the interpretation layer's atoms never
reach the file (`atomsForSave`). When the Hub already holds a
`batch_report.json`, the page shows that last committed batch and can list
its triage rows.

Speed: **workers** (default half the machine's cores, at most 4) is the
number of episodes handled at once, each on its own Web Worker thread
(`lib/workerPool.ts`, `lib/batch.worker.ts`, `lib/batchWorkers.ts`): the
thread reads the episode's table, sidecars and Hub file together and runs
the detector, so the page only merges, stages and draws. Every episode of
`Jingyi-Z/sotac` sits in one parquet file with a single row group, so a
per-episode read used to decode all 55k rows each time; the loader now
decodes such a file once per thread and slices it (`readRowRange` in
`utils/parquetUtils.ts` — the viewer's episode switching gains the same).
A thread's first episode is a cold start (about 10 s: metadata fetches and
that one decode); cold starts run one at a time, since four at once were a
memory peak that killed the browser tab. After that an episode costs about
0.6 s per thread; 20 episodes took 23 s on four threads. The table's `ms`
column carries the per-stage breakdown on hover, and an average line sits
above it. **Stop** ends a run after the episodes in flight; the page then
offers **Resume (N left)**, which continues with only the episodes still
owed (the rows so far kept, also after a trip into an episode), and
**Rerun**, which starts the set range over. A staging marker
(`lib/localAtoms.ts`) records what the batch wrote into each slot, so a
rerun overwrites its own earlier proposals and keeps only real edits.

## Dataset trim

Jingyi's trim ask (PR #1 review): find the dead time before and after each
recording from the trajectory signals, show the cut points on the timeline
for the reviewer, trim every modality in one click, never modify the
source, write the result to a separate repo. Her own cuts, read off
sotac_raw (`analysis/trim-census.md`, `scripts/trim_census.py`), are the
arm's motion envelope with fixed margins; the tool reproduces them.

- **Detector** (`visualizer/src/lib/trimDetect.ts`): start = 0.43 s before
  the commanded joints (`action`) first move faster than 0.5 deg/frame for
  8 frames; end = 0.53 s after the measured joints (`observation.state`)
  last move faster than 0.5 deg/frame for 2 frames. Jaw and tactile play
  no part. Scored against her 100 script-cut episodes
  (`bun scripts/trim-score.ts`, our mirror): starts within 3 frames of
  hers in 83 % and within 6 in 97 %, ends within 3 in 92 %. Flags:
  `arm_moving_at_start`, `no_motion`, `motion_to_recording_end`,
  `no_command_signal`, `sampled_rows`.
- **Trim panel** (Annotations tab, under the auto-label panel): the kept
  window on a bar with two draggable handles, the rule's onset and end as
  ticks, click to seek, start/end inputs, seek buttons, reset to the rule,
  a reviewed mark. Decisions live per episode in the browser
  (`lib/trimStore.ts`, `lerobot-trim:v1:<repo>::<ep>`).
- **Trim page** (`/{org}/{dataset}/trim`, the **Trim** tab): propose cuts
  for a range (adjusted and reviewed episodes are never replaced), the
  table of every decision (row click opens the episode), counters, a
  `cuts.json` download (`trim-cuts/1`), and the hand-off to the executor.
- **Executor** (`visualizer/backend/trim.py`, and `POST /api/trim` in the
  annotations backend): rows sliced and re-based (timestamp from 0,
  frame_index from 0, index contiguous), episode metadata rewritten
  (length, index range, video windows moved by the cut; the video files are
  carried over untouched, as in her curated dataset), per-episode and
  dataset-level stats recomputed for numeric features (image stats carried
  over), raw sidecar CSVs cut to the kept window on their epoch clock with
  `alignment.json` moved, per-episode annotation files shifted by the start
  cut, the curation file re-keyed; episodes can be dropped and the rest
  renumbered. Output to a new folder and, with `--push` / `push: true`, a
  new dataset repo; the source is never written to. Tested on a synthetic
  v3 dataset (`python -m unittest test_trim` in `visualizer/backend`) and
  on the real sotac_raw mirror: her own cuts for four episodes come back
  exactly (rows, video windows, sidecars at both ends), the other 73
  episodes untouched.

Develop and test against the mirrors as always; what ships reads through
her loaders (the page and panel already do; the executor reads a local
snapshot the backend downloads, like her export does).

## What the annotator produces

- **Four stage anchors** — approach / grasp / transport / place_release
  (transport = lift-off by ruling; grasp = the closing that leads to the
  real trial).
- **Events with honest names** — the Table VIII classes plus
  `finger_unload` (real exit while the hand holds), `sensor_residual`
  (post-release discharge), `phantom` (gate-classified non-contact). The
  app displays every sensor-true marker; saved annotations keep only real
  events.
- **Measured data on every marker** — force, jaw travel (`jaw+5.1u`), slide
  distance (`slide-2.5mm`), screen votes (`scr5/7`), hf/div/tau.
- **Flags** — `failed_attempt@A-Bs` (video-verified rule set; adjacent
  spans merge when the jaw never re-opened between them),
  `air_grasp`, `weak_contact`, `post_task_contact`, `sustained_slide`
  (CoP slide under a loosening jaw), `short_transport` (ep39-class
  wrong-location failure), `hesitation` (every stage slow, nothing failed),
  `residual_suspect` (artifact screen), `result_*` (metadata tension).
- **Human review flow** — failed-attempt and short-transport flags render
  in the Auto-label panel as adjustable span cards (seek video, nudge
  ±0.1/±0.01 s, confirm to add a `(verified)` atom that survives re-runs)
  and on the timeline's FAILED ATT. lane (dashed = detector-proposed,
  solid = human-verified).

## Data facts worth knowing before touching the raw stream

- The "91 Hz" sidecar CSVs tick at **90.88 Hz — the logger's clock, not the
  device's**. The stream is ~84% byte-identical duplicate rows; the device
  emits fresh frames change-gated (~6 Hz unloaded → ~67 Hz under load,
  ≤ the manual's 83 Hz). Stage anchors and artifact classes are invariant
  to axis correction; only slip's hf statistics are axis-bound. Full
  investigation: [analysis/duplicate-investigation.md](analysis/duplicate-investigation.md).
- The 30 Hz main table is a sample-and-hold of that already-held stream.
- Per-taxel forces quantize at 0.1 N/LSB; `fz` is unsigned by firmware.
- The known artifact classes (standing offsets, phantoms, residuals) are
  device-value problems — the fix is recorder-side per-episode re-zero
  (evidence package in the duplicate investigation and project memory).

## Docs index

| Doc | One line |
|---|---|
| [analysis/duplicate-investigation.md](analysis/duplicate-investigation.md) | Logger-vs-device rate, 84% duplicates, beat-model test, axis sensitivity (CP1–CP7). |
| [analysis/portability.md](analysis/portability.md) | Every rule classified Tier 1/2/3; the porting recipe and calibration protocol. |
| [analysis/meeting-briefing.md](analysis/meeting-briefing.md) | Demo script + plain-English rule explanations for the merge conversation. |
| [analysis/ground-truth-deltas.md](analysis/ground-truth-deltas.md) | Recovered human corrections from annotation-history diffs (dated snapshot). |
| [analysis/detector-vs-published.md](analysis/detector-vs-published.md) | Early consistency audit vs published annotations (dated snapshot). |
| `analysis/raw-stage-knn/`, `analysis/raw-event-knn/` | Raw-data study outputs: stage/event separability, t-SNE, screen validation, slide censuses. |

## Ground rules

- **Never push to Jingyi's repos or datasets from here.** The visualizer
  Space write path must not be pointed at her datasets with credentials.
- **Never re-download data implicitly** — revisions are pinned in DATA.md;
  syncing is a deliberate, recorded act.
- Every threshold is a calibration artifact with provenance in a code
  comment; re-derive per rig via `scripts/calibration/` (see
  portability.md, including its step zero: measure the duplicate rate).
