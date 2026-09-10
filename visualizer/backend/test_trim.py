"""Tests for backend/trim.py on a synthetic LeRobot v3 dataset.

    python -m unittest backend.test_trim      (from the visualizer folder)
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from trim import load_cuts, reduce_stats, trim_dataset

FPS = 30
STAT_KEYS = ("min", "max", "mean", "std", "count", "q01", "q10", "q50", "q90", "q99")


def nested(v):
    """pandas hands nested list cells back as object arrays of arrays"""
    if isinstance(v, np.ndarray) and v.dtype == object:
        return [nested(x) for x in v]
    if isinstance(v, (list, tuple)):
        return [nested(x) for x in v]
    return v


def _like(shape: tuple[int, ...]) -> dict:
    return {k: ([0] if k == "count" else np.zeros(shape).tolist()) for k in STAT_KEYS}


def make_dataset(root: Path, n_eps: int = 2, n_frames: int = 20) -> None:
    rng = np.random.default_rng(0)
    rows = []
    for ep in range(n_eps):
        for f in range(n_frames):
            rows.append(
                {
                    "action": (rng.normal(size=6) + ep * 10).astype(np.float32).tolist(),
                    "observation.state": (rng.normal(size=6) + ep * 10 + 1).astype(np.float32).tolist(),
                    "observation.sensors.paxini_fingertip": (rng.normal(size=(2, 2, 3)) * (f + 1)).astype(np.float32).tolist(),
                    "timestamp": np.float32(f / FPS),
                    "frame_index": f,
                    "episode_index": ep,
                    "index": ep * n_frames + f,
                    "task_index": 0,
                }
            )
    table = pa.table(
        {
            "action": pa.array([r["action"] for r in rows], type=pa.list_(pa.float32())),
            "observation.state": pa.array([r["observation.state"] for r in rows], type=pa.list_(pa.float32())),
            "observation.sensors.paxini_fingertip": pa.array(
                [r["observation.sensors.paxini_fingertip"] for r in rows],
                type=pa.list_(pa.list_(pa.list_(pa.float32()))),
            ),
            "timestamp": pa.array([r["timestamp"] for r in rows], type=pa.float32()),
            "frame_index": pa.array([r["frame_index"] for r in rows], type=pa.int64()),
            "episode_index": pa.array([r["episode_index"] for r in rows], type=pa.int64()),
            "index": pa.array([r["index"] for r in rows], type=pa.int64()),
            "task_index": pa.array([r["task_index"] for r in rows], type=pa.int64()),
        }
    )
    (root / "data" / "chunk-000").mkdir(parents=True)
    pq.write_table(table, root / "data" / "chunk-000" / "file-000.parquet")

    feats = {
        "action": {"dtype": "float32", "shape": [6], "names": [f"j{i}" for i in range(6)]},
        "observation.state": {"dtype": "float32", "shape": [6], "names": [f"j{i}" for i in range(6)]},
        "observation.sensors.paxini_fingertip": {"dtype": "float32", "shape": [2, 2, 3], "names": None},
        "observation.images.top": {"dtype": "video", "shape": [3, 480, 640], "names": ["channels", "height", "width"]},
        "timestamp": {"dtype": "float32", "shape": [1], "names": None},
        "frame_index": {"dtype": "int64", "shape": [1], "names": None},
        "episode_index": {"dtype": "int64", "shape": [1], "names": None},
        "index": {"dtype": "int64", "shape": [1], "names": None},
        "task_index": {"dtype": "int64", "shape": [1], "names": None},
    }
    info = {
        "codebase_version": "v3.0",
        "fps": FPS,
        "features": feats,
        "total_episodes": n_eps,
        "total_frames": n_eps * n_frames,
        "total_tasks": 1,
        "chunks_size": 1000,
        "data_files_size_in_mb": 100,
        "video_files_size_in_mb": 200,
        "data_path": "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
        "video_path": "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
        "robot_type": "so101",
        "splits": {"train": f"0:{n_eps}"},
    }
    (root / "meta" / "episodes" / "chunk-000").mkdir(parents=True)
    (root / "meta" / "info.json").write_text(json.dumps(info, indent=2), encoding="utf-8")

    def values(feat: str, ep: int | None) -> np.ndarray:
        sel = [r for r in rows if ep is None or r["episode_index"] == ep]
        return np.asarray([r[feat] for r in sel], dtype=np.float64)

    shapes = {
        "action": (6,),
        "observation.state": (6,),
        "observation.sensors.paxini_fingertip": (3,),
        "timestamp": (1,),
        "frame_index": (1,),
        "episode_index": (1,),
        "index": (1,),
        "task_index": (1,),
    }
    image_stats = {k: ([19407] if k == "count" else np.full((3, 1, 1), 0.5).tolist()) for k in STAT_KEYS}
    meta_rows = []
    for ep in range(n_eps):
        row = {
            "episode_index": ep,
            "tasks": ["pick"],
            "length": n_frames,
            "data/chunk_index": 0,
            "data/file_index": 0,
            "dataset_from_index": ep * n_frames,
            "dataset_to_index": (ep + 1) * n_frames,
            "videos/observation.images.top/chunk_index": 0,
            "videos/observation.images.top/file_index": 0,
            "videos/observation.images.top/from_timestamp": ep * n_frames / FPS,
            "videos/observation.images.top/to_timestamp": (ep + 1) * n_frames / FPS,
        }
        for feat, shape in shapes.items():
            for k, v in reduce_stats(values(feat, ep), _like(shape)).items():
                row[f"stats/{feat}/{k}"] = v
        for k, v in image_stats.items():
            row[f"stats/observation.images.top/{k}"] = v
        row["meta/episodes/chunk_index"] = 0
        row["meta/episodes/file_index"] = 0
        meta_rows.append(row)
    pq.write_table(pa.Table.from_pandas(pd.DataFrame(meta_rows), preserve_index=False), root / "meta" / "episodes" / "chunk-000" / "file-000.parquet")

    stats = {feat: reduce_stats(values(feat, None), _like(shape)) for feat, shape in shapes.items()}
    stats["observation.images.top"] = image_stats
    (root / "meta" / "stats.json").write_text(json.dumps(stats), encoding="utf-8")
    pq.write_table(pa.table({"task_index": [0], "task": ["pick"]}), root / "meta" / "tasks.parquet")

    v = root / "videos" / "observation.images.top" / "chunk-000"
    v.mkdir(parents=True)
    (v / "file-000.mp4").write_bytes(b"not really a video")

    for ep in range(n_eps):
        d = root / "sensors" / "paxini_fingertip" / f"episode_{ep:06d}"
        d.mkdir(parents=True)
        start = (ep + 1) * 1_000_000_000_000
        (d / "alignment.json").write_text(json.dumps({"episode_start_timestamp_ns": start, "clock": "time.time_ns (epoch)"}), encoding="utf-8")
        t = np.arange(start - 500_000_000, start + 2_500_000_000, 10_000_000, dtype=np.int64)
        pd.DataFrame({"timestamp_ns": t, "calibrated_timestamp_ns": t, "fz": np.linspace(0, 1, len(t))}).to_csv(d / "sensor_1.csv", index=False, encoding="utf-8-sig")
        (d / "meta.json").write_text("{}", encoding="utf-8")

    a = root / "annotations"
    a.mkdir()
    (a / "episode_000000.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "episode_index": 0,
                "saved_at": "2026-09-09T00:00:00Z",
                "atoms": [
                    {"role": "assistant", "content": "approach", "style": "subtask", "timestamp": 0.05},
                    {"role": "assistant", "content": "grasp", "style": "subtask", "timestamp": 0.2},
                    {"role": "assistant", "content": "[auto:high] contact_onset f0", "style": "interjection", "timestamp": 0.5},
                    {"role": "assistant", "content": "late", "style": "interjection", "timestamp": 0.66},
                ],
            }
        ),
        encoding="utf-8",
    )
    (a / "episode_annotations.json").write_text(json.dumps({"format": "x", "episodes": {"0": {"ok": True}, "1": {"ok": False}}}), encoding="utf-8")
    (a / "batch_report.json").write_text("{}", encoding="utf-8")


class TrimTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="trimtest_"))
        self.src = self.tmp / "src"
        self.src.mkdir()
        make_dataset(self.src)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_cut_one_episode(self) -> None:
        out = self.tmp / "out"
        summary = trim_dataset(self.src, out, {0: (3, 14)})
        self.assertEqual(summary["frames_before"], 40)
        self.assertEqual(summary["frames_after"], 32)
        self.assertEqual(summary["episodes"], 2)

        data = pq.read_table(out / "data" / "chunk-000" / "file-000.parquet")
        self.assertEqual(data.num_rows, 32)
        df = data.to_pandas()
        e0 = df[df.episode_index == 0]
        e1 = df[df.episode_index == 1]
        self.assertEqual(e0.frame_index.tolist(), list(range(12)))
        self.assertEqual(e0["index"].tolist(), list(range(12)))
        self.assertEqual(e1["index"].tolist(), list(range(12, 32)))
        np.testing.assert_allclose(e0.timestamp.to_numpy(), np.arange(12) / FPS, atol=1e-6)
        self.assertEqual(str(data.schema.field("timestamp").type), "float")
        raw = pq.read_table(self.src / "data" / "chunk-000" / "file-000.parquet").to_pandas()
        raw0 = raw[raw.episode_index == 0].iloc[3:15]
        np.testing.assert_allclose(np.stack(e0.action.to_numpy()), np.stack(raw0.action.to_numpy()))

        meta = pd.read_parquet(out / "meta" / "episodes" / "chunk-000" / "file-000.parquet").set_index("episode_index")
        self.assertEqual(int(meta.loc[0, "length"]), 12)
        self.assertEqual((int(meta.loc[0, "dataset_from_index"]), int(meta.loc[0, "dataset_to_index"])), (0, 12))
        self.assertEqual((int(meta.loc[1, "dataset_from_index"]), int(meta.loc[1, "dataset_to_index"])), (12, 32))
        self.assertAlmostEqual(float(meta.loc[0, "videos/observation.images.top/from_timestamp"]), 3 / FPS)
        self.assertAlmostEqual(float(meta.loc[0, "videos/observation.images.top/to_timestamp"]), 3 / FPS + 12 / FPS)
        self.assertAlmostEqual(float(meta.loc[1, "videos/observation.images.top/from_timestamp"]), 20 / FPS)
        self.assertEqual(list(meta.loc[0, "stats/action/count"]), [12])
        np.testing.assert_allclose(np.asarray(meta.loc[0, "stats/action/min"]), np.stack(raw0.action.to_numpy()).min(0), rtol=1e-6)
        self.assertAlmostEqual(float(meta.loc[0, "stats/timestamp/max"][0]), 11 / FPS)
        self.assertEqual(float(meta.loc[0, "stats/index/min"][0]), 0.0)
        self.assertEqual(float(meta.loc[1, "stats/index/min"][0]), 12.0)
        img_mean = np.asarray(nested(meta.loc[0, "stats/observation.images.top/mean"]), dtype=np.float64)
        self.assertEqual(img_mean.shape, (3, 1, 1))
        self.assertTrue(np.all(img_mean == 0.5))
        self.assertEqual(np.asarray(nested(meta.loc[0, "stats/observation.sensors.paxini_fingertip/min"])).shape, (3,))

        info = json.loads((out / "meta" / "info.json").read_text(encoding="utf-8"))
        self.assertEqual((info["total_frames"], info["total_episodes"], info["splits"]["train"]), (32, 2, "0:2"))
        stats = json.loads((out / "meta" / "stats.json").read_text(encoding="utf-8"))
        self.assertEqual(stats["action"]["count"], [32])
        self.assertEqual(stats["observation.images.top"]["count"], [19407])
        self.assertAlmostEqual(stats["index"]["max"][0], 31.0)
        self.assertTrue((out / "meta" / "tasks.parquet").exists())
        self.assertTrue((out / "meta" / "trim.json").exists())
        self.assertTrue((out / "videos" / "observation.images.top" / "chunk-000" / "file-000.mp4").exists())

        # sidecars: ep0 cut to [start + 0.1 s, + 0.4 s), ep1 to its 20 frames
        d0 = out / "sensors" / "paxini_fingertip" / "episode_000000"
        align = json.loads((d0 / "alignment.json").read_text(encoding="utf-8"))
        self.assertEqual(align["episode_start_timestamp_ns"], 1_000_000_000_000 + 100_000_000)
        s0 = pd.read_csv(d0 / "sensor_1.csv", encoding="utf-8-sig")
        self.assertEqual(len(s0), 40)
        self.assertGreaterEqual(int(s0.calibrated_timestamp_ns.min()), 1_000_100_000_000)
        self.assertLess(int(s0.calibrated_timestamp_ns.max()), 1_000_500_000_000)
        self.assertTrue((d0 / "meta.json").exists())
        s1 = pd.read_csv(out / "sensors" / "paxini_fingertip" / "episode_000001" / "sensor_1.csv", encoding="utf-8-sig")
        self.assertEqual(len(s1), 67)

        # annotations: shifted by 0.1 s, outside the 0.4 s window dropped
        ann = json.loads((out / "annotations" / "episode_000000.json").read_text(encoding="utf-8"))
        self.assertEqual([round(a["timestamp"], 4) for a in ann["atoms"]], [0.1, 0.4])
        self.assertEqual(ann["trimmed_from"], {"episode": 0, "start_frame": 3, "kept_frames": 12})
        cur = json.loads((out / "annotations" / "episode_annotations.json").read_text(encoding="utf-8"))
        self.assertEqual(set(cur["episodes"].keys()), {"0", "1"})
        self.assertFalse((out / "annotations" / "batch_report.json").exists())

    def test_drop_and_renumber(self) -> None:
        out = self.tmp / "out2"
        summary = trim_dataset(self.src, out, {1: (5, 9)}, drop=[0], renumber=True)
        self.assertEqual(summary["dropped"], [0])
        self.assertEqual((summary["episodes"], summary["frames_after"]), (1, 5))
        df = pq.read_table(out / "data" / "chunk-000" / "file-000.parquet").to_pandas()
        self.assertEqual(df.episode_index.tolist(), [0] * 5)
        self.assertEqual(df["index"].tolist(), list(range(5)))
        meta = pd.read_parquet(out / "meta" / "episodes" / "chunk-000" / "file-000.parquet")
        self.assertEqual(meta.episode_index.tolist(), [0])
        self.assertEqual((int(meta.loc[0, "dataset_from_index"]), int(meta.loc[0, "dataset_to_index"])), (0, 5))
        self.assertAlmostEqual(float(meta.loc[0, "videos/observation.images.top/from_timestamp"]), 20 / FPS + 5 / FPS)
        info = json.loads((out / "meta" / "info.json").read_text(encoding="utf-8"))
        self.assertEqual((info["total_episodes"], info["splits"]["train"]), (1, "0:1"))
        align = json.loads((out / "sensors" / "paxini_fingertip" / "episode_000000" / "alignment.json").read_text(encoding="utf-8"))
        self.assertEqual(align["episode_start_timestamp_ns"], 2_000_000_000_000 + int(round(5 / FPS * 1e9)))
        self.assertFalse((out / "sensors" / "paxini_fingertip" / "episode_000001").exists())
        cur = json.loads((out / "annotations" / "episode_annotations.json").read_text(encoding="utf-8"))
        self.assertEqual(cur["episodes"], {"0": {"ok": False}})

    def test_bad_cuts(self) -> None:
        with self.assertRaises(ValueError):
            load_cuts({"cuts": {"0": [5, 2]}})
        with self.assertRaises(ValueError):
            trim_dataset(self.src, self.tmp / "out3", {0: (0, 99)})
        with self.assertRaises(ValueError):
            trim_dataset(self.src, self.src / "inside", {})
        self.assertEqual(load_cuts({"0": [1, 2], "3": [0, 0]}), {0: (1, 2), 3: (0, 0)})


if __name__ == "__main__":
    unittest.main()
