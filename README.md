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
| `visualizer/` | Vendored snapshot of the HF Space `Jingyi-Z/lerobotac-dataset-visualizer` (base `47d63aa`) carrying all of our detector and UI work. The detector is `src/lib/eventDetection.ts`; the artifact screen is `src/lib/signalScreen.ts`. |
| `data/` | Gitignored local mirrors: `sotac` (63 episodes, pinned `e0fcfeb3`), `sotac_raw` (pinned `18e0dfed`), plus `annotation-history/` (tracked — irreplaceable saved-revision evidence). |
| `scripts/` | The offline runner (`run-detector.ts`), the reference-corpus builder (`build-screen-reference.ts`), the Python studies and censuses, and `calibration/` — the per-rig threshold re-derivation toolkit. |
| `analysis/` | Findings documents and audit outputs (see the docs index below). |
| `SOTAC-_1.MD` | The original teardown + ranked work plan (historical, with addenda). |
| `DATA.md` | Data/upstream management: pinned revisions, re-sync policy, merge-back procedure. |

## Running things

**The app** (dev server, port 3105 — 3005 is inside a Windows excluded port
range):

```bash
bun --bun run --cwd visualizer dev --port 3105
```

Open `http://localhost:3105/Jingyi-Z/sotac/episode_N` → Annotations tab →
**Auto-label episode**. Note the app fetches episode data from the HF Hub at
`main`, not from the pinned local mirrors.

**The offline runner** (drives the same detector on the local mirrors):

```bash
bun scripts/run-detector.ts --episode 23
```

Useful flags: `--all --compare` (corpus audit vs published annotations),
`--json out.json` (dump atoms + flags), `--th key=value` (threshold
override), `--dedup` / `--device-grid` (duplicate-investigation axes — see
below; both default off, the logger axis is canonical).

**Validation workflow** for any detector change: `bun run format && bun run
validate` in `visualizer/` (179 tests; lint carries one pre-existing
upstream warning), then a full-corpus dump + diff against the previous
output — every changed atom/flag must be explained or the change is wrong.
Video verdicts (Zheng's) arbitrate anything the signal cannot.

**Python studies** need `numpy pandas scikit-learn scipy matplotlib
pyarrow`. To rebuild the artifact screen's reference corpus (per-rig
calibration artifact): `bun scripts/build-screen-reference.ts`.

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
