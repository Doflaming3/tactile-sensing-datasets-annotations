# Step 1 of Zheng's plan (2026-08-31): treat the device as a REGULAR-rate
# emitter (candidate 83.33 Hz = 12 ms) polled by the ~91 Hz logger. Then a
# duplicate row is a beat re-read: it occurs exactly when two consecutive
# 11.005 ms polls land in the same 12 ms device slot. That predicts, for
# device period T and phase phi, precisely WHICH rows are duplicates.
#
# Discovery = fit (T, phi) per file against observed duplicates in DYNAMIC
# stretches (quiet stretches are value-identical either way and carry no
# information). Score: match rate between predicted re-read positions and
# observed exact duplicates. A sharp peak at T=12.0 validates the model;
# a flat/low score says the device is not a regular-rate emitter.

import glob
import json

import numpy as np
import pandas as pd

BASE = r"E:\tactile-sensing-datasets-annotations\data\sotac\sensors\paxini_fingertip"

T_CAND = np.arange(10.9, 12.81, 0.02)  # ms
PHI_N = 24

best_rows = []
score_at_12 = []
curve_acc = np.zeros(len(T_CAND))
curve_n = 0

files = sorted(glob.glob(BASE + r"\episode_*\sensor_*.csv"))
for f in files:
    df = pd.read_csv(f, usecols=lambda c: c == "calibrated_timestamp_ns" or c.startswith("p_"))
    ts = df["calibrated_timestamp_ns"].to_numpy(np.int64)
    F = df[[c for c in df.columns if c.startswith("p_")]].to_numpy()
    normal = df[[c for c in df.columns if c.endswith("_fz")]].to_numpy().sum(axis=1)
    dup = np.all(F[1:] == F[:-1], axis=1)
    ch = np.abs(normal[2:] - normal[:-2]) > 1.0
    dyn = np.zeros(len(dup), bool)
    dyn[1:] = ch[: len(dup) - 1]
    if dyn.sum() < 80:
        continue
    t_ms = (ts - ts[0]) / 1e6
    tpair = t_ms[1:]  # time of the second row of each pair
    tprev = t_ms[:-1]
    obs = dup[dyn]
    n_dyn = int(dyn.sum())

    scores = np.zeros(len(T_CAND))
    for k, T in enumerate(T_CAND):
        best = 0.0
        for phi in np.linspace(0, T, PHI_N, endpoint=False):
            same_slot = np.floor((tpair - phi) / T) == np.floor((tprev - phi) / T)
            pred = same_slot[dyn]
            # balanced accuracy so the ~92% negatives can't dominate
            tp = (pred & obs).sum() / max(obs.sum(), 1)
            tn = (~pred & ~obs).sum() / max((~obs).sum(), 1)
            best = max(best, (tp + tn) / 2)
        scores[k] = best
    curve_acc += scores
    curve_n += 1
    kbest = int(np.argmax(scores))
    best_rows.append({
        "file": f.split("paxini_fingertip\\")[-1],
        "n_dyn": n_dyn,
        "T_best_ms": T_CAND[kbest],
        "score_best": scores[kbest],
        "score_at_12": scores[int(np.argmin(np.abs(T_CAND - 12.0)))],
    })

d = pd.DataFrame(best_rows)
print("files fitted: %d (need >=80 dynamic pairs)" % len(d))
print("\nbest-fit device period per file:")
print("  T_best median %.2f ms  p10 %.2f  p90 %.2f" % tuple(
    np.percentile(d["T_best_ms"], [50, 10, 90])))
print("  balanced-accuracy at best T: median %.2f  (1.0 = perfect beat model, 0.5 = chance)")
print("  -> %.3f" % d["score_best"].median())
print("  balanced-accuracy at T=12.00 ms (83.33 Hz): median %.3f" % d["score_at_12"].median())

curve = curve_acc / max(curve_n, 1)
print("\ncorpus-mean score curve (T ms -> balanced acc):")
for k in range(0, len(T_CAND), 5):
    bar = "#" * int(40 * (curve[k] - 0.5) / 0.5) if curve[k] > 0.5 else ""
    print("  %.2f  %.3f %s" % (T_CAND[k], curve[k], bar))
kpk = int(np.argmax(curve))
print("\ncorpus peak: T=%.2f ms (%.2f Hz), balanced acc %.3f"
      % (T_CAND[kpk], 1000 / T_CAND[kpk], curve[kpk]))
