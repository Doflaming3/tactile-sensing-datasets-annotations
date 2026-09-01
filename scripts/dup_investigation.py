# CP1-CP4 of analysis/duplicate-investigation.md — duplicate structure,
# near-duplicates, corrected time axis, artifact re-measurement.
# CP5 (label impact) runs in TypeScript via run-detector --dedup.

import glob
import json
import re
import sys

import numpy as np
import pandas as pd

BASE = r"E:\tactile-sensing-datasets-annotations\data\sotac\sensors\paxini_fingertip"
DUMPS = sys.argv[1] if len(sys.argv) > 1 else None
EV_RE = re.compile(r"^\[auto:(\w+)\]\s+(\w+)(?:\s+(f\d))?")
LSB = 0.1  # N per count
STAGES = ["approach", "grasp", "transport", "place_release"]


def load_finger(ep, fname):
    path = rf"{BASE}\episode_{ep:06d}\{fname}"
    df = pd.read_csv(path)
    t0 = json.load(open(rf"{BASE}\episode_{ep:06d}\alignment.json"))[
        "episode_start_timestamp_ns"]
    t = (df["calibrated_timestamp_ns"].to_numpy(np.int64) - t0) / 1e9
    F = df[[c for c in df.columns if c.startswith("p_")]].to_numpy()
    normal = df[[c for c in df.columns
                 if c.startswith("p_") and c.endswith("_fz")]].to_numpy().sum(axis=1)
    d = np.abs(F[1:] - F[:-1])
    maxd = d.max(axis=1)
    nch = (d > 1e-9).sum(axis=1)
    exact = maxd <= 1e-9
    lsb = (~exact) & (maxd <= LSB + 1e-9) & (nch <= 8)
    return t, F, normal, exact, lsb


def anchors_events(ep):
    d = json.load(open(DUMPS + rf"\ep_{ep}.json", encoding="utf-8"))
    anch, evs = {}, {0: [], 1: []}
    for a in d["atoms"]:
        if a.get("style") == "subtask" and a["content"] not in anch:
            anch[a["content"]] = a["timestamp"]
        elif a.get("style") == "interjection":
            m = EV_RE.match(a["content"])
            if m and m.group(3):
                evs[int(m.group(3)[1])].append(a["timestamp"])
    return anch, evs


file_rows = []
phase_frames = {s: [0, 0] for s in STAGES + ["post"]}
win_in, win_out = [0, 0], [0, 0]
joint = []
cls_pool = np.zeros(3, int)  # exact, lsb, real
dyn_dts_exact, dyn_dts_lsb = [], []
rate_by_load = {"none": [0, 0], "one": [0, 0], "both": [0, 0]}
base_diffs = []
vintage = []

for ep in range(63):
    try:
        t0f, F0, n0, ex0, lsb0 = load_finger(ep, "sensor_1.csv")
        t1f, F1, n1, ex1, lsb1 = load_finger(ep, "sensor_2.csv")
    except FileNotFoundError:
        continue
    n = min(len(t0f), len(t1f))
    t = t0f[:n]
    anch, evs = anchors_events(ep) if DUMPS else ({}, {0: [], 1: []})
    start_ns = json.load(open(rf"{BASE}\episode_{ep:06d}\alignment.json"))[
        "episode_start_timestamp_ns"]
    vintage.append((ep, start_ns))

    for fi, (ex, lsbm, normal) in enumerate(((ex0, lsb0, n0), (ex1, lsb1, n1))):
        ex = ex[: n - 1]
        lsbm = lsbm[: n - 1]
        normal = normal[:n]
        real = ~(ex | lsbm)
        cls_pool += [int(ex.sum()), int(lsbm.sum()), int(real.sum())]
        # CP1a per-file
        runs, cur, mx = [], 0, 0
        for x in ex:
            cur = cur + 1 if x else 0
            mx = max(mx, cur)
        file_rows.append({"ep": ep, "f": fi, "dup": ex.mean(), "maxrun": mx})
        # CP1b phases
        if anch:
            bounds = [anch.get(s) for s in STAGES] + [t[-1]]
            for k, s in enumerate(STAGES):
                a, b = bounds[k], bounds[k + 1]
                if a is None or b is None:
                    continue
                m = (t[1:] >= a) & (t[1:] < b)
                phase_frames[s][0] += int(m.sum())
                phase_frames[s][1] += int(ex[m[: len(ex)]].sum())
        # CP1c event windows
        if evs[fi]:
            ev = np.array(evs[fi])
            near = np.min(np.abs(t[1:, None] - ev[None, :]), axis=1) <= 0.35
            near = near[: len(ex)]
            win_in[0] += int(near.sum())
            win_in[1] += int(ex[near].sum())
            win_out[0] += int((~near).sum())
            win_out[1] += int(ex[~near].sum())
        # CP3a dynamic fresh arrivals
        ch = np.abs(normal[2:] - normal[:-2]) > 1.0
        dyn = np.zeros(len(ex), bool)
        dyn[1:] = ch[: len(ex) - 1]
        fresh_idx = np.flatnonzero((~ex) & dyn)
        if len(fresh_idx) > 3:
            dts = np.diff(t[1:][fresh_idx])
            dyn_dts_exact.extend(dts[dts < 0.2].tolist())
        fresh2 = np.flatnonzero(~(ex | lsbm) & dyn)
        if len(fresh2) > 3:
            dts = np.diff(t[1:][fresh2])
            dyn_dts_lsb.extend(dts[dts < 0.2].tolist())
        # CP4a baselines
        first = t[:n] < t[0] + 1.0
        b_orig = np.median(F0[:n][first] if fi == 0 else F1[:n][first], axis=0)
        keep = np.ones(n, bool)
        keep[1:] = ~ex
        Fk = (F0[:n] if fi == 0 else F1[:n])[keep & first]
        if len(Fk) >= 5:
            b_dedup = np.median(Fk, axis=0)
            base_diffs.append(np.abs(b_dedup - b_orig).max())

    # CP1d joint duplicates
    e0, e1 = ex0[: n - 1], ex1[: n - 1]
    p0, p1, pj = e0.mean(), e1.mean(), (e0 & e1).mean()
    if 0 < p0 < 1 and 0 < p1 < 1:
        phi = (pj - p0 * p1) / np.sqrt(p0 * (1 - p0) * p1 * (1 - p1))
        joint.append(phi)
    # CP3b rate by load condition (fresh = either finger changed)
    fresh_any = ~(e0 & e1)
    l0, l1 = n0[1:n] > 2.0, n1[1:n] > 2.0
    for cond, m in (("none", ~l0 & ~l1), ("one", l0 ^ l1), ("both", l0 & l1)):
        rate_by_load[cond][0] += int(m.sum())
        rate_by_load[cond][1] += int(fresh_any[m].sum())

print("=== CP1a: corpus duplicate stats (exact, per finger-file) ===")
fr = pd.DataFrame(file_rows)
print("files %d  dup%% mean %.1f  median %.1f  min %.1f  max %.1f  maxrun median %d  worst %d"
      % (len(fr), 100 * fr["dup"].mean(), 100 * fr["dup"].median(),
         100 * fr["dup"].min(), 100 * fr["dup"].max(),
         fr["maxrun"].median(), fr["maxrun"].max()))
vintage.sort(key=lambda kv: kv[1])
cut = [ep for ep, ns in vintage if ns < 1787000000000000000]  # ~before 08-26
early = fr[fr["ep"].isin(cut)]["dup"]
late = fr[~fr["ep"].isin(cut)]["dup"]
print("vintage split: early n=%d dup %.1f%%  late n=%d dup %.1f%%"
      % (len(early), 100 * early.mean() if len(early) else -1,
         len(late), 100 * late.mean()))

print("\n=== CP1b: duplicate rate by phase ===")
for s in STAGES:
    tot, dup = phase_frames[s]
    if tot:
        print("  %-13s %7d frames  %.1f%%" % (s, tot, 100 * dup / tot))

print("\n=== CP1c: event windows (±0.35s) vs elsewhere ===")
print("  in-window : %d frames, %.1f%% dup" % (win_in[0], 100 * win_in[1] / max(win_in[0], 1)))
print("  elsewhere : %d frames, %.1f%% dup" % (win_out[0], 100 * win_out[1] / max(win_out[0], 1)))

print("\n=== CP1d: finger synchronization of duplicates (phi) ===")
print("  phi median %.2f  p10 %.2f  p90 %.2f  (0 = independent, 1 = board-synced)"
      % tuple(np.percentile(joint, [50, 10, 90])))

print("\n=== CP2: consecutive-pair classes (pooled) ===")
tot = cls_pool.sum()
print("  exact %.1f%%   LSB-flicker(<=0.1N, <=8 axes) %.1f%%   real change %.1f%%"
      % tuple(100 * cls_pool / tot))

print("\n=== CP2a: phantom vs real holds, fresh = REAL-CHANGE only ===")
CASES = [
    ("PHANTOM ep47 f0 standing", 47, "sensor_1.csv", 2.0, 10.0),
    ("PHANTOM ep25 f1 post-task", 25, "sensor_2.csv", 14.2, 16.5),
    ("PHANTOM ep43 f0 pre-grasp", 43, "sensor_1.csv", 0.5, 3.0),
    ("REAL hold ep13 f1", 13, "sensor_2.csv", 5.5, 7.0),
    ("REAL hold ep50 f1", 50, "sensor_2.csv", 7.0, 10.0),
    ("REAL hold ep47 f1 clamp", 47, "sensor_2.csv", 8.0, 10.0),
]
for label, ep, fname, a, b in CASES:
    t, F, normal, ex, lsbm = load_finger(ep, fname)
    m = (t[1:] >= a) & (t[1:] <= b)
    real = ~(ex | lsbm)
    dur = b - a
    print("  %-28s stale(exact+LSB) %.1f%%  real-change rate %.1f Hz"
          % (label, 100 * (1 - real[m].mean()), real[m].sum() / dur))

print("\n=== CP3a: fresh-frame inter-arrival during dynamics ===")
for name, dts in (("exact-collapse", dyn_dts_exact), ("LSB-collapse", dyn_dts_lsb)):
    d = np.array(dts) * 1000
    if len(d) < 20:
        continue
    print("  %s: n=%d  median %.1f ms  p25 %.1f  p75 %.1f  (83 Hz => 12.0 ms)"
          % (name, len(d), *np.percentile(d, [50, 25, 75])))
    hist, edges = np.histogram(d, bins=[5, 9, 13, 17, 21, 25, 35, 50, 100])
    print("    bins ms %s -> %s" % (edges.astype(int).tolist(), hist.tolist()))

print("\n=== CP3b: effective fresh rate by load condition ===")
for cond, (tot, fresh) in rate_by_load.items():
    if tot:
        print("  %-5s: %8d frames, fresh-any-finger %.1f%% (x90.88 = %.1f Hz)"
              % (cond, tot, 100 * fresh / tot, 90.88 * fresh / tot))

print("\n=== CP4a: baseline shift under dedup ===")
bd = np.array(base_diffs)
print("  files %d  max|delta baseline| max %.3f N  p95 %.3f  (1 LSB = 0.1)"
      % (len(bd), bd.max(), np.percentile(bd, 95)))

print("\n=== CP4b: blink rate (normal < 0.2N inside span), orig vs dedup axis ===")
BLINK = [
    ("real graze ep16 @2.64", 16, "sensor_2.csv", 2.5, 2.9),
    ("real touch ep21 @4.4", 21, "sensor_2.csv", 4.2, 4.7),
    ("PHANTOM ep47 f0", 47, "sensor_1.csv", 2.0, 10.0),
    ("PHANTOM ep25 f1 tail", 25, "sensor_2.csv", 14.2, 16.5),
]
for label, ep, fname, a, b in BLINK:
    t, F, normal, ex, lsbm = load_finger(ep, fname)
    m = (t >= a) & (t <= b)
    orig = (normal[m] < 0.2).mean()
    keep = np.ones(len(t), bool)
    keep[1:] = ~ex
    md = m & keep
    ded = (normal[md] < 0.2).mean() if md.sum() else float("nan")
    print("  %-24s blink orig %.0f%%  dedup %.0f%%" % (label, 100 * orig, 100 * ded))

print("\n=== CP4c: residual decay durations, orig vs dedup axis ===")
for label, ep, fname, tev in (("ep36 residual @9.61", 36, "sensor_2.csv", 9.61),
                              ("ep41 residual @7.34", 41, "sensor_2.csv", 7.34)):
    t, F, normal, ex, lsbm = load_finger(ep, fname)
    def decay_end(tt, nn):
        m = tt >= tev
        idx = np.flatnonzero(m & (nn < 0.2))
        return tt[idx[0]] - tev if len(idx) else float("nan")
    keep = np.ones(len(t), bool)
    keep[1:] = ~ex
    print("  %-22s orig %.3fs  dedup %.3fs"
          % (label, decay_end(t, normal), decay_end(t[keep], normal[keep])))

print("\n=== CP4d: |dFn/dt| stats, orig (11ms grid) vs dedup arrivals ===")
for ep, fname in ((21, "sensor_2.csv"), (47, "sensor_1.csv"), (13, "sensor_2.csv")):
    t, F, normal, ex, lsbm = load_finger(ep, fname)
    d_o = np.abs(np.diff(normal)) / np.maximum(np.diff(t), 1e-6)
    keep = np.ones(len(t), bool)
    keep[1:] = ~ex
    tn, nn = t[keep], normal[keep]
    d_d = np.abs(np.diff(nn)) / np.maximum(np.diff(tn), 1e-6)
    print("  ep%d %s: p90 orig %.1f N/s dedup %.1f   p99 orig %.1f dedup %.1f"
          % (ep, fname[:8], np.percentile(d_o, 90), np.percentile(d_d, 90),
             np.percentile(d_o, 99), np.percentile(d_d, 99)))
