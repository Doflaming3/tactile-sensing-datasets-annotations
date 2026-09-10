"""Reverse-engineer Jingyi's dataset trim (cycle 1 of her trim ask).

Aligns every curated episode (sotac) to its source episode in the raw
recordings (sotac_raw) by exact row match, extracts the frames she cut at
the start and the end, and tests what rule those cuts follow: arm motion
onset/end, jaw motion, tactile load, round seconds. Also checks what the
trim did to the videos (re-encoded or re-pointed) and to the raw sidecars
(cut at the start? at the end?).

Usage (repo root):
    python scripts/trim_census.py                      # old 63: local mirrors
    python scripts/trim_census.py --raw data/sotac_raw_<rev> --cur data/sotac_main_<rev> --tag new
Writes analysis/trim-census-<tag>.csv and prints the findings.
"""
import argparse
import glob
import json
import os
import sys

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

FPS = 30


def load_rows(root: str) -> pd.DataFrame:
    files = sorted(glob.glob(f"{root}/data/**/*.parquet", recursive=True))
    if not files:
        sys.exit(f"no data parquet under {root}")
    return pd.concat([pq.read_table(f).to_pandas() for f in files], ignore_index=True)


def load_meta(root: str) -> pd.DataFrame:
    files = sorted(glob.glob(f"{root}/meta/episodes/**/*.parquet", recursive=True))
    return pd.concat([pq.read_table(f).to_pandas() for f in files], ignore_index=True)


def nested(v):
    """pyarrow list<list<...>> columns come back as object ndarrays whose
    elements are again object ndarrays; unwrap to plain nested lists."""
    if isinstance(v, np.ndarray) and v.dtype == object:
        return [nested(x) for x in v]
    if isinstance(v, (list, tuple)):
        return [nested(x) for x in v]
    return v


def stack(df: pd.DataFrame, col: str) -> np.ndarray:
    return np.stack(df[col].to_numpy()).astype(np.float64)


def episodes(df: pd.DataFrame):
    out = {}
    for ep, g in df.groupby("episode_index"):
        out[int(ep)] = g.sort_values("frame_index").reset_index(drop=True)
    return out


def align(cur_eps, raw_eps):
    """curated episode -> (raw episode, start cut, end cut) by exact match of
    the state+action rows; the row signature index makes it fast."""
    sig_index = {}
    raw_sig = {}
    for r, g in raw_eps.items():
        s = np.round(np.concatenate([stack(g, "observation.state"), stack(g, "action")], axis=1), 5)
        raw_sig[r] = s
        for i, row in enumerate(s):
            sig_index.setdefault(row.tobytes(), []).append((r, i))
    result = {}
    for c, g in cur_eps.items():
        s = np.round(np.concatenate([stack(g, "observation.state"), stack(g, "action")], axis=1), 5)
        n = len(s)
        found = None
        for (r, i) in sig_index.get(s[0].tobytes(), []):
            R = raw_sig[r]
            if i + n <= len(R) and np.array_equal(R[i:i + n], s):
                found = (r, i, len(R) - i - n)
                break
        result[c] = found
    return result


def motion_bounds(g: pd.DataFrame, eps_frac=0.02, hold=3):
    """First/last frame where the arm (joints 0..4) is away from its initial
    pose by more than eps_frac of that episode's joint range, held `hold`
    frames; also the jaw's first/last movement and the tactile load's
    first/last frame above a quiet margin. Frame indices in the RAW episode."""
    st = stack(g, "observation.state")
    arm = st[:, :5]
    jaw = st[:, 5]
    rng = np.maximum(arm.max(0) - arm.min(0), 1e-6)
    dev = np.abs(arm - arm[0]) / rng
    moving = (dev > eps_frac).any(1)
    dev_end = np.abs(arm - arm[-1]) / rng
    moving_end = (dev_end > eps_frac).any(1)

    def first_held(mask):
        for i in range(len(mask) - hold + 1):
            if mask[i:i + hold].all():
                return i
        return None

    def last_held(mask):
        for i in range(len(mask) - 1, hold - 2, -1):
            if mask[i - hold + 1:i + 1].all():
                return i
        return None

    jaw_rng = max(jaw.max() - jaw.min(), 1e-6)
    jaw_moving = np.abs(jaw - jaw[0]) / jaw_rng > eps_frac
    jaw_moving_end = np.abs(jaw - jaw[-1]) / jaw_rng > eps_frac
    load = None
    if "observation.sensors.paxini_fingertip" in g:
        # nested list columns arrive as object arrays of object arrays
        tac = np.stack([np.asarray(nested(v), dtype=np.float64)
                        for v in g["observation.sensors.paxini_fingertip"].to_numpy()])
        # (frames, ..., 3): normal component per taxel, summed -> load per frame
        comp = tac.reshape(len(tac), -1, tac.shape[-1])
        f = np.abs(comp[..., 2] if tac.shape[-1] == 3 else comp).reshape(len(tac), -1).sum(1)
        base = np.median(f[: max(5, len(f) // 10)])
        loaded = f > base + 0.5 * max(f.std(), 1e-6)
        li = np.where(loaded)[0]
        load = (int(li[0]), int(li[-1])) if len(li) else (None, None)
    # speed-based onset as a second opinion: |Δ| over 1 frame vs 1% of range
    sp = np.abs(np.diff(arm, axis=0)) / rng
    fast = (sp > 0.01).any(1)
    fi = np.where(fast)[0]
    speed_bounds = (int(fi[0]) + 1, int(fi[-1]) + 1) if len(fi) else (None, None)
    return {
        "arm_onset": first_held(moving),
        "arm_end": last_held(moving_end),
        "speed_onset": speed_bounds[0],
        "speed_end": speed_bounds[1],
        "jaw_onset": first_held(jaw_moving),
        "jaw_end": last_held(jaw_moving_end),
        "load_onset": load[0] if load else None,
        "load_end": load[1] if load else None,
    }


def sidecar_files(root: str, ep: int):
    return sorted(
        p for p in glob.glob(f"{root}/sensors/**/*.csv", recursive=True)
        if f"episode_{ep:06d}" in p.replace(os.sep, "/")
    )


def sidecar_span(path: str):
    d = pd.read_csv(path, comment="#", usecols=lambda c: "timestamp" in c)
    col = "calibrated_timestamp_ns" if "calibrated_timestamp_ns" in d else d.columns[0]
    t = d[col].to_numpy(dtype=np.float64)
    return float(t[0]), float(t[-1]), len(t)


def alignment_start(root: str, ep: int):
    for p in glob.glob(f"{root}/sensors/**/alignment.json", recursive=True):
        if f"episode_{ep:06d}" in p.replace(os.sep, "/"):
            j = json.load(open(p, encoding="utf-8"))
            for k in ("episode_start_timestamp_ns", "start_timestamp_ns"):
                if k in j:
                    return float(j[k])
    return None


def video_files(root: str):
    return {os.path.relpath(p, root).replace(os.sep, "/"): os.path.getsize(p)
            for p in glob.glob(f"{root}/videos/**/*.mp4", recursive=True)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default="data/sotac_raw")
    ap.add_argument("--cur", default="data/sotac")
    ap.add_argument("--tag", default="old63")
    ap.add_argument("--no-sidecars", action="store_true")
    a = ap.parse_args()

    raw = episodes(load_rows(a.raw))
    cur = episodes(load_rows(a.cur))
    raw_meta = load_meta(a.raw).set_index("episode_index")
    cur_meta = load_meta(a.cur).set_index("episode_index")
    print(f"raw {a.raw}: {len(raw)} episodes; curated {a.cur}: {len(cur)} episodes")

    pairs = align(cur, raw)
    rows = []
    unmatched = [c for c, p in pairs.items() if p is None]
    for c, p in pairs.items():
        if p is None:
            continue
        r, start_cut, end_cut = p
        g = raw[r]
        mb = motion_bounds(g)
        n_raw, n_cur = len(g), len(cur[c])
        row = {
            "cur": c, "raw": r, "raw_frames": n_raw, "cur_frames": n_cur,
            "start_cut": start_cut, "end_cut": end_cut,
            "start_s": round(start_cut / FPS, 3), "end_s": round(end_cut / FPS, 3),
            "kept_end_frame_raw": start_cut + n_cur - 1,
            **{k: (None if v is None else int(v)) for k, v in mb.items()},
        }
        # her timestamps: re-based?
        tc = cur[c]["timestamp"].to_numpy()
        row["cur_t0"] = round(float(tc[0]), 4)
        row["cur_frame0"] = int(cur[c]["frame_index"].iloc[0])
        # video: same file + shifted window, or new file?
        for cam in [k for k in cur_meta.columns if k.startswith("videos/") and k.endswith("/from_timestamp")]:
            base = cam[: -len("/from_timestamp")]
            cf, ct = float(cur_meta.loc[c, cam]), float(cur_meta.loc[c, base + "/to_timestamp"])
            rf, rt = float(raw_meta.loc[r, cam]), float(raw_meta.loc[r, base + "/to_timestamp"])
            camname = base.split("/")[1].split(".")[-1]
            row[f"vid_{camname}_cur_from"] = round(cf, 3)
            row[f"vid_{camname}_raw_from"] = round(rf, 3)
            row[f"vid_{camname}_shift_vs_cut"] = round(cf - rf - start_cut / FPS, 3)
            row[f"vid_{camname}_cur_len"] = round(ct - cf, 3)
        # sidecars: cut at start / end?
        if not a.no_sidecars:
            rs, cs = sidecar_files(a.raw, r), sidecar_files(a.cur, c)
            if rs and cs:
                r0, r1, rn = sidecar_span(rs[0])
                c0, c1, cn = sidecar_span(cs[0])
                row["sc_raw_rows"], row["sc_cur_rows"] = rn, cn
                row["sc_raw_span_s"] = round((r1 - r0) / 1e9, 2)
                row["sc_cur_span_s"] = round((c1 - c0) / 1e9, 2)
                row["sc_start_cut_s"] = round((c0 - r0) / 1e9, 2)
                row["sc_end_cut_s"] = round((r1 - c1) / 1e9, 2)
                ra, ca = alignment_start(a.raw, r), alignment_start(a.cur, c)
                if ra is not None and ca is not None:
                    row["align_shift_s"] = round((ca - ra) / 1e9, 3)
                    row["sc_cur_lead_s"] = round((ca - c0) / 1e9, 2)  # sidecar starts this long before the episode
                    row["sc_cur_tail_s"] = round((c1 - ca) / 1e9 - (n_cur - 1) / FPS, 2)  # runs this long past the episode end
        rows.append(row)

    df = pd.DataFrame(rows).sort_values("cur")
    os.makedirs("analysis", exist_ok=True)
    out = f"analysis/trim-census-{a.tag}.csv"
    df.to_csv(out, index=False)
    print(f"wrote {out}: {len(df)} aligned, {len(unmatched)} unmatched curated episodes {unmatched[:10]}")
    raw_used = set(df["raw"])
    print(f"raw episodes not used by any curated episode: {sorted(set(raw) - raw_used)}")

    print("\n--- cuts (frames)")
    print(df[["start_cut", "end_cut"]].describe().round(1).to_string())
    print("\nstart cut % 30 (=0 would mean whole seconds):", np.bincount((df.start_cut % 30).to_numpy(), minlength=30).tolist())
    print("end cut % 30:", np.bincount((df.end_cut % 30).to_numpy(), minlength=30).tolist())
    print("cur timestamp0 == 0 for all:", bool((df.cur_t0.abs() < 1e-6).all()), "| frame_index0 == 0 for all:", bool((df.cur_frame0 == 0).all()))

    print("\n--- her start cut vs signal onsets (raw frames): cut - onset")
    for k in ("arm_onset", "speed_onset", "jaw_onset", "load_onset"):
        d = df["start_cut"] - df[k]
        print(f"  {k:12s} mean {d.mean():7.1f}  std {d.std():6.1f}  median {d.median():6.1f}  min {d.min():6.1f} max {d.max():6.1f}  (n={d.notna().sum()})")
    print("--- her end (last kept raw frame) vs signal ends: kept_end - end")
    for k in ("arm_end", "speed_end", "jaw_end", "load_end"):
        d = df["kept_end_frame_raw"] - df[k]
        print(f"  {k:12s} mean {d.mean():7.1f}  std {d.std():6.1f}  median {d.median():6.1f}  min {d.min():6.1f} max {d.max():6.1f}  (n={d.notna().sum()})")

    vcols = [c for c in df.columns if c.startswith("vid_") and c.endswith("_shift_vs_cut")]
    if vcols:
        print("\n--- video: curated from_timestamp - (raw from_timestamp + start cut)   [0 = same file, window shifted by the cut]")
        for c in vcols:
            print(f"  {c}: mean {df[c].mean():.3f} std {df[c].std():.3f} min {df[c].min():.3f} max {df[c].max():.3f}")
    rv, cv = video_files(a.raw), video_files(a.cur)
    same = [k for k in cv if k in rv and rv[k] == cv[k]]
    print(f"video files: raw {len(rv)}, curated {len(cv)}, identical size {len(same)}")

    if "sc_start_cut_s" in df:
        print("\n--- sidecars")
        print(f"  start cut applied (sidecar start moved by ~ the cut): {(np.abs(df.sc_start_cut_s - df.start_s) < 0.5).sum()} of {df.sc_start_cut_s.notna().sum()}")
        if "sc_cur_tail_s" in df:
            tail = df.sc_cur_tail_s.dropna()
            print(f"  curated sidecar runs past the episode end: median {tail.median():.1f} s, max {tail.max():.1f} s; within 1 s of the end: {(tail.abs() < 1).sum()} of {len(tail)}")
            lead = df.sc_cur_lead_s.dropna()
            print(f"  curated sidecar starts before the episode start: median {lead.median():.2f} s, max {lead.max():.2f} s")
    print("\nper-episode table:")
    cols = ["cur", "raw", "raw_frames", "cur_frames", "start_cut", "end_cut", "arm_onset", "speed_onset", "jaw_onset", "load_onset", "kept_end_frame_raw", "arm_end", "speed_end", "load_end"]
    if "sc_cur_tail_s" in df:
        cols += ["sc_start_cut_s", "sc_end_cut_s", "sc_cur_tail_s"]
    print(df[cols].to_string(index=False))


if __name__ == "__main__":
    main()
