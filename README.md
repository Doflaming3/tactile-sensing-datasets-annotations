# tactile-sensing-datasets-annotations

Workspace for optimizing the SoTac tactile auto-labeling pipeline. We work on
plain snapshots in this repo — never on the upstream repos directly — and merge
back once at the end. See [DATA.md](DATA.md) for the working model, pinned data
revisions, and merge-back procedure; see [SOTAC-_1.MD](SOTAC-_1.MD) for the
pipeline teardown and the ranked work plan.

## Layout

| Path | What |
|---|---|
| `SOTAC-_1.MD` | Teardown of the auto-labeler + work plan + findings addendum |
| `DATA.md` | Data manifest: pinned revisions, sync policy, merge-back steps |
| `visualizer/` | Vendored snapshot of the HF Space `Jingyi-Z/lerobotac-dataset-visualizer` (base `47d63aa`) — our changes go here |
| `scripts/download_data.py` | Reproduces the local data mirrors at the pinned revisions |
| `data/` | Local mirrors (gitignored, ~2.4 GB) — except `data/annotation-history/`, which is committed |

## Setup (per machine)

1. **Data** (~2.4 GB from the HF Hub, pinned revisions):

   ```bash
   python -m pip install -U huggingface_hub
   python scripts/download_data.py
   ```

2. **Visualizer** — install [bun](https://bun.sh), then:

   ```bash
   cd visualizer
   bun install
   bun --bun run dev
   ```

   Open http://localhost:3000 and enter `Jingyi-Z/sotac` (public — no token
   needed to browse; paste a HF token via the 🔑 button only for private data
   or higher rate limits). The `--bun` flag matters on machines without
   Node.js installed.

3. **Detector-only work** (scoring, event logic) needs no server:
   `visualizer/src/lib/eventDetection.ts` is a pure module — run it with
   `bun test` / small bun scripts.

## Conventions

- After any change in `visualizer/`: `bun run format && bun run validate`
  (per `visualizer/CLAUDE.md` — type-check, lint, format, tests).
- Never point the visualizer's annotation-save path at Jingyi's datasets with
  write credentials; test writes against a dataset in our own namespace.
- Every analysis states the pinned data revision it ran against (DATA.md).
