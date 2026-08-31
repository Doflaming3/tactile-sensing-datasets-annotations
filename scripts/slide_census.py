# Corpus census for the sustained-slide rule (Zheng's ep23 verdict: gradual
# gravity slide under jaw loosening = valuable; ep30's grasp-time re-seat +
# mm creep = normal, ignore).
#
# For every episode/finger: CoP-Y drift during the CARRY window
# [transport anchor, place_release anchor] (published anchors; episode end if
# no place_release). Only loaded frames (sum fz > 0.5 N) count. Metrics:
#   net_mm   median CoP-Y of last 0.5 s minus first 0.5 s of the window
#   rho      Spearman(CoP-Y, t) over the window - monotonicity
#   grip_d   grip change over the same window (N)
#   n_slips  published slip marks inside the window on that finger
# Purpose: pick the net_mm threshold that fires on ep23 and not on ep30-class
# creep, and list which other episodes fire (video-check queue).

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from raw_event_knn import ANN, SENS
from slip_trajectory_ep23 import load_taxels, taxel_layout_y

EV_RE = re.compile(r"^\[auto:(\w+)\]\s+(\w+)(?:\s+(f\d))?")


def main():
    ty = taxel_layout_y()
    rows = []
    for ep in range(63):
        ann_path = ANN / f"episode_{ep:06d}.json"
        if not ann_path.exists() or not (SENS / f"episode_{ep:06d}").exists():
            continue
        anchors, slips = {}, {"f0": [], "f1": []}
        for a in json.load(open(ann_path, encoding="utf-8"))["atoms"]:
            if a.get("style") == "subtask":
                anchors[a["content"]] = a["timestamp"]
            elif a.get("style") == "interjection":
                m = EV_RE.match(a["content"])
                if m and m.group(2) == "slip" and m.group(3):
                    slips[m.group(3)].append(a["timestamp"])
        t_a = anchors.get("transport")
        if t_a is None:
            continue
        for fg, fname in (("f0", "sensor_1.csv"), ("f1", "sensor_2.csv")):
            t, fx, fy, fz = load_taxels(ep, fname)
            t_b = anchors.get("place_release", t[-1])
            w = (t >= t_a) & (t <= t_b)
            if w.sum() < 30:
                continue
            normal = fz[w].sum(axis=1)
            loaded = normal > 0.5
            if loaded.sum() < 30:
                continue
            tw = t[w][loaded]
            cop = (fz[w][loaded] * ty).sum(axis=1) / fz[w][loaded].sum(axis=1)
            grip = normal[loaded]
            head = tw <= tw[0] + 0.5
            tail = tw >= tw[-1] - 0.5
            net = np.median(cop[tail]) - np.median(cop[head])
            rho = spearmanr(tw, cop)[0] if len(tw) > 10 else np.nan
            grip_d = np.median(grip[tail]) - np.median(grip[head])
            ns = sum(t_a <= s <= t_b for s in slips[fg])
            rows.append({"ep": ep, "fg": fg, "net_mm": net, "rho": rho,
                         "grip_d": grip_d, "dur_s": tw[-1] - tw[0], "n_slips": ns})
    d = pd.DataFrame(rows)
    d["abs_mm"] = d["net_mm"].abs()
    d = d.sort_values("abs_mm", ascending=False)
    print(f"finger-windows measured: {len(d)}")
    print("\ntop 20 by |net CoP drift| during carry:")
    print(d.head(20).round(2).to_string(index=False))
    print("\nep23 / ep30 rows:")
    print(d[d['ep'].isin([23, 30])].round(2).to_string(index=False))
    print("\ndistribution of |net_mm|:")
    print(d["abs_mm"].describe(percentiles=[0.5, 0.75, 0.9, 0.95]).round(2).to_string())
    for th in (2.0, 2.5, 3.0, 4.0):
        firing = d[(d["abs_mm"] >= th) & (d["rho"].abs() >= 0.6)]
        print(f"\nthreshold |net|>={th}mm & |rho|>=0.6: {len(firing)} finger-windows, "
              f"eps {sorted(firing['ep'].unique())}")
    d.to_csv(Path(__file__).resolve().parents[1] / "analysis/raw-event-knn/slide_census.csv",
             index=False)


if __name__ == "__main__":
    sys.exit(main())
