"""Which rule reproduces Jingyi's cuts? (trim cycle 1, second half)

For the newer 100 episodes (raw 77-176, cut by an automatic rule) tries
onset/end definitions on the arm joints — speed threshold and hold, on the
commanded (`action`) or measured (`observation.state`) joints — and reports
how tightly each reproduces her start cut and her last kept frame.

Usage (repo root, after trim_census.py --tag all163):
    python scripts/trim_rule_search.py [--raw data/sotac_raw_326fe149] [--census analysis/trim-census-all163.csv]
"""
import argparse
import glob

import numpy as np
import pandas as pd
import pyarrow.parquet as pq


def bounds(a: np.ndarray, thr: float, hold: int):
    """first / last frame with max joint speed > thr held `hold` frames"""
    fast = np.abs(np.diff(a, axis=0)).max(1) > thr
    on = off = None
    for i in range(len(fast) - hold + 1):
        if fast[i:i + hold].all():
            on = i + 1
            break
    for i in range(len(fast) - 1, hold - 2, -1):
        if fast[i - hold + 1:i + 1].all():
            off = i + 1
            break
    return on, off


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default="data/sotac_raw_326fe149")
    ap.add_argument("--census", default="analysis/trim-census-all163.csv")
    ap.add_argument("--from-raw", type=int, default=77, help="first raw episode of the rule-cut set")
    a = ap.parse_args()

    d = pd.read_csv(a.census)
    d = d[d.raw >= a.from_raw]
    files = sorted(glob.glob(f"{a.raw}/data/**/*.parquet", recursive=True))
    raw = pd.concat(
        [pq.read_table(f, columns=["episode_index", "frame_index", "observation.state", "action"]).to_pandas() for f in files],
        ignore_index=True,
    )
    eps = {int(e): g.sort_values("frame_index").reset_index(drop=True) for e, g in raw.groupby("episode_index") if e >= a.from_raw}
    arm = lambda g, col: np.stack(g[col].to_numpy()).astype(float)[:, :5]

    rows = []
    for col in ("observation.state", "action"):
        for thr in (0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1.0):
            for hold in (1, 2, 3, 5):
                ds, de = [], []
                for _, r in d.iterrows():
                    on, off = bounds(arm(eps[int(r.raw)], col), thr, hold)
                    if on is None:
                        continue
                    ds.append(r.start_cut - on)
                    de.append(r.kept_end_frame_raw - off)
                ds, de = np.array(ds), np.array(de)
                rows.append((col, thr, hold, len(ds), np.median(ds), ds.std(), (np.abs(ds - np.median(ds)) <= 3).mean(),
                             np.median(de), de.std(), (np.abs(de - np.median(de)) <= 3).mean()))
    b = pd.DataFrame(rows, columns=["signal", "thr_deg_per_frame", "hold", "n", "start_margin_med", "start_std", "start_within3",
                                    "end_margin_med", "end_std", "end_within3"])
    print(f"{len(d)} episodes; margins in frames (her cut minus the detected onset / her last kept frame minus the detected end)")
    print("\nbest START definitions:")
    print(b.sort_values("start_std").head(6).round(2).to_string(index=False))
    print("\nbest END definitions:")
    print(b.sort_values("end_std").head(6).round(2).to_string(index=False))


if __name__ == "__main__":
    main()
