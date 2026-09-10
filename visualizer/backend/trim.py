"""Trim a LeRobot v3 dataset to reviewed cut points (the visualizer's trim
page, Jingyi's trim ask).

Cuts come from the trim page as `trim-cuts/1` JSON — episode index ->
[first kept frame, last kept frame], both inclusive. For every kept
episode the rows are sliced and re-based (timestamp from 0, frame_index
from 0, the dataset index contiguous), the episode metadata rewritten
(length, index range, the video windows moved by the cut — the video files
themselves are carried over untouched, which is how the curated sotac was
made from sotac_raw), the per-episode and dataset-level stats recomputed
for the numeric features (image stats are carried over), the raw sidecar
CSVs cut to the kept window on their epoch clock, and the per-episode
annotation files shifted by the start cut. Episodes can be dropped and
the rest renumbered contiguously. The source is never modified: everything
goes to a new folder and, with --push, to a new dataset repo.

CLI (from the visualizer folder, or anywhere with the backend's env):

    python backend/trim.py --src Jingyi-Z/sotac_raw --out /tmp/sotac-trimmed --cuts cuts.json
    python backend/trim.py --src /path/to/local/dataset --out out --cuts cuts.json --drop 2,3 --renumber
    python backend/trim.py ... --push org/name-trimmed --token $HF_TOKEN

The annotations backend (app.py) exposes the same as POST /api/trim.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

STAT_QUANTILES = {"q01": 0.01, "q10": 0.10, "q50": 0.50, "q90": 0.90, "q99": 0.99}
ROW_KEYS = ("timestamp", "frame_index", "episode_index", "index")
SNAPSHOT_PATTERNS = ["meta/*", "meta/**", "data/**", "videos/**", "sensors/**", "annotations/**"]


# ----------------------------------------------------------------- cuts


def load_cuts(source: str | Path | dict[str, Any]) -> dict[int, tuple[int, int]]:
    """A trim-cuts/1 file (or its `cuts` mapping): episode -> (start, end)."""
    if isinstance(source, (str, Path)):
        obj = json.loads(Path(source).read_text(encoding="utf-8"))
    else:
        obj = source
    mapping = obj.get("cuts", obj) if isinstance(obj, dict) else obj
    out: dict[int, tuple[int, int]] = {}
    for k, v in mapping.items():
        s, e = int(v[0]), int(v[1])
        if s < 0 or e < s:
            raise ValueError(f"episode {k}: bad cut {v}")
        out[int(k)] = (s, e)
    return out


# ----------------------------------------------------------------- stats


def _stack(values: Iterable[Any]) -> np.ndarray:
    return np.asarray([np.asarray(v, dtype=np.float64) for v in values])


def reduce_stats(vals: np.ndarray, like: dict[str, Any]) -> dict[str, Any]:
    """Stats of `vals` (rows first) in the shape of an existing stats entry:
    min/max/mean/std/quantiles reduce over every leading axis down to the
    shape the entry has (a (n,2,52,3) tactile column against a (3,) entry
    reduces over rows, fingers and taxels), count is the row count."""
    n = int(vals.shape[0])
    out: dict[str, Any] = {}
    for key, ref in like.items():
        if key == "count":
            out[key] = [n]
            continue
        target = tuple(np.asarray(ref).shape)
        if target and vals.ndim >= len(target) and tuple(vals.shape[-len(target):]) == target:
            flat = vals.reshape((-1,) + target)
        else:
            flat = vals.reshape(n, -1) if vals.ndim > 1 else vals.reshape(n, 1)
        if key == "min":
            r = flat.min(axis=0)
        elif key == "max":
            r = flat.max(axis=0)
        elif key == "mean":
            r = flat.mean(axis=0)
        elif key == "std":
            r = flat.std(axis=0)
        elif key in STAT_QUANTILES:
            r = np.quantile(flat, STAT_QUANTILES[key], axis=0)
        else:
            out[key] = ref
            continue
        out[key] = np.asarray(r, dtype=np.float64).tolist()
    return out


def _episode_stats_columns(meta_columns: list[str]) -> dict[str, list[str]]:
    """feature -> its stats columns in the episode metadata"""
    feats: dict[str, list[str]] = {}
    for c in meta_columns:
        if c.startswith("stats/"):
            feat = c[len("stats/"):].rsplit("/", 1)[0]
            feats.setdefault(feat, []).append(c)
    return feats


# ----------------------------------------------------------------- the trim


def _meta_files(root: Path) -> list[Path]:
    return sorted((root / "meta" / "episodes").rglob("*.parquet"))


def _column_values(table: pa.Table, name: str, positions: np.ndarray) -> np.ndarray:
    col = table.column(name).take(pa.array(positions))
    if pa.types.is_list(col.type) or pa.types.is_fixed_size_list(col.type) or pa.types.is_large_list(col.type):
        return _stack(col.to_pylist())
    return np.asarray(col.to_numpy(zero_copy_only=False), dtype=np.float64)


def trim_dataset(
    src_root: str | Path,
    out_root: str | Path,
    cuts: dict[int, tuple[int, int]],
    *,
    drop: Iterable[int] = (),
    renumber: bool = False,
    copy_videos: bool = True,
    log=None,
) -> dict[str, Any]:
    src = Path(src_root).expanduser().resolve()
    out = Path(out_root).expanduser().resolve()
    if out == src or src in out.parents:
        raise ValueError("the output must be outside the source dataset")
    say = log or (lambda *_: None)
    dropped = sorted({int(d) for d in drop})

    info = json.loads((src / "meta" / "info.json").read_text(encoding="utf-8"))
    fps = float(info.get("fps", 30))
    meta_files = _meta_files(src)
    if not meta_files:
        raise FileNotFoundError(f"no episode metadata under {src}")
    meta_frames = []
    meta_schema = None
    for p in meta_files:
        t = pq.read_table(p)
        meta_schema = meta_schema or t.schema
        df = t.to_pandas()
        df["__meta_file"] = str(p.relative_to(src)).replace(os.sep, "/")
        meta_frames.append(df)
    meta = pd.concat(meta_frames, ignore_index=True).sort_values("episode_index").reset_index(drop=True)
    stats_cols = _episode_stats_columns([c for c in meta.columns if c != "__meta_file"])
    cam_cols = [c[: -len("/from_timestamp")] for c in meta.columns if c.startswith("videos/") and c.endswith("/from_timestamp")]

    # the data tables, one per (chunk, file)
    tables: dict[tuple[int, int], pa.Table] = {}
    for c, f in meta[["data/chunk_index", "data/file_index"]].drop_duplicates().itertuples(index=False):
        path = src / "data" / f"chunk-{int(c):03d}" / f"file-{int(f):03d}.parquet"
        tables[(int(c), int(f))] = pq.read_table(path)

    keep_plan: dict[tuple[int, int], list[tuple[np.ndarray, int, int]]] = {k: [] for k in tables}
    new_rows: list[dict[str, Any]] = []
    per_episode: list[dict[str, Any]] = []
    running = 0
    new_ep = 0
    frames_before = 0
    dropped_set = set(dropped)
    episode_map: dict[int, int] = {}

    for _, m in meta.iterrows():
        ep = int(m["episode_index"])
        key = (int(m["data/chunk_index"]), int(m["data/file_index"]))
        t = tables[key]
        ep_col = t.column("episode_index").to_numpy()
        fi_col = t.column("frame_index").to_numpy()
        pos = np.nonzero(ep_col == ep)[0]
        pos = pos[np.argsort(fi_col[pos], kind="stable")]
        n_raw = int(len(pos))
        frames_before += n_raw
        if ep in dropped_set:
            per_episode.append({"episode": ep, "dropped": True, "frames": n_raw})
            continue
        s, e = cuts.get(ep, (0, n_raw - 1))
        if e >= n_raw:
            raise ValueError(f"episode {ep}: end frame {e} beyond the {n_raw} frames")
        keep = pos[s : e + 1]
        n = int(len(keep))
        target_ep = new_ep if renumber else ep
        episode_map[ep] = target_ep
        keep_plan[key].append((keep, target_ep, running))

        row = {k: v for k, v in m.items()}
        row["episode_index"] = target_ep
        row["length"] = n
        row["dataset_from_index"] = running
        row["dataset_to_index"] = running + n
        for cam in cam_cols:
            start_ts = float(m[f"{cam}/from_timestamp"]) + s / fps
            row[f"{cam}/from_timestamp"] = start_ts
            row[f"{cam}/to_timestamp"] = start_ts + n / fps
        # per-episode stats: numeric features from the kept rows; the row
        # keys from their new values; images carried over
        for feat, cols in stats_cols.items():
            like = {c.rsplit("/", 1)[1]: m[c] for c in cols}
            if feat == "timestamp":
                vals = np.arange(n, dtype=np.float64) / fps
            elif feat == "frame_index":
                vals = np.arange(n, dtype=np.float64)
            elif feat == "index":
                vals = np.arange(running, running + n, dtype=np.float64)
            elif feat == "episode_index":
                vals = np.full(n, float(target_ep))
            elif feat in t.column_names:
                vals = _column_values(t, feat, keep)
            else:
                continue
            for k, v in reduce_stats(vals, like).items():
                row[f"stats/{feat}/{k}"] = v
        new_rows.append(row)
        per_episode.append(
            {
                "episode": ep,
                "new_episode": target_ep,
                "frames": n_raw,
                "kept": n,
                "start": int(s),
                "end": int(e),
                "cut_before_s": round(s / fps, 4),
                "cut_after_s": round((n_raw - 1 - e) / fps, 4),
            }
        )
        running += n
        new_ep += 1

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    # data files: the kept rows of every episode, re-based
    all_kept: dict[str, list[np.ndarray]] = {}
    for key, t in tables.items():
        plans = keep_plan[key]
        if not plans:
            continue
        positions = np.concatenate([p[0] for p in plans])
        sub = t.take(pa.array(positions))
        ep_vals = np.concatenate([np.full(len(p[0]), p[1]) for p in plans])
        fi_vals = np.concatenate([np.arange(len(p[0])) for p in plans])
        ts_vals = fi_vals / fps
        ix_vals = np.concatenate([np.arange(p[2], p[2] + len(p[0])) for p in plans])
        for name, vals in (("episode_index", ep_vals), ("frame_index", fi_vals), ("timestamp", ts_vals), ("index", ix_vals)):
            if name not in sub.column_names:
                continue
            idx = sub.schema.get_field_index(name)
            sub = sub.set_column(idx, sub.schema.field(name), pa.array(vals).cast(sub.schema.field(name).type))
        rel = Path("data") / f"chunk-{key[0]:03d}" / f"file-{key[1]:03d}.parquet"
        (out / rel).parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(sub, out / rel)
        for name in sub.column_names:
            if name.startswith("observation.images."):
                continue
            all_kept.setdefault(name, [])
        say(f"data: {rel} {sub.num_rows} rows")
    # dataset-level stats need every kept row of every numeric feature
    numeric_feats: dict[str, list[np.ndarray]] = {}
    for key, t in tables.items():
        for keep, target_ep, start_index in keep_plan[key]:
            n = len(keep)
            for feat in list(info.get("features", {}).keys()) + list(ROW_KEYS):
                if feat in ("timestamp", "frame_index", "index", "episode_index"):
                    vals = {
                        "timestamp": np.arange(n) / fps,
                        "frame_index": np.arange(n, dtype=np.float64),
                        "index": np.arange(start_index, start_index + n, dtype=np.float64),
                        "episode_index": np.full(n, float(target_ep)),
                    }[feat]
                elif feat in t.column_names and not feat.startswith("observation.images."):
                    vals = _column_values(t, feat, keep)
                else:
                    continue
                numeric_feats.setdefault(feat, []).append(vals)

    # episode metadata, one file per source file
    new_meta = pd.DataFrame(new_rows)
    for rel, group in new_meta.groupby("__meta_file", sort=True):
        g = group.drop(columns="__meta_file").reset_index(drop=True)
        dst = out / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            table = pa.Table.from_pandas(g, schema=meta_schema, preserve_index=False)
        except (pa.ArrowInvalid, pa.ArrowTypeError, ValueError):
            table = pa.Table.from_pandas(g, preserve_index=False)
        pq.write_table(table, dst)

    # info.json
    kept_eps = len(new_rows)
    info_out = dict(info)
    info_out["total_frames"] = int(running)
    info_out["total_episodes"] = int(kept_eps)
    if isinstance(info.get("splits"), dict) and "train" in info["splits"]:
        info_out["splits"] = {**info["splits"], "train": f"0:{kept_eps}"}
    (out / "meta").mkdir(parents=True, exist_ok=True)
    (out / "meta" / "info.json").write_text(json.dumps(info_out, indent=4), encoding="utf-8")

    # stats.json: numeric features recomputed, the rest carried over
    stats_path = src / "meta" / "stats.json"
    if stats_path.exists():
        stats = json.loads(stats_path.read_text(encoding="utf-8"))
        for feat, chunks in numeric_feats.items():
            if feat in stats and chunks:
                stats[feat] = reduce_stats(np.concatenate(chunks, axis=0), stats[feat])
        (out / "meta" / "stats.json").write_text(json.dumps(stats, indent=4), encoding="utf-8")

    # every other meta file (tasks.parquet, …) as it is
    for p in (src / "meta").iterdir():
        if p.name in ("info.json", "stats.json") or p.name == "episodes":
            continue
        dst = out / "meta" / p.name
        if p.is_dir():
            shutil.copytree(p, dst)
        else:
            shutil.copy2(p, dst)

    # videos: carried over, the windows in the metadata do the trimming
    if copy_videos and (src / "videos").exists():
        _materialize_tree(src / "videos", out / "videos")

    # raw sidecars: rows within the kept window on the epoch clock
    sensors_root = src / "sensors"
    sidecars = 0
    if sensors_root.exists():
        for rec in sorted(p for p in sensors_root.iterdir() if p.is_dir()):
            for ep, target_ep in episode_map.items():
                ep_dir = rec / f"episode_{ep:06d}"
                if not ep_dir.exists():
                    continue
                s, _ = cuts.get(ep, (0, 0))
                n = next(r["kept"] for r in per_episode if r.get("episode") == ep and not r.get("dropped"))
                dst_dir = out / "sensors" / rec.name / f"episode_{target_ep:06d}"
                sidecars += _trim_sidecar_dir(ep_dir, dst_dir, start_frame=s, kept_frames=n, fps=fps)

    # annotations: per-episode files shifted by the start cut; the curation
    # file re-keyed; a batch report is stale by definition
    ann_root = src / "annotations"
    shifted = 0
    if ann_root.exists():
        (out / "annotations").mkdir(parents=True, exist_ok=True)
        for ep, target_ep in episode_map.items():
            p = ann_root / f"episode_{ep:06d}.json"
            if not p.exists():
                continue
            s, _ = cuts.get(ep, (0, 0))
            n = next(r["kept"] for r in per_episode if r.get("episode") == ep and not r.get("dropped"))
            doc = json.loads(p.read_text(encoding="utf-8"))
            doc["episode_index"] = target_ep
            doc["atoms"] = _shift_atoms(doc.get("atoms", []), s / fps, n / fps)
            doc["trimmed_from"] = {"episode": ep, "start_frame": int(s), "kept_frames": int(n)}
            (out / "annotations" / f"episode_{target_ep:06d}.json").write_text(json.dumps(doc, indent=2), encoding="utf-8")
            shifted += 1
        cur = ann_root / "episode_annotations.json"
        if cur.exists():
            doc = json.loads(cur.read_text(encoding="utf-8"))
            eps = doc.get("episodes")
            if isinstance(eps, dict):
                doc["episodes"] = {str(episode_map[int(k)]): v for k, v in eps.items() if int(k) in episode_map}
            (out / "annotations" / "episode_annotations.json").write_text(json.dumps(doc, indent=2), encoding="utf-8")

    summary = {
        "output_dir": str(out),
        "episodes": kept_eps,
        "dropped": dropped,
        "renumbered": renumber,
        "frames_before": int(frames_before),
        "frames_after": int(running),
        "sidecars": sidecars,
        "annotation_files": shifted,
        "per_episode": per_episode,
    }
    (out / "meta" / "trim.json").write_text(json.dumps({**summary, "cuts": {str(k): list(v) for k, v in sorted(cuts.items())}}, indent=2), encoding="utf-8")
    say(f"trimmed {kept_eps} episodes: {frames_before} -> {running} frames -> {out}")
    return summary


def _materialize_tree(src: Path, dst: Path) -> None:
    """Real files (hardlinks where the filesystem allows, else copies)."""
    for p in src.rglob("*"):
        if not p.is_file():
            continue
        target = dst / p.relative_to(src)
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(p, target)
        except OSError:
            shutil.copy2(p, target)


def _trim_sidecar_dir(src_dir: Path, dst_dir: Path, *, start_frame: int, kept_frames: int, fps: float) -> int:
    """One episode's sidecar folder: alignment.json moved to the new start,
    every CSV cut to [start, start + kept) on the clock column; other files
    copied. Returns the number of CSVs written."""
    dst_dir.mkdir(parents=True, exist_ok=True)
    align_path = src_dir / "alignment.json"
    start_ns = None
    if align_path.exists():
        align = json.loads(align_path.read_text(encoding="utf-8"))
        key = "episode_start_timestamp_ns" if "episode_start_timestamp_ns" in align else "start_timestamp_ns"
        if key in align:
            start_ns = int(align[key]) + int(round(start_frame / fps * 1e9))
            align[key] = start_ns
            align["trimmed"] = {"start_frame": int(start_frame), "kept_frames": int(kept_frames)}
        (dst_dir / "alignment.json").write_text(json.dumps(align, indent=2), encoding="utf-8")
    end_ns = None if start_ns is None else start_ns + int(round(kept_frames / fps * 1e9))
    n_csv = 0
    for p in sorted(src_dir.iterdir()):
        if p.name == "alignment.json":
            continue
        if p.suffix.lower() != ".csv" or start_ns is None:
            shutil.copy2(p, dst_dir / p.name)
            continue
        df = pd.read_csv(p, encoding="utf-8-sig")
        clock = "calibrated_timestamp_ns" if "calibrated_timestamp_ns" in df.columns else "timestamp_ns"
        if clock in df.columns:
            t = df[clock].astype(np.int64)
            df = df[(t >= start_ns) & (t < end_ns)]
        df.to_csv(dst_dir / p.name, index=False, encoding="utf-8-sig")
        n_csv += 1
    return n_csv


def _shift_atoms(atoms: list[dict[str, Any]], shift_s: float, kept_s: float) -> list[dict[str, Any]]:
    """Timestamps move by the start cut; atoms outside the kept window go."""
    out = []
    for a in atoms:
        ts = a.get("timestamp")
        if not isinstance(ts, (int, float)):
            out.append(a)
            continue
        t = float(ts) - shift_s
        if t < -1e-9 or t > kept_s + 1e-9:
            continue
        out.append({**a, "timestamp": max(0.0, t)})
    return out


# ----------------------------------------------------------------- source / push


def resolve_source(src: str, cache_root: Path, revision: str | None = None) -> Path:
    """A local folder as it is; a Hub dataset downloaded (tables, videos,
    sidecars, annotations) into the cache."""
    p = Path(src).expanduser()
    if p.exists():
        return p.resolve()
    from huggingface_hub import snapshot_download

    slug = src.replace("/", "__") + (f"@{revision}" if revision else "")
    root = cache_root / slug
    root.mkdir(parents=True, exist_ok=True)
    snapshot_download(src, repo_type="dataset", revision=revision, local_dir=root, allow_patterns=SNAPSHOT_PATTERNS)
    return root


def push_folder(folder: Path, repo_id: str, token: str | None, *, private: bool = False, commit_message: str = "Trim episodes") -> str:
    from huggingface_hub import HfApi

    api = HfApi(token=token)
    api.create_repo(repo_id=repo_id, repo_type="dataset", private=private, exist_ok=True)
    api.upload_folder(folder_path=str(folder), repo_id=repo_id, repo_type="dataset", commit_message=commit_message)
    return f"https://huggingface.co/datasets/{repo_id}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, help="local dataset folder or Hub dataset id")
    ap.add_argument("--revision", default=None)
    ap.add_argument("--out", required=True, help="output folder (created; never the source)")
    ap.add_argument("--cuts", required=True, help="trim-cuts/1 JSON from the trim page")
    ap.add_argument("--drop", default="", help="episode indices to leave out, comma-separated")
    ap.add_argument("--renumber", action="store_true", help="contiguous episode indices after drops")
    ap.add_argument("--no-videos", action="store_true", help="do not carry the video files over")
    ap.add_argument("--push", default=None, help="dataset repo to upload the result to")
    ap.add_argument("--token", default=os.environ.get("HF_TOKEN"))
    ap.add_argument("--private", action="store_true")
    ap.add_argument("--cache", default=os.environ.get("LEROBOT_ANNOTATE_CACHE", "/tmp/lerobot_visualizer_annotate_cache"))
    a = ap.parse_args()

    src = resolve_source(a.src, Path(a.cache), a.revision)
    cuts = load_cuts(a.cuts)
    drop = [int(x) for x in a.drop.split(",") if x.strip()]
    summary = trim_dataset(src, a.out, cuts, drop=drop, renumber=a.renumber, copy_videos=not a.no_videos, log=print)
    if a.push:
        url = push_folder(Path(summary["output_dir"]), a.push, a.token, private=a.private, commit_message=f"Trim {summary['episodes']} episode(s) to the arm's motion envelope")
        print(f"pushed to {url}")


if __name__ == "__main__":
    main()
