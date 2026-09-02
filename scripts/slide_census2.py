# Slide census, round 2 - jaw-coupled, short-window (the corrected mechanism
# after round 1 falsified the "gradual carry-phase drift" framing).
#
# Zheng's discriminator: ep23's valuable slide happens WHILE THE JAW LOOSENS
# on an established grasp; ep30's step happens under a closing/clamped jaw
# (normal seating - ignore). So scan 1.0 s sliding windows inside
# [grasp anchor, place_release anchor] and measure, per finger:
#   dcop   CoP-Y change over the window (loaded medians, load >= 1 N both ends)
#   djaw   jaw position change over the same window (+ = opening)
#   dgrip  grip change (N)
# Candidate rule: |dcop| >= 2 mm AND djaw >= +1 unit -> loosening slide.
# Test: fires on ep23 f0 ~8.3 s, silent on ep30's 6.9-7.3 s step.

import glob
import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from raw_event_knn import ANN, SENS
from slip_trajectory_ep23 import cop_y, load_taxels, taxel_layout_y

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data/sotac"


# LeRobot v3.0: shared file-NNN.parquet with per-row episode_index
_JAW_CACHE = {}


def load_all_jaws(gripper_idx):
    for f in sorted(glob.glob(str(DATA / "data" / "chunk-*" / "file-*.parquet"))):
        tb = pq.read_table(f, columns=["timestamp", "observation.state", "episode_index"])
        eps = np.array(tb["episode_index"].to_pylist(), int)
        t = np.array(tb["timestamp"].to_pylist(), float)
        pos = np.array([r[gripper_idx] for r in tb["observation.state"].to_pylist()], float)
        for e in np.unique(eps):
            m = eps == e
            _JAW_CACHE[int(e)] = (t[m], pos[m])


def jaw_series(ep, gripper_idx):
    if not _JAW_CACHE:
        load_all_jaws(gripper_idx)
    return _JAW_CACHE.get(ep)


def main():
    info = json.load(open(DATA / "meta/info.json", encoding="utf-8"))
    names = info["features"]["observation.state"]["names"]
    gidx = next(i for i, n in enumerate(names) if re.search("gripper", n, re.I))
    print(f"gripper = observation.state[{gidx}] ({names[gidx]})\n")
    ty = taxel_layout_y()

    events, extremes = [], []
    for ep in range(63):
        ann_path = ANN / f"episode_{ep:06d}.json"
        if not ann_path.exists() or not (SENS / f"episode_{ep:06d}").exists():
            continue
        anchors = {a["content"]: a["timestamp"]
                   for a in json.load(open(ann_path, encoding="utf-8"))["atoms"]
                   if a.get("style") == "subtask"}
        if "grasp" not in anchors:
            continue
        jw = jaw_series(ep, gidx)
        if jw is None:
            continue
        jt, jp = jw
        for fg, fname in (("f0", "sensor_1.csv"), ("f1", "sensor_2.csv")):
            t, fx, fy, fz = load_taxels(ep, fname)
            t0, t1 = anchors["grasp"], anchors.get("place_release", t[-1])
            normal = fz.sum(axis=1)
            copn = cop_y(fz, ty, valid_mask=normal > 1.0)

            def med(tc):
                m = (t >= tc - 0.15) & (t <= tc + 0.15)
                v = copn[m]
                return np.nanmedian(v) if np.isfinite(v).sum() >= 3 else np.nan

            def gmed(tc):
                m = (t >= tc - 0.15) & (t <= tc + 0.15)
                return np.median(normal[m]) if m.sum() >= 3 else np.nan

            best = None
            for tc in np.arange(t0, t1 - 1.0, 0.1):
                c0, c1 = med(tc), med(tc + 1.0)
                if not (np.isfinite(c0) and np.isfinite(c1)):
                    continue
                dcop = c1 - c0
                djaw = np.interp(tc + 1.0, jt, jp) - np.interp(tc, jt, jp)
                dgrip = gmed(tc + 1.0) - gmed(tc)
                row = {"ep": ep, "fg": fg, "t": tc, "dcop": dcop,
                       "djaw": djaw, "dgrip": dgrip}
                if abs(dcop) >= 2.0:
                    events.append(row)
                if best is None or abs(dcop) > abs(best["dcop"]):
                    best = row
            if best is not None:
                extremes.append(best)

    ev = pd.DataFrame(events, columns=["ep", "fg", "t", "dcop", "djaw", "dgrip"])
    ex = pd.DataFrame(extremes, columns=["ep", "fg", "t", "dcop", "djaw", "dgrip"])
    if ev.empty:
        print("no slide events >=2mm found")
        print(ex[ex["ep"].isin([23, 30])].round(2).to_string(index=False))
        return

    # merge overlapping windows: keep peak |dcop| per ep/fg/cluster (gap>1s)
    keep = []
    for (ep, fg), g in ev.groupby(["ep", "fg"]):
        g = g.sort_values("t")
        cluster = (g["t"].diff() > 1.0).cumsum()
        for _, c in g.groupby(cluster):
            keep.append(c.loc[c["dcop"].abs().idxmax()])
    ev = pd.DataFrame(keep).sort_values(["ep", "t"]) if keep else ev
    print(f"slide events |dcop|>=2mm (merged): {len(ev)}")
    ev["fires"] = ev["djaw"] >= 1.0
    print(ev.round(2).to_string(index=False))
    print(f"\nwith jaw-opening gate (djaw>=+1): {ev['fires'].sum()} events, "
          f"eps {sorted(ev.loc[ev['fires'], 'ep'].unique())}")
    print("\nep23 / ep30 extremes per finger (biggest 1s |dcop| anywhere in grasp):")
    print(ex[ex["ep"].isin([23, 30])].round(2).to_string(index=False))
    ev.to_csv(ROOT / "analysis/raw-event-knn/slide_census2.csv", index=False)


if __name__ == "__main__":
    sys.exit(main())
