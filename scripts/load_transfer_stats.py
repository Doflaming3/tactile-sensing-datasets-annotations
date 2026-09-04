"""Load-retention statistics (cycle 4 follow-up, Zheng: "one finger empty is a
special case, find the general rule").

Hypothesis: an in-grip slide is object motion while the hand KEEPS its load;
a placement is object motion while the hand's load is being TAKEN AWAY (the
jaw opens to set the object down). Measured tactile-only as the hand's total
normal force (both fingers) at the end of a 1-s window divided by its value
at the start ("retention"): ~1 = load kept, ~0 = load gone.

Populations from the detector dump (run-detector --json per episode):
  - in-grip slips: every `slip` event inside the grasp bout with no
    terminal (place/release/drop/unload) within 1 s after it;
  - placements: every `place` event that precedes that finger's release
    (window from 0.2 s before the place);
  - the four sustained-slide windows (same window as the study, section 5).
Usage: python scripts/load_transfer_stats.py <dump-dir>
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
DUMPS = Path(sys.argv[1])
ATOM_RE = re.compile(r"^\[auto:(\w+)\] (\w+) f(\d)(?: ([\d.]+)s)?(.*)$")
_cache: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}


def fn_series(ep: int, finger: int) -> tuple[np.ndarray, np.ndarray]:
    key = (ep, finger)
    if key in _cache:
        return _cache[key]
    p = ROOT / "data/sotac/sensors/paxini_fingertip" / f"episode_{ep:06d}" / f"sensor_{finger + 1}.csv"
    df = pd.read_csv(p)
    t = (df["timestamp_ns"].to_numpy(float) - df["timestamp_ns"].iloc[0]) / 1e9
    fz = np.stack([df[f"p_{k:02d}_fz"].to_numpy(float) for k in range(52)], axis=1)
    fn = np.where(fz > 0, fz, 0).sum(axis=1)
    _cache[key] = (t, fn)
    return t, fn


def total_force(ep: int) -> tuple[np.ndarray, np.ndarray]:
    t0, f0 = fn_series(ep, 0)
    t1, f1 = fn_series(ep, 1)
    n = min(len(t0), len(t1))
    return t0[:n], f0[:n] + f1[:n]


def retention(ep: int, a: float, b: float) -> float:
    """mean total force over the last 0.2 s of [a,b] / mean over its first 0.2 s."""
    t, F = total_force(ep)
    w0 = (t >= a) & (t <= a + 0.2)
    w1 = (t >= b - 0.2) & (t <= b)
    if w0.sum() < 3 or w1.sum() < 3:
        return np.nan
    s0 = F[w0].mean()
    return F[w1].mean() / s0 if s0 > 1.0 else np.nan


def events(ep: int):
    j = json.load(open(DUMPS / f"ep_{ep}.json", encoding="utf-8"))
    out = []
    subs = {}
    for a in j["atoms"]:
        if a.get("style") == "subtask":
            subs[a["content"]] = float(a["timestamp"])
        if a.get("style") != "interjection":
            continue
        m = ATOM_RE.match(a["content"])
        if not m:
            continue
        conf, label, fi, dur, rest = m.groups()
        out.append(dict(t=float(a["timestamp"]), label=label, finger=int(fi), conf=conf))
    return out, subs, j["flags"]


TERMINALS = {"place", "release", "drop", "finger_unload", "sensor_residual", "phantom"}
slips, places = [], []
for ep in range(63):
    if not (DUMPS / f"ep_{ep}.json").exists():
        continue
    ev, subs, flags = events(ep)
    g = subs.get("grasp")
    pr = subs.get("place_release")
    if g is None or pr is None:
        continue
    for e in ev:
        if e["label"] == "slip" and g <= e["t"] <= pr:
            near_term = any(x["label"] in TERMINALS and 0 <= x["t"] - e["t"] <= 1.0 for x in ev)
            if near_term:
                continue
            r = retention(ep, e["t"] - 0.5, e["t"] + 0.5)
            if np.isfinite(r):
                slips.append((ep, e["t"], r))
        if e["label"] == "place":
            rel = [x for x in ev if x["finger"] == e["finger"] and x["label"] == "release" and 0 <= x["t"] - e["t"] <= 2.0]
            if not rel:
                continue
            r = retention(ep, e["t"] - 0.2, e["t"] + 0.8)
            if np.isfinite(r):
                places.append((ep, e["t"], r))

S = np.array([r for _, _, r in slips])
P = np.array([r for _, _, r in places])
print(f"in-grip slips (no terminal within 1 s): n={len(S)}  retention median {np.median(S):.2f}  IQR [{np.percentile(S,25):.2f}, {np.percentile(S,75):.2f}]  p5 {np.percentile(S,5):.2f}  min {S.min():.2f}")
print(f"placements (place -> release):          n={len(P)}  retention median {np.median(P):.2f}  IQR [{np.percentile(P,25):.2f}, {np.percentile(P,75):.2f}]  p95 {np.percentile(P,95):.2f}  max {P.max():.2f}")
for thr in (0.4, 0.5, 0.6):
    print(f"  threshold {thr:.1f}: slips below (would be vetoed as placing) {np.mean(S < thr)*100:.1f}%  | placements above (would escape the veto) {np.mean(P >= thr)*100:.1f}%")
from scipy.stats import mannwhitneyu
u = mannwhitneyu(S, P)
print(f"Mann-Whitney U p = {u.pvalue:.2g}, AUC(slip > placement) = {u.statistic/(len(S)*len(P)):.3f}")
print("\nthe four sustained slides (window: 0.5 s before the flag to 1.0 s after):")
for ep, t, note in [(23, 10.2, "loosening, kept"), (48, 11.1, "ESCAPE, vetoed"), (50, 10.9, "settling onto bowl, vetoed"), (53, 9.7, "placing, vetoed")]:
    print(f"  ep{ep} @{t}  retention {retention(ep, t - 0.5, t + 1.0):.2f}   {note}")
print("\nlowest-retention in-grip slips (the ones a threshold would misjudge first):")
for ep, t, r in sorted(slips, key=lambda x: x[2])[:6]:
    print(f"  ep{ep} @{t:.2f}  retention {r:.2f}")
print("highest-retention placements:")
for ep, t, r in sorted(places, key=lambda x: -x[2])[:6]:
    print(f"  ep{ep} @{t:.2f}  retention {r:.2f}")
