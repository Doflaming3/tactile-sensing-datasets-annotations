# Two follow-ups to raw_event_tsne.py:
#
# A) Residual/phantom SCREEN validation, leave-episode-out: flag a terminal
#    event (place/release/drop) as artifact-suspect when >=4 of its 7 nearest
#    published-event windows (from OTHER episodes) are background. Measures
#    catch-rate on our detector's video-adjudicated artifacts (phantom,
#    sensor_residual) and false-alarm rate on published real terminals.
#    finger_unload is real signal - it should NOT be caught.
#
# B) Slip sub-types: cluster the 244 published slip windows (k-means over the
#    same 68-dim features, k swept by silhouette), characterize each cluster
#    physically, and rank episodes by "many slips, all one sub-type" to pick
#    a focus episode.

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import StandardScaler

from raw_event_knn import ANN, CLASSES, HALF, SENS, window_features
from raw_stage_knn import finger_features

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "analysis/raw-event-knn"
DUMPS = Path(sys.argv[1])
EV_RE = re.compile(r"^\[auto:(\w+)\]\s+(\w+)(?:\s+(f\d))?(?:\s+([\d.]+)s)?")
SPECIALS = ["phantom", "finger_unload", "sensor_residual"]
TERMINALS = ["place", "release", "drop"]
RNG = np.random.RandomState(0)


def load_finger_feats(ep):
    ep_dir = SENS / f"episode_{ep:06d}"
    t0_ns = json.load(open(ep_dir / "alignment.json"))["episode_start_timestamp_ns"]
    return {"f0": finger_features(ep_dir / "sensor_1.csv", t0_ns),
            "f1": finger_features(ep_dir / "sensor_2.csv", t0_ns)}


def collect():
    rows, vecs = [], []
    for ep in range(63):
        ann_path = ANN / f"episode_{ep:06d}.json"
        if not ann_path.exists() or not (SENS / f"episode_{ep:06d}").exists():
            continue
        feats = load_finger_feats(ep)
        ev_times = {"f0": [], "f1": []}
        for a in json.load(open(ann_path, encoding="utf-8"))["atoms"]:
            if a.get("style") != "interjection":
                continue
            m = EV_RE.match(a["content"])
            if not m or m.group(2) not in CLASSES or not m.group(3):
                continue
            fg, name = m.group(3), m.group(2)
            v = window_features(feats[fg], a["timestamp"])
            if v is None:
                continue
            ev_times[fg].append(a["timestamp"])
            rows.append({"episode": ep, "t": a["timestamp"], "finger": fg,
                         "label": name, "conf": m.group(1),
                         "dur": float(m.group(4)) if m.group(4) else np.nan})
            vecs.append(v)
        for fg in ("f0", "f1"):
            t = feats[fg]["t"].to_numpy()
            cand = t[(t > t[0] + HALF) & (t < t[-1] - HALF)]
            evs = np.array(ev_times[fg]) if ev_times[fg] else np.array([0.0])
            far = cand[np.abs(cand[:, None] - evs[None, :]).min(axis=1) >= 0.5]
            if len(far):
                for t_bg in RNG.choice(far, size=min(2, len(far)), replace=False):
                    v = window_features(feats[fg], t_bg)
                    if v is not None:
                        rows.append({"episode": ep, "t": t_bg, "finger": fg,
                                     "label": "background", "conf": "", "dur": np.nan})
                        vecs.append(v)
        # our detector's specials
        dump = DUMPS / f"ep_{ep}.json"
        if dump.exists():
            for a in json.load(open(dump, encoding="utf-8"))["atoms"]:
                m = EV_RE.match(a.get("content", ""))
                if m and m.group(2) in SPECIALS and m.group(3):
                    v = window_features(feats[m.group(3)], a["timestamp"])
                    if v is not None:
                        rows.append({"episode": ep, "t": a["timestamp"],
                                     "finger": m.group(3), "label": m.group(2),
                                     "conf": m.group(1), "dur": np.nan})
                        vecs.append(v)
    return pd.DataFrame(rows), np.vstack(vecs)


def main():
    meta, X = collect()
    pub = meta["label"].isin(CLASSES).to_numpy()
    print(f"windows: {len(meta)} ({pub.sum()} published-class, {(~pub).sum()} special)\n")

    # -- A: leave-episode-out background-vote screen --------------------------
    print("A) artifact screen: >=4/7 nearest published windows are background")
    flags = np.zeros(len(meta), bool)
    votes = np.zeros(len(meta))
    for ep in meta["episode"].unique():
        ref = pub & (meta["episode"] != ep).to_numpy()
        tst = (meta["episode"] == ep).to_numpy()
        sc = StandardScaler().fit(X[ref])
        nn = NearestNeighbors(n_neighbors=7).fit(sc.transform(X[ref]))
        _, idx = nn.kneighbors(sc.transform(X[tst]))
        bg = (meta.loc[ref, "label"].to_numpy()[idx] == "background").sum(axis=1)
        votes[tst] = bg
        flags[tst] = bg >= 4
    meta["bg_votes"], meta["flagged"] = votes, flags

    for lab in SPECIALS:
        m = meta["label"] == lab
        print(f"   {lab:<16} caught {int(meta.loc[m, 'flagged'].sum())}/{m.sum()}")
        for _, r in meta[m].iterrows():
            print(f"      ep{r['episode']:>2} @{r['t']:6.2f}s  bg_votes={int(r['bg_votes'])}/7"
                  f"  {'FLAGGED' if r['flagged'] else 'passes'}")
    real = meta["label"].isin(TERMINALS)
    fa = meta.loc[real].groupby("label")["flagged"].agg(["sum", "count"])
    print("   false alarms on published real terminals:")
    for lab, r in fa.iterrows():
        print(f"      {lab:<10} {int(r['sum']):>3}/{int(r['count'])} flagged"
              f"  ({r['sum'] / r['count']:.1%})")

    # -- B: slip sub-types ----------------------------------------------------
    print("\nB) slip sub-types (k-means over slip windows only)")
    sl = (meta["label"] == "slip").to_numpy()
    Xs = StandardScaler().fit_transform(X[sl])
    best_k, best_s = None, -1
    for k in range(2, 7):
        lab = KMeans(n_clusters=k, n_init=10, random_state=0).fit_predict(Xs)
        s = silhouette_score(Xs, lab)
        print(f"   k={k}  silhouette={s:.3f}")
        if s > best_s:
            best_k, best_s, best_lab = k, s, lab
    print(f"   chosen k={best_k}")
    slips = meta[sl].copy()
    slips["cluster"] = best_lab

    n_ch = 4  # normal, shear, active, hf channels of 16 pts + 4 scalars
    Xw = X[sl]
    print("\n   cluster physical profiles (means):")
    print("   cl    n   normal   shear   active   hf_max   d(normal)   dur_s   conf(h/m/l)")
    for c in range(best_k):
        m = slips["cluster"] == c
        w = Xw[m.to_numpy()]
        normal = w[:, 0:16].mean()
        shear = w[:, 16:32].mean()
        active = w[:, 32:48].mean()
        hfmax = w[:, 64 + 3].mean()
        dn = w[:, 64 + 2].mean()
        dur = slips.loc[m, "dur"].mean()
        cc = slips.loc[m, "conf"].value_counts()
        conf = "/".join(str(cc.get(x, 0)) for x in ("high", "medium", "low"))
        print(f"   {c:>2} {m.sum():>4}   {normal:6.2f}  {shear:6.2f}   {active:5.1f}"
              f"   {hfmax:6.2f}   {dn:8.2f}   {dur:5.2f}   {conf}")

    print("\n   episodes ranked for single-sub-type focus (>=5 slips):")
    grp = slips.groupby("episode")["cluster"]
    rank = []
    for ep, cl in grp:
        if len(cl) >= 5:
            top = cl.value_counts()
            rank.append({"episode": ep, "n_slips": len(cl),
                         "top_cluster": top.index[0], "purity": top.iloc[0] / len(cl)})
    rank = pd.DataFrame(rank).sort_values(["purity", "n_slips"], ascending=False)
    print(rank.head(10).to_string(index=False))

    slips.to_csv(OUT / "slip_subtypes.csv", index=False)
    meta.to_csv(OUT / "screen_all_windows.csv", index=False)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    sys.exit(main())
