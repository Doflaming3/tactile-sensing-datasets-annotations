# Census for Zheng's 2026-08-31 interjection-verdict round. Three rules to
# calibrate before touching the detector:
#
# A) ep39 short-transport (his ask: "amazingly short transport" on a
#    wrong-location failure -> pop a review marker): corpus transport
#    durations, where does ep39 sit, threshold candidates.
# B) ep54 combine function (his ask: two failed_attempt spans were ONE
#    cup-nudge chain): discriminator candidate = jaw REOPEN between spans
#    (his own ruling: attempt requires a grab-and-miss cycle; no reopen
#    between spans = still the same grab). Measure inter-span jaw for
#    ep54 (must merge) vs ep31 and ep45 (must NOT merge - video-verified
#    as distinct attempts).
# C) ep35 @6.38 false drop (ball dangling, slid, never dropped): candidate
#    rule = drop while the PARTNER finger still holds. Census all drops:
#    partner min force over [drop, drop+1.5s].

import json
import re
import sys

import numpy as np

sys.path.insert(0, r"E:\tactile-sensing-datasets-annotations\scripts")
from raw_event_knn import SENS  # noqa: E402
from slide_census2 import jaw_series, load_all_jaws  # noqa: E402
from slip_trajectory_ep23 import load_taxels  # noqa: E402

DUMPS = r"C:\Users\RYANXU~1\AppData\Local\Temp\claude\E--tactile-sensing-datasets-annotations\c765c7e6-1380-406b-ab81-025d40c24a2f\scratchpad\our-atoms-4"
EV_RE = re.compile(r"^\[auto:(\w+)\]\s+(\w+)(?:\s+(f\d))?")

load_all_jaws(5)


def dump(ep):
    return json.load(open(DUMPS + r"\ep_%d.json" % ep, encoding="utf-8"))


# ---------------- A: transport durations ----------------
print("A) transport durations (transport -> place_release anchor):")
durs = {}
for ep in range(63):
    d = dump(ep)
    anchors = {}
    for a in d["atoms"]:
        if a.get("style") == "subtask" and a["content"] not in anchors:
            anchors[a["content"]] = a["timestamp"]
    if "transport" in anchors and "place_release" in anchors:
        durs[ep] = anchors["place_release"] - anchors["transport"]
vals = np.array(list(durs.values()))
print("   n=%d  p5=%.2f p10=%.2f p25=%.2f median=%.2f" % (
    len(vals), *np.percentile(vals, [5, 10, 25, 50])))
short = sorted(durs.items(), key=lambda kv: kv[1])[:8]
print("   shortest 8:", ", ".join("ep%d %.2fs" % kv for kv in short))
print("   ep39 = %.2fs" % durs.get(39, float("nan")))

# ---------------- B: inter-span jaw reopen ----------------
print("\nB) jaw reopen between adjacent failed_attempt spans:")
for ep in (54, 31, 45):
    d = dump(ep)
    spans = []
    for f in d["flags"]:
        m = re.match(r"^failed_attempt@([\d.]+)-([\d.]+)s$", f)
        if m:
            spans.append((float(m.group(1)), float(m.group(2))))
    jt, jp = jaw_series(ep, 5)
    for k in range(len(spans) - 1):
        a_end, b_start = spans[k][1], spans[k + 1][0]
        m2 = (jt >= a_end) & (jt <= b_start)
        if m2.sum() < 2:
            print("   ep%d gap %.1f-%.1fs: too few jaw samples" % (ep, a_end, b_start))
            continue
        seg = jp[m2]
        # max rise from a running minimum = the reopen amplitude
        run_min = np.minimum.accumulate(seg)
        reopen = float((seg - run_min).max())
        print("   ep%d gap %.2f-%.2fs (%.1fs): max reopen %.1f units" % (
            ep, a_end, b_start, b_start - a_end, reopen))

# ---------------- C: partner force at drops ----------------
print("\nC) drops: partner-finger min force over [drop, drop+1.5s]:")
rows = []
for ep in range(63):
    d = dump(ep)
    drops = []
    for a in d["atoms"]:
        if a.get("style") != "interjection":
            continue
        m = EV_RE.match(a["content"])
        if m and m.group(2) == "drop" and m.group(3):
            drops.append((a["timestamp"], int(m.group(3)[1])))
    if not drops:
        continue
    streams = {}
    for t_ev, fg in drops:
        partner = 1 - fg
        if partner not in streams:
            fname = "sensor_1.csv" if partner == 0 else "sensor_2.csv"
            t, fx, fy, fz = load_taxels(ep, fname)
            streams[partner] = (t, fz.sum(axis=1))
        t, normal = streams[partner]
        w = (t >= t_ev) & (t <= t_ev + 1.5)
        pmin = float(normal[w].min()) if w.sum() else float("nan")
        rows.append((ep, t_ev, fg, pmin))
held = [r for r in rows if r[3] >= 1.0]
print("   drops total: %d; partner held >=1.0N throughout: %d" % (len(rows), len(held)))
for ep, t_ev, fg, pmin in held:
    print("   ep%2d @%6.2f f%d  partner min %.2fN" % (ep, t_ev, fg, pmin))

# ---------------- ep51 @6.6: slip/CoP evidence ----------------
print("\nep51 @6.6 (over-squeeze behind cup): slip & CoP evidence:")
d = dump(51)
for a in d["atoms"]:
    if a.get("style") == "interjection" and 5.6 <= a["timestamp"] <= 7.6:
        print("   atom @%.3f  %s" % (a["timestamp"], a["content"]))
from slip_trajectory_ep23 import cop_y, taxel_layout_y  # noqa: E402

ty = taxel_layout_y()
for fg, fname in (("f0", "sensor_1.csv"), ("f1", "sensor_2.csv")):
    t, fx, fy, fz = load_taxels(51, fname)
    normal = fz.sum(axis=1)
    copn = cop_y(fz, ty, valid_mask=normal > 1.0)
    for tc in (6.0, 6.3, 6.6, 6.9, 7.2):
        m2 = (t >= tc - 0.15) & (t <= tc + 0.15)
        v = copn[m2]
        cop = np.nanmedian(v) if np.isfinite(v).sum() >= 3 else float("nan")
        print("   %s %.1fs grip %5.1fN cop %6.2fmm" % (fg, tc, np.median(normal[m2]), cop))
