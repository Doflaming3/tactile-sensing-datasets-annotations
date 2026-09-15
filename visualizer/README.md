---
title: LeRobotAC Dataset Visualizer
emoji: 🖐️
colorFrom: green
colorTo: red
sdk: docker
app_port: 7860
pinned: false
license: apache-2.0
hf_oauth: true
hf_oauth_scopes:
  - read-repos
  - write-repos
hf_oauth_expiration_minutes: 480
---

# lerobotac dataset visualizer

Fork of [lerobot/visualize_dataset](https://huggingface.co/spaces/lerobot/visualize_dataset)
extended for tactile robot datasets (Paxini PX-6AX GEN3 and beyond):

- PXSR-style per-taxel 3D force arrows, contact timeline, tactile statistics
- raw high-frequency tactile stream viewer (~91 Hz)
- RGBD color + 16-bit depth panels (server-side ffmpeg decode, timestamp-corrected)
- per-episode-folder datasets (e.g. `summer-dong/lerobot-ball-pickplace-0813`):
  episode auto-discovery at any nesting depth, task.json cards, cross-episode statistics
- paste-token auth fallback for private datasets (no OAuth setup needed)

# LeRobot Dataset Visualizer

LeRobot Dataset Tool and Visualizer is a web application for interactive exploration and visualization of robotics datasets, particularly those in the LeRobot format. It enables users to browse, view, and analyze episodes from large-scale robotics datasets, combining synchronized video playback with rich, interactive data graphs.

## Project Overview

This tool is designed to help robotics researchers and practitioners quickly inspect and understand large, complex datasets. It fetches dataset metadata and episode data (including video and sensor/telemetry data), and provides a unified interface for:

- Navigating between organizations, datasets, and episodes
- Watching episode videos
- Exploring synchronized time-series data with interactive charts
- Analyzing action quality and identifying problematic episodes
- Visualizing robot poses in 3D using URDF models
- Paginating through large datasets efficiently

## Key Features

- **Dataset & Episode Navigation:** Quickly jump between organizations, datasets, and episodes using a sidebar and navigation controls.
- **Synchronized Video & Data:** Video playback is synchronized with interactive data graphs for detailed inspection of sensor and control signals.
- **Overview Panel:** At-a-glance summary of dataset metadata, camera info, and episode details.
- **Statistics Panel:** Dataset-level statistics including episode count, total recording time, frames-per-second, and an episode-length histogram.
- **Action Insights Panel:** Data-driven analysis tools to guide training configuration — includes autocorrelation, state-action alignment, speed distribution, and cross-episode variance heatmap.
- **Filtering Panel:** Identify and flag problematic episodes (low movement, jerky motion, outlier length) for removal. Exports flagged episode IDs as a ready-to-run LeRobot CLI command.
- **3D URDF Viewer:** Visualize robot joint poses frame-by-frame in an interactive 3D scene, with end-effector trail rendering. Supports SO-100, SO-101, and OpenArm bimanual robots.
- **Annotations Panel:** Hand-edit the v3.1 language schema (`language_persistent` + `language_events`) — subtask, plan, memory, interjection + paired speech, and VQA atoms with bounding-box / keypoint / count / attribute / spatial answers. VQA bboxes and keypoints render as overlays on the video player; drag or click on a camera to draw new ones. Backed by an optional FastAPI service (in `backend/`) for parquet rewrites and HF Hub push.
- **Batch auto-label:** From the viewer's **Batch** tab, run the tactile auto-labeler over every episode (or a range) on worker threads, review a triage table of flagged episodes, open any of them with the proposal already staged in the browser, then commit every staged annotation file plus a batch report to the Hub in one commit.
- **Dataset trim:** From the viewer's **Trim** tab, propose the dead time to cut before and after every episode from the arm's motion envelope, adjust the cut points on the episode's timeline, then trim every modality in one click — rows re-based, video windows moved, raw sidecars and annotations cut along — into a separate dataset repo through the annotations backend. The source dataset is never modified.
- **Efficient Data Loading:** Uses parquet and JSON loading for large dataset support, with pagination, chunking, and lazy-loaded panels for fast initial load.
- **Responsive UI:** Built with React, Next.js, and Tailwind CSS for a fast, modern user experience.

## Technologies Used

- **Next.js** (App Router)
- **React**
- **Recharts** (for data visualization)
- **Three.js** + **@react-three/fiber** + **@react-three/drei** (for 3D URDF visualization)
- **urdf-loader** (for parsing URDF robot models)
- **hyparquet** (for reading Parquet files)
- **Tailwind CSS** (styling)

## Getting Started

### Prerequisites

This project uses [Bun](https://bun.sh) as its package manager. If you don't have it installed:

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash
```

### Installation

Install dependencies:

```bash
bun install
```

### Development

Run the development server:

```bash
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `src/app/page.tsx` or other files in the `src/` directory. The app supports hot-reloading for rapid development.

### Other Commands

```bash
# Build for production
bun run build

# Start production server
bun start

# Run linter
bun run lint

# Format code
bun run format
```

### Environment Variables

- `DATASET_URL`: (optional) Base URL for dataset hosting (defaults to HuggingFace Datasets).
- `NEXT_PUBLIC_ANNOTATE_BACKEND_URL`: (optional) URL of the FastAPI annotation
  backend (`backend/app.py`). When set, the Annotations tab can save edits and
  rewrite parquet shards / push to the Hub. When unset the tab is read/edit
  only with sessionStorage persistence.

## Annotations backend (optional)

The Annotations tab edits LeRobot v3.1 language atoms — `language_persistent`
(broadcast subtask/plan/memory) and `language_events` (per-frame
interjection / vqa / speech) — and renders existing bbox/keypoint atoms over
the video player. Edits live in `sessionStorage` by default; to write the
new columns into `data/chunk-*/file-*.parquet` (matching the writer in
[lerobot#3471](https://github.com/huggingface/lerobot/pull/3471)) and push the
result to the Hub, run the bundled FastAPI service:

```bash
# 1. install + start the backend (port 7861 by default)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --port 7861 --reload

# 2. start the visualizer with the backend URL configured
cd ..
NEXT_PUBLIC_ANNOTATE_BACKEND_URL=http://127.0.0.1:7861 bun run dev
```

The backend exposes:

- `POST /api/dataset/load` — load a dataset by `repo_id` or `local_path`
- `GET  /api/episodes/{ep}/atoms` — list atoms for an episode
- `POST /api/episodes/{ep}/atoms` — replace atoms (event timestamps are
  snapped to exact source-frame timestamps before persisting)
- `GET  /api/episodes/{ep}/frame_timestamps` — used client-side for snapping
- `POST /api/export` — rewrite parquet with the new language columns plus
  the dataset-level `tools` column (drops legacy `subtask_index`)
- `POST /api/push_to_hub` — export and push to a target repo
- `POST /api/trim` — trim the dataset to the visualizer's cut points into a
  new folder and, with `push`, a new repo (never the source); the same as
  `python backend/trim.py --src <repo or folder> --out <dir> --cuts cuts.json`

## Batch auto-label

**Batch** at the right end of the viewer's tab bar opens `/{org}/{dataset}/batch`. A run goes over every episode (or a `from`/`to` range): each episode is read and annotated on its own Web Worker thread (default half the machine's cores, at most 4) with the same pipeline as the single-episode button, and merged with the annotation file already on the Hub — human atoms kept, the detector's atoms replaced. Nothing goes to the Hub during the run. Each changed episode is **staged** into the browser's local copy of its annotations, the slot the Annotations panel edits, unless that copy holds unsaved edits (never overwritten; the table says so). The page shows the run live: progress with an estimate, counters, a per-flag histogram and the triage table (failed first, then the heaviest flags; sort by episode; filter to flagged / failed / changed). Every row opens its episode on the Annotations tab with the proposal in place; the last run is kept per dataset, so the table is there when you come back. **Stop** ends a run after the episodes in flight and offers **Resume** (only the episodes still owed) and **Rerun**.

**Commit N staged episode(s)** writes every staged `annotations/episode_XXXXXX.json` — the local copy, adjustments included — plus `annotations/batch_report.json` (profile, thresholds, detector version, the per-episode rows, the summary) in one Hub commit as the signed-in user. Pinned views and unsigned sessions are refused, like the single Save. With an unverified profile, or none known yet, the interpretation layer's atoms never reach a file, for the batch and the single Save alike; the commit applies that rule to every staged copy. The commit names the dataset version the run started from, so it is refused if anything was committed in between (rerun, then commit). The detector marks its own subtask atoms (`origin: "auto"`); only marked atoms are replaced by a run, so a hand-placed or hand-moved subtask survives, and a Hub error other than "no file" fails the episode instead of reading as empty.

Episode reads: a parquet file with a single row group is decoded once per thread and sliced per episode (`readRowRange` in `src/utils/parquetUtils.ts`, kept as typed arrays), instead of decoded on every episode read; the viewer's episode switching gains the same.

## Dataset trim

Recordings carry dead time before the arm starts and after it stops. **Trim**
at the right end of the viewer's tab bar opens `/{org}/{dataset}/trim`.
**Propose cuts** runs a rule over a range of episodes: keep from 0.43 s
before the commanded joints (`action`) first move to 0.53 s after the
measured joints (`observation.state`) last move — the rule read off the
curated sotac's own cuts against sotac_raw, which it reproduces to within
a few frames (`src/lib/trimDetect.ts`). Stop leaves a resumable run. Every
episode's proposal is a row (click opens the episode); flags name the
cases worth a look (`arm_moving_at_start`, `motion_to_recording_end`,
`no_motion`, …).

In the episode, the **Trim** panel under the auto-label panel shows the
recording as a bar with the kept window and two draggable handles, the
rule's onset and end as ticks, seek buttons for the frames at each cut,
start/end inputs, and a reviewed mark. Decisions are kept per episode in
the browser (`src/lib/trimStore.ts`); a proposal never replaces an
adjusted or reviewed one.

**Apply the trim** hands the cuts to the annotations backend's
`POST /api/trim` (`backend/trim.py`, also a CLI): rows sliced and re-based
(timestamp from 0, frame_index from 0, index contiguous), episode metadata
rewritten with the video windows moved by the cut (the video files are
carried over untouched, the way the curated sotac was made), per-episode
and dataset-level stats recomputed for the numeric features, raw sidecar
CSVs cut to the kept window on their epoch clock with `alignment.json`
moved, per-episode annotation files shifted by the start cut; episodes
can be dropped and the rest renumbered. The result goes to a new folder
and, with `push`, a new dataset repo. The source is never written to.
Without the backend, **Download cuts.json** and run the CLI.

## Docker Deployment

This application can be deployed using Docker with bun for optimal performance and self-contained builds.

### Build the Docker image

```bash
docker build -t lerobot-visualizer .
```

### Run the container

```bash
docker run -p 7860:7860 lerobot-visualizer
```

The application will be available at [http://localhost:7860](http://localhost:7860).

### Run with custom environment variables

```bash
docker run -p 7860:7860 -e DATASET_URL=your-url lerobot-visualizer
```

## Contributing

Contributions, bug reports, and feature requests are welcome! Please open an issue or submit a pull request.

### Acknowledgement

The app was orignally created by [@Mishig25](https://github.com/mishig25) and taken from this PR [#1055](https://github.com/huggingface/lerobot/pull/1055)
