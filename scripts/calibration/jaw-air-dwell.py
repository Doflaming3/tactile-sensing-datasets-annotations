"""Every dwell of jaw pos < 2.0 across the corpus: episode, span, duration."""
import json
from pathlib import Path
import pandas as pd

ROOT = Path("data/sotac")
info = json.loads((ROOT / "meta" / "info.json").read_text(encoding="utf-8"))
g_idx = next(i for i, n in enumerate(info["features"]["observation.state"]["names"]) if "gripper" in n.lower())

metas = []
for f in sorted((ROOT / "meta" / "episodes").rglob("*.parquet")):
    df = pd.read_parquet(f)
    for _, r in df.iterrows():
        metas.append((int(r["episode_index"]), int(r["data/chunk_index"]), int(r["data/file_index"]),
                      int(r["dataset_from_index"]), int(r["dataset_to_index"])))

cache = {}
for ep, ch, fi, a, b in sorted(metas):
    p = ROOT / "data" / f"chunk-{ch:03d}" / f"file-{fi:03d}.parquet"
    if p not in cache:
        cache = {p: pd.read_parquet(p, columns=["timestamp", "index", "observation.state"])}
    df = cache[p]
    fs = int(df["index"].iloc[0])
    sl = df.iloc[a - fs : b - fs]
    t = sl["timestamp"].to_numpy(dtype=float)
    pos = [st[g_idx] for st in sl["observation.state"]]
    dwell_start = None
    spans = []
    for ts, pv in zip(t, pos):
        if pv < 2.0:
            if dwell_start is None:
                dwell_start = ts
            dwell_end = ts
        elif dwell_start is not None:
            spans.append((dwell_start, dwell_end))
            dwell_start = None
    if dwell_start is not None:
        spans.append((dwell_start, dwell_end))
    for s, e in spans:
        print(f"ep{ep}: jaw<2.0 from {s:.2f} to {e:.2f} ({e-s:.2f}s)")
