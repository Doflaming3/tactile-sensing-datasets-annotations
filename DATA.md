# Data and upstream-source management

Working model: this repo is our own workspace. Nothing here is a git clone of
Jingyi's repos — code is vendored as plain snapshots, data is direct-downloaded
as pinned snapshots. We never push to her repos or datasets from here. Merging
back happens at the end, as a reviewed diff against the recorded base revisions
below.

## Vendored code

| Path | Upstream | Base revision | Taken |
|---|---|---|---|
| `visualizer/` | HF Space `Jingyi-Z/lerobotac-dataset-visualizer` | `47d63aae3a0fec1a09b3763b13e941bbd23807ac` (2026-08-26 22:06, "Manual per-episode review marks...") | 2026-08-27 |

`visualizer/` is committed in this repo and is where our labeling changes go.
To merge back later: clone her Space fresh, check out the base revision, apply
our diff (`git diff` of base snapshot vs our tree), review, and hand it over —
or open the diff with her directly. Do not add her Space as a git remote here.
Staging rule for a PR clone: run the gates first, then read `git status`
before any `git add`. Her `tsconfig.json` has `incremental: true`, so every
type-check writes a ~320 KB `tsconfig.tsbuildinfo` cache; it rode into PR #1
through `git add -A` (Jingyi's review, 2026-09-02). `visualizer/.gitignore`
now lists `*.tsbuildinfo` (create-next-app's own line), so a clone that
carries our tree cannot stage it again.

## Local data mirrors (`data/`, gitignored)

| Path | Upstream dataset | Pinned revision | Upstream last-modified at pin time |
|---|---|---|---|
| `data/sotac/` | `Jingyi-Z/sotac` (63 curated episodes) | `e0fcfeb3171d48a88a4aa0d4fd8eaf5731f7cd58` | 2026-08-27T20:39Z |
| `data/sotac_raw/` | `Jingyi-Z/sotac_raw` (append-only raw archive) | `18e0dfed13e4a6f18b1a0be224d9a458b95f6bd6` | 2026-08-26T14:38Z |

Downloaded via `huggingface_hub.snapshot_download` with an explicit `revision`
(HTTP, no git). Sizes: sotac ≈ 1.0 GB (867 MB video), sotac_raw ≈ 1.3 GB.

Contents per dataset: `data/` (30 Hz parquet main tables), `sensors/` (raw
CSV sidecars + alignment.json per episode), `annotations/` (per-episode
JSON), `videos/` (chunked mp4), `meta/`, and in sotac a `curation_map.json`.

Rate caveat (2026-08-31, measured): the sidecar rows tick at **90.88 Hz —
the logger's fixed 11 ms loop**, not the device rate. ~84% of rows are
byte-identical duplicates; the device emits change-gated (~6 Hz unloaded to
~67 Hz loaded, ≤ the Paxini manual's 83 Hz). Labels are axis-stable except
slip's hf statistics. See `analysis/duplicate-investigation.md` before doing
any rate- or derivative-based work on these files.

### Re-sync policy

- She pushes actively (annotations for episodes 0–59 landed 2026-08-27; the
  recorder's firmware-dropout guard changed what `sotac_raw` contains as of
  2026-08-26). **Never re-download implicitly.** To sync: query the current
  revision, record it here with a date, and download to a fresh pinned dir if
  the old snapshot is still needed for comparison.
- All scoring/threshold work must state which pinned revision it ran against.
- Episode vintage matters: episodes recorded before 2026-08-26 contain the
  zeroed-taxel firmware artifact in raw form; later ones are repaired at the
  recorder. Track per-episode recording dates when scoring.

### `data/annotation-history/` — preserved annotation revisions

Every save in the visualizer is one Hub commit ("annotations: episode N (X
atoms)"). Episodes 0–5 were annotated in an overnight session (2026-08-26
23:49 → 08-27 01:28 UTC) with re-saves whose atom counts changed — the human
corrections live in the diff between consecutive saves, since edited atoms
keep their `[auto:]` prefix. Preserved locally as
`episode_NNNNNN_<rev>.json`:

| Episode | Saves (rev @ atoms) |
|---|---|
| 0 | `f99ffe5a` @ 24 → `5e0d63c2` @ 29 |
| 1 | `ab67afdc` @ 21 → `60638d51` @ 19 |
| 2 | `d38cb40f` @ 20 → `64794f91` @ 15 |
| 3 | `76352152` @ 18 (single save) |
| 4 | `646ccb29` @ 16 (single save) |
| 5 | `3a3be966` @ 17 (single save) |
| 45 | `1332842b` / `f6a3b89a` @ 10 (double-save 19 s apart, today) |

Episodes 6–61 were saved in one sweep on 2026-08-27 (14:56–20:46 UTC,
~2 min/episode, zero non-auto atoms) — treat them as pure detector output,
not ground truth, regardless of the `reviewed: true` flags in
`episode_annotations.json` (those flags track episode-level metadata review:
task, result, attempts).

### Known upstream facts to keep in mind

- Annotations at the pinned sotac revision: episodes 0–49 and 51–59 (no 50),
  plus `annotations/episode_annotations.json`. RESOLVED: only episodes 0–5
  are human-corrected; 6–59 are pure detector output saved in one sweep (see
  the annotation-history section above) — treat published stage boundaries
  and events for 6–59 as old-detector snapshots, not ground truth. Ground
  truth is the video-verdict record (project memory + analysis docs).
- The Space writes annotations back to the Hub (`hubCommit.ts`). Our local
  visualizer copy must not be pointed at her datasets with write credentials;
  test the write path only against a dataset under our own namespace.
- **The hub was renumbered on 2026-09-03** (commits `28c7b329` + `7d1afea9`):
  100 trimmed episodes contributed by Jingming Zhang (sotac_raw 77–176) were
  added and everything re-sorted by task. `Jingyi-Z/sotac` main now has 163
  episodes; old pinned indices 0–20 are unchanged, **old 21–62 are hub 71–112
  (exactly +50)**. Per-episode annotation files travelled with them. An unpinned
  reference reads hub `main`, so hub `episode_23` is now a new recording
  (raw #79) while our scripts,
  dumps, docs and memory keep the OLD numbering. The stable key is
  `source_raw_episode` in `annotations/episode_annotations.json` (sotac_raw
  is append-only). The new episodes (hub 21–70 red foam ball, 113–162 green
  rubber ball) are unreviewed, with no result/attempt metadata: a candidate
  blind test set. sotac_raw also grew (commits `dfc974e1`..`326fe149`).
  To view the old numbering in the app, pin the reference:
  `/Jingyi-Z/sotac@47d46cfb/episode_23` (the last pre-renumber commit;
  `utils/repoRef.ts`). Pinned views refuse Hub writes.
- **Sensor quantum is 0.2 N.** fz is stored in newtons and every non-zero
  value in all 124 sidecar files is a multiple of 0.2 N, not the 0.1 N/LSB
  the datasheet suggests. Under a ~5 N grip each loaded taxel reads exactly
  one quantum, so amplitude cannot separate residual from contact on such a
  finger; only structure can.
- **Post-release residual class (finger 1).** After the object leaves, finger
  1 keeps 1–3 taxels stuck at one quantum (always taxels #1/#3) plus sub-0.3 s
  bursts of 6–12 taxels on the just-released set; 15/124 post-release
  finger-windows, all finger 1, old episodes 22–42 (+25/28/33), carried over
  into the next episode's start. Finger 0 is clean after every release. No
  baseline can subtract it (a blinking taxel's mean, bursts too short); the
  detector and the corrected display refuse it structurally instead (commit
  `76ec368`); the raw display keeps it as the audit view.
