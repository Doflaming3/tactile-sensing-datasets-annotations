# -*- coding: utf-8 -*-
"""Validator and example writer for the raw tactile sidecar format
`paxini-raw/1` (analysis/raw-sidecar-spec.md).

    python scripts/validate_raw_sidecar.py <episode folder>          # CSVs + meta.json + alignment.json
    python scripts/validate_raw_sidecar.py <sensor_N.csv>            # one file, no meta checks
    python scripts/validate_raw_sidecar.py --legacy <sensor_N.csv>   # report on an existing push-stream file
    python scripts/validate_raw_sidecar.py --example <out folder>    # write a conforming synthetic episode

Standard library only (Python 3.9+). Exit code 1 when a check fails.
"""
from __future__ import annotations

import csv
import json
import math
import os
import random
import re
import statistics
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REGION_BITS = {"resultant": 1, "array": 2, "hall": 4, "temperature": 8, "block10000": 16}
LEAD = ["timestamp_ns", "calibrated_timestamp_ns", "seq", "changed"]


# ------------------------------------------------------------------ header
def region_groups(header: list[str]) -> dict[str, list[int]]:
    """Column indices per region, in header order; raises on incomplete groups."""
    groups: dict[str, list[int]] = {}
    idx = {h: i for i, h in enumerate(header)}
    if all(k in idx for k in ("fx", "fy", "fz")):
        groups["resultant"] = [idx["fx"], idx["fy"], idx["fz"]]
    pts = sorted({int(m.group(1)) for h in header for m in [re.match(r"^p_(\d+)_fx$", h)] if m})
    if pts:
        if pts != list(range(len(pts))):
            raise ValueError("array points are not contiguous from p_00")
        cols = []
        for k in pts:
            for ax in ("fx", "fy", "fz"):
                name = f"p_{k:02d}_{ax}"
                if name not in idx:
                    raise ValueError(f"array group incomplete: missing {name}")
                cols.append(idx[name])
        groups["array"] = cols
    if any(h.startswith("h_") for h in header):
        cols = []
        for k in range(12):
            for ax in ("x", "y", "z"):
                name = f"h_{k:02d}_{ax}"
                if name not in idx:
                    raise ValueError(f"hall group incomplete: missing {name}")
                cols.append(idx[name])
        groups["hall"] = cols
    if any(re.match(r"^t_\d\d$", h) for h in header):
        cols = []
        for k in range(12):
            name = f"t_{k:02d}"
            if name not in idx:
                raise ValueError(f"temperature group incomplete: missing {name}")
            cols.append(idx[name])
        groups["temperature"] = cols
    if any(h.startswith("blk_") for h in header):
        cols = []
        for k in range(27):
            name = f"blk_{k:02d}"
            if name not in idx:
                raise ValueError(f"block10000 group incomplete: missing {name}")
            cols.append(idx[name])
        groups["block10000"] = cols
    return groups


def read_csv(path: str) -> tuple[list[str], list[list[str]]]:
    with open(path, encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.reader(fh))
    rows = [r for r in rows if r]
    if len(rows) < 2:
        raise ValueError("fewer than two lines")
    return rows[0], rows[1:]


def interval_stats(ts: list[int]) -> dict[str, float]:
    d = [(b - a) / 1e6 for a, b in zip(ts, ts[1:])]
    if not d:
        return {}
    d.sort()
    q = lambda p: d[min(len(d) - 1, int(p * len(d)))]
    return {"n": len(d), "median_ms": statistics.median(d), "p5_ms": q(0.05), "p95_ms": q(0.95), "min_ms": d[0], "max_ms": d[-1]}


# ---------------------------------------------------------------- validate
def validate_file(path: str, meta_module: dict | None = None) -> list[str]:
    problems: list[str] = []
    header, rows = read_csv(path)
    for i, name in enumerate(LEAD):
        if i >= len(header) or header[i] != name:
            problems.append(f"column {i} must be {name!r}, found {header[i] if i < len(header) else 'nothing'!r}")
    try:
        groups = region_groups(header)
    except ValueError as e:
        return problems + [str(e)]
    if not groups:
        problems.append("no region group (resultant / array / hall / temperature / block10000)")
    # fixed order of groups
    order = [g for g in ("resultant", "array", "hall", "temperature", "block10000") if g in groups]
    firsts = [groups[g][0] for g in order]
    if firsts != sorted(firsts):
        problems.append("region groups are not in the fixed order resultant, array, hall, temperature, block10000")
    known = set(LEAD)
    for g in groups.values():
        known.update(header[i] for i in g)
    unknown = [h for h in header if h not in known]
    if unknown:
        problems.append(f"unknown columns (allowed, but note them): {unknown[:6]}")

    ts_i, cal_i, seq_i, ch_i = 0, 1, 2, 3
    prev: dict[str, tuple[str, ...]] = {}
    prev_ts = None
    dup_rows = 0
    changed_mismatch = 0
    change_ts: dict[str, list[int]] = {g: [] for g in groups}
    for r, row in enumerate(rows):
        if len(row) != len(header):
            problems.append(f"row {r}: {len(row)} fields, header has {len(header)}")
            break
        ts = int(row[ts_i])
        if row[cal_i] != row[ts_i]:
            problems.append(f"row {r}: calibrated_timestamp_ns != timestamp_ns")
            break
        if int(row[seq_i]) != r:
            problems.append(f"row {r}: seq is {row[seq_i]}, expected {r}")
            break
        if prev_ts is not None and ts <= prev_ts:
            problems.append(f"row {r}: timestamp_ns not increasing")
            break
        prev_ts = ts
        changed = int(row[ch_i])
        computed = 0
        for g, cols in groups.items():
            vals = tuple(row[c] for c in cols)
            if g not in prev or vals != prev[g]:
                computed |= REGION_BITS[g]
                change_ts[g].append(ts)
            prev[g] = vals
        if r > 0 and computed == 0:
            dup_rows += 1
        if r > 0 and changed != computed:
            changed_mismatch += 1
        if r == 0 and changed == 0:
            problems.append("row 0: changed must be non-zero")
    if dup_rows:
        problems.append(f"{dup_rows} rows changed nothing (duplicates of the previous row)")
    if changed_mismatch:
        problems.append(f"{changed_mismatch} rows where `changed` disagrees with the byte comparison")

    print(f"{os.path.basename(path)}: {len(rows)} rows, regions {order}")
    for g in order:
        st = interval_stats(change_ts[g])
        if st:
            print(f"   {g:<12} changes {st['n']+1:>6}  interval ms median {st['median_ms']:.2f}  p5 {st['p5_ms']:.2f}  p95 {st['p95_ms']:.2f}  min {st['min_ms']:.2f}")
    if meta_module is not None:
        mr = set(meta_module.get("regions", []))
        if mr != set(order):
            problems.append(f"meta.json regions {sorted(mr)} != file regions {order}")
        if meta_module.get("units") != "counts":
            problems.append("meta.json units must be 'counts' for this format")
        if "array" in groups and meta_module.get("points") != len(groups["array"]) // 3:
            problems.append("meta.json points != array group size")
        if meta_module.get("rows") not in (None, len(rows)):
            problems.append(f"meta.json rows {meta_module.get('rows')} != {len(rows)}")
        if "hall" in groups and "FW1.0.6" in str(meta_module.get("firmware", "")):
            problems.append("a FW1.0.6 unit cannot carry the hall group (area 0x7C absent)")
    return problems


def validate_folder(folder: str) -> int:
    fails = 0
    meta_path = os.path.join(folder, "meta.json")
    align_path = os.path.join(folder, "alignment.json")
    meta = None
    if os.path.exists(meta_path):
        meta = json.load(open(meta_path, encoding="utf-8"))
        if meta.get("schema") != "paxini-raw-meta/1":
            print("meta.json: schema is not paxini-raw-meta/1"); fails += 1
        if meta.get("clock") != "time.time_ns (epoch)":
            print("meta.json: clock must be 'time.time_ns (epoch)'"); fails += 1
    else:
        print("meta.json: MISSING (legacy stream folders have none; this format requires it)"); fails += 1
    if os.path.exists(align_path):
        al = json.load(open(align_path, encoding="utf-8"))
        if "episode_start_timestamp_ns" not in al:
            print("alignment.json: no episode_start_timestamp_ns"); fails += 1
    else:
        print("alignment.json: MISSING"); fails += 1
    by_file = {m.get("file"): m for m in (meta or {}).get("modules", [])}
    csvs = sorted(f for f in os.listdir(folder) if f.lower().endswith(".csv"))
    if not csvs:
        print("no sensor_*.csv in the folder"); fails += 1
    for f in csvs:
        problems = validate_file(os.path.join(folder, f), by_file.get(f) if meta else None)
        if meta and f not in by_file:
            problems.append("no entry in meta.json modules")
        for p in problems:
            print("   PROBLEM:", p)
        fails += len(problems)
    print("OK" if fails == 0 else f"{fails} problem(s)")
    return 1 if fails else 0


def legacy_report(path: str) -> int:
    header, rows = read_csv(path)
    idx = {h: i for i, h in enumerate(header)}
    ts = [int(r[idx["timestamp_ns"]]) for r in rows]
    st = interval_stats(ts)
    pcols = [i for i, h in enumerate(header) if re.match(r"^p_\d+_f[xyz]$", h)]
    keys = [tuple(r[i] for i in pcols) for r in rows]
    dup = sum(1 for a, b in zip(keys, keys[1:]) if a == b)
    change_ts = [ts[0]] + [t for k, kp, t in zip(keys[1:], keys[:-1], ts[1:]) if k != kp]
    cs = interval_stats(change_ts)
    print(f"{os.path.basename(path)} (legacy push-stream file): {len(rows)} rows, {len(header)} columns")
    print(f"   row spacing ms: median {st['median_ms']:.2f}  p5 {st['p5_ms']:.2f}  p95 {st['p95_ms']:.2f}")
    print(f"   consecutive duplicate taxel blocks: {dup} of {len(rows)-1} ({100*dup/max(1,len(rows)-1):.0f}%)")
    print(f"   distinct blocks: {len(change_ts)}; refresh interval ms median {cs['median_ms']:.2f}  p5 {cs['p5_ms']:.2f}  p95 {cs['p95_ms']:.2f}")
    print("   as paxini-raw/1 this file would have", len(change_ts), "rows")
    return 0


# ----------------------------------------------------------------- example
def write_example(folder: str) -> int:
    """A synthetic 10 s episode: one DP module logging resultant, array, hall,
    temperature; refresh every ~13 ms; a press from 3 to 6 s."""
    rng = random.Random(1)
    os.makedirs(folder, exist_ok=True)
    t0 = 1_787_081_239_935_874_233
    points = 52
    header = LEAD + ["fx", "fy", "fz"]
    header += [f"p_{k:02d}_{ax}" for k in range(points) for ax in ("fx", "fy", "fz")]
    header += [f"h_{k:02d}_{ax}" for k in range(12) for ax in ("x", "y", "z")]
    header += [f"t_{k:02d}" for k in range(12)]
    base_h = [(rng.randint(-500, 500), rng.randint(-900, 900), rng.choice([-1900, -200, 1750])) for _ in range(12)]
    temp = [rng.randint(430, 480) for _ in range(12)]
    rows = []
    t = 0.0
    seq = 0
    prev_vals = None
    polls = 0
    while t < 10.0:
        t += 0.0125 + rng.uniform(0.0, 0.0008)  # the sensor's refresh
        polls += 3
        press = 3.0 <= t <= 6.0
        load = 40 if press else 0
        res = (rng.randint(-2, 2) if press else 0, rng.randint(-2, 2) if press else 0, load + (rng.randint(0, 2) if press else 0))
        arr = []
        for k in range(points):
            on = press and 18 <= k <= 33
            arr += [rng.randint(-1, 1) if on else 0, rng.randint(-1, 1) if on else 0, (2 + rng.randint(0, 1)) if on else 0]
        hall = []
        for k in range(12):
            bx, by, bz = base_h[k]
            d = (rng.randint(-6, 6), rng.randint(-6, 6), rng.randint(-6, 6))
            push = (60 if press and k in (3, 4, 5) else 0)
            hall += [bx + d[0], by + d[1], bz + d[2] + push]
        if seq % 40 == 0:  # temperature moves slowly
            temp = [v + rng.choice([-1, 0, 0, 1]) for v in temp]
        vals = {"resultant": tuple(res), "array": tuple(arr), "hall": tuple(hall), "temperature": tuple(temp)}
        changed = 0
        for g, bit in REGION_BITS.items():
            if g in vals and (prev_vals is None or vals[g] != prev_vals[g]):
                changed |= bit
        if changed == 0:
            continue
        ts = t0 + int(t * 1e9)
        rows.append([ts, ts, seq, changed, *res, *arr, *hall, *temp])
        prev_vals = vals
        seq += 1
    path = os.path.join(folder, "sensor_1.csv")
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        w.writerows(rows)
    change_ts = [r[0] for r in rows]
    st = interval_stats(change_ts)
    meta = {
        "schema": "paxini-raw-meta/1",
        "recorder": {"name": "validate_raw_sidecar --example", "version": "1", "transport": "synthetic", "poll_period_ms": 4},
        "clock": "time.time_ns (epoch)",
        "modules": [{
            "file": "sensor_1.csv", "slot": 10, "model": "DP-S2015", "points": points,
            "firmware": "TOUCHSEN_G012GM_AL1.0.5_FW1.0.5_synthetic",
            "element_ids": [f"{rng.randrange(1 << 32):08x}" for _ in range(12)],
            "regions": ["resultant", "array", "hall", "temperature"],
            "units": "counts",
            "scales": {"resultant_lsb_n": 0.1, "array_lsb_n": 0.2, "hall": "uncalibrated counts", "temperature": "0.06 degC per count, slope only"},
            "refresh_ms": {"median": round(st["median_ms"], 2), "p5": round(st["p5_ms"], 2), "p95": round(st["p95_ms"], 2)},
            "rows": len(rows), "polls": polls,
        }],
    }
    json.dump(meta, open(os.path.join(folder, "meta.json"), "w", encoding="utf-8"), indent=2)
    json.dump({"episode_start_timestamp_ns": t0, "clock": "time.time_ns (epoch)",
               "note": "synthetic example written by validate_raw_sidecar.py --example", "source_raw_episode": 0},
              open(os.path.join(folder, "alignment.json"), "w", encoding="utf-8"), indent=2)
    print(f"wrote {path} ({len(rows)} rows), meta.json, alignment.json")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 2
    if argv[1] == "--example":
        return write_example(argv[2] if len(argv) > 2 else "raw_sidecar_example/episode_000000")
    if argv[1] == "--legacy":
        return legacy_report(argv[2])
    target = argv[1]
    if os.path.isdir(target):
        return validate_folder(target)
    problems = validate_file(target)
    for p in problems:
        print("   PROBLEM:", p)
    print("OK" if not problems else f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
