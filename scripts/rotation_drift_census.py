# Rotation-v2 census (Zheng's ep48 direction finding, 2026-09-02): does
# SUSTAINED SHEAR-ANGLE DRIFT separate object rotation from ordinary
# handling, where torque amplitude could not (ep48 spike 15 N*mm vs 30-48
# in no-rotation episodes)?
#
# Signal: per finger, the direction of net shear atan2(sum fy, sum fx),
# unwrapped, median-smoothed, measured over sliding 1.2 s windows that are
# fully loaded (grip > 2 N) with real shear (|shear| > 0.5 N) throughout.
# Drift = net angle change over the window; "sustained" = |net| / total
# variation >= 0.6 (steady turning, not jitter).
#
# Calibration truths (video): ep48 f1 ~10.2-12.0 s rotating escape;
# ep56 f1 ~5.2-6.2 s one-finger CCW push; ep50 f1 @10.46 supported
# rotation onto the bowl bottom (Zheng, 2026-09-02).
#
# ROUND 2 (arm gate): round 1 ranked arm-motion windows on top — ep57/
# ep26 video-STILL but the ARM was swinging the gripper, which rotates
# the load direction through the pad frame 1:1 with reorientation. Every
# false top had >9 deg of joint motion inside the window; the one real
# rotation (ep50) had <=4. Gate: total |joint delta| over the window
# < ARM_QUIET_DEG and |jaw delta| < JAW_QUIET_U — drift with a quiet arm
# is object-relative.

import glob
import json
import sys

import numpy as np
import pyarrow.parquet as pq

sys.path.insert(0, r"E:\tactile-sensing-datasets-annotations\scripts")
from raw_event_knn import SENS  # noqa: E402
from slip_trajectory_ep23 import load_taxels  # noqa: E402

WIN_S = 1.2
GRIP_MIN = 2.0
SHEAR_MIN = 0.5
SUSTAIN = 0.6
ARM_QUIET_DEG = 6.0
JAW_QUIET_U = 3.0

DATA = r"E:\tactile-sensing-datasets-annotations\data\sotac"
_info = json.load(open(DATA + r"\meta\info.json", encoding="utf-8"))
_names = _info["features"]["observation.state"]["names"]
_jaw_idx = next(i for i, nm in enumerate(_names) if "gripper" in nm)
_state_cache = {}


def state_series(ep):
    if not _state_cache:
        for f in sorted(glob.glob(DATA + r"\data\chunk-*\file-*.parquet")):
            tb = pq.read_table(
                f, columns=["timestamp", "observation.state", "episode_index"])
            eps = np.array(tb["episode_index"].to_pylist(), int)
            tt = np.array(tb["timestamp"].to_pylist(), float)
            st = np.array(tb["observation.state"].to_pylist(), float)
            for e in np.unique(eps):
                m = eps == e
                _state_cache[int(e)] = (tt[m], st[m])
    return _state_cache.get(ep)


def arm_jaw_quiet(ep, a, b):
    s = state_series(ep)
    if s is None:
        return False, np.inf, np.inf
    tt, st = s
    m = (tt >= a) & (tt <= b)
    if m.sum() < 3:
        return False, np.inf, np.inf
    seg = st[m]
    # per-joint EXCURSION of the median-smoothed trace (max - min), summed:
    # a cumulative |diff| gate drowns in servo readout jitter (~0.1 deg per
    # sample x 36 samples x 5 joints) and rejected even ep50's verified
    # rotation window, whose joints are net-still.
    arm = 0.0
    for j in range(seg.shape[1]):
        if j == _jaw_idx:
            continue
        tr = seg[:, j]
        if len(tr) >= 5:
            sm = np.array([np.median(tr[max(0, k - 2) : k + 3])
                           for k in range(len(tr))])
        else:
            sm = tr
        arm += float(sm.max() - sm.min())
    jaw = float(np.abs(seg[-1, _jaw_idx] - seg[0, _jaw_idx]))
    return (arm < ARM_QUIET_DEG and jaw < JAW_QUIET_U), arm, jaw


def med5(x):
    out = x.copy()
    for i in range(2, len(x) - 2):
        out[i] = np.median(x[i - 2 : i + 3])
    return out


rows = []
for ep in range(63):
    for fi, fname in ((0, "sensor_1.csv"), (1, "sensor_2.csv")):
        try:
            t, fx, fy, fz = load_taxels(ep, fname)
        except FileNotFoundError:
            continue
        normal = fz.sum(axis=1)
        sx, sy = fx.sum(axis=1), fy.sum(axis=1)
        shear = np.hypot(sx, sy)
        ok = (normal > GRIP_MIN) & (shear > SHEAR_MIN)
        if ok.sum() < 30:
            continue
        ang = np.unwrap(np.arctan2(sy, sx))
        ang = med5(ang)
        dt = np.median(np.diff(t))
        w = max(3, int(round(WIN_S / dt)))
        best = None
        i = 0
        n = len(t)
        while i + w < n:
            if not ok[i : i + w + 1].all():
                i += 1
                continue
            seg = ang[i : i + w + 1]
            net = seg[-1] - seg[0]
            tv = np.abs(np.diff(seg)).sum()
            sus = abs(net) / max(tv, 1e-9)
            rate = np.degrees(abs(net)) / (t[i + w] - t[i])
            if sus >= SUSTAIN and (best is None or rate > best[0]):
                quiet, armv, jawv = arm_jaw_quiet(ep, t[i], t[i + w])
                if quiet:
                    best = (rate, t[i], np.degrees(net), sus,
                            float(np.median(normal[i : i + w])))
            i += 2
        if best:
            rows.append((ep, fi, *best))

rows.sort(key=lambda r: -r[2 + 0])
print("top 20 sustained shear-angle drifts (deg/s over %.1fs windows, sustain>=%.1f):" % (WIN_S, SUSTAIN))
print("%4s %3s %8s %8s %8s %8s %7s" % ("ep", "fg", "rate", "t", "net_deg", "sustain", "grip"))
for ep, fi, rate, t0, net, sus, grip in rows[:20]:
    tag = ""
    if (ep, fi) == (48, 1) and 9.5 <= t0 <= 12.0:
        tag = "  <-- ep48 ROTATION (video)"
    if (ep, fi) == (56, 1) and 4.8 <= t0 <= 6.5:
        tag = "  <-- ep56 CCW PUSH (video)"
    print("%4d %3d %8.1f %8.2f %8.1f %8.2f %6.1fN%s" % (ep, fi, rate, t0, net, sus, grip, tag))

rates = np.array([r[2] for r in rows])
print("\ncorpus: n=%d finger-max drifts  median %.1f  p90 %.1f  p95 %.1f  max %.1f deg/s"
      % (len(rates), *np.percentile(rates, [50, 90, 95]), rates.max()))

print("\ncalibration truths, wherever they rank:")
for ep, fi, rate, t0, net, sus, grip in rows:
    if (ep, fi) in ((48, 1), (56, 1)):
        rank = 1 + sum(1 for r in rows if r[2] > rate)
        print("  ep%d f%d: %.1f deg/s @%.2fs (net %.0f deg, grip %.1fN) — rank %d/%d"
              % (ep, fi, rate, t0, net, grip, rank, len(rows)))
print("\ntargeted truth windows (max ARM-QUIET sustained drift inside each):")
for label, ep, fi, fname, a, b in (
    ("ep50 supported rotation", 50, 1, "sensor_2.csv", 10.2, 11.9),
    ("ep48 rotating escape", 48, 1, "sensor_2.csv", 10.2, 12.0),
    ("ep56 CCW push", 56, 1, "sensor_2.csv", 5.0, 6.5),
):
    t, fx, fy, fz = load_taxels(ep, fname)
    normal = fz.sum(axis=1)
    sx, sy = fx.sum(axis=1), fy.sum(axis=1)
    shear = np.hypot(sx, sy)
    ok = (normal > GRIP_MIN) & (shear > SHEAR_MIN)
    ang = med5(np.unwrap(np.arctan2(sy, sx)))
    dt = np.median(np.diff(t))
    w = max(3, int(round(WIN_S / dt)))
    best = None
    i = int(np.searchsorted(t, a))
    while i + w < len(t) and t[i] <= b - WIN_S:
        if ok[i : i + w + 1].all():
            seg = ang[i : i + w + 1]
            net = seg[-1] - seg[0]
            sus = abs(net) / max(np.abs(np.diff(seg)).sum(), 1e-9)
            rate = np.degrees(abs(net)) / (t[i + w] - t[i])
            quiet, armv, jawv = arm_jaw_quiet(ep, t[i], t[i + w])
            if sus >= SUSTAIN and quiet and (best is None or rate > best[0]):
                best = (rate, t[i])
        i += 1
    print("  %-24s %s" % (label, ("%.1f deg/s @%.2fs" % best) if best else "no quiet sustained window"))
