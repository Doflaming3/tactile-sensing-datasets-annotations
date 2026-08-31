# t-SNE companion to raw_event_knn.py, plus the special classes our detector
# emits that the published annotations don't have: phantom, finger_unload,
# sensor_residual (from run-detector.ts --json dumps of the full atom set).
#
# The special classes are tiny (a handful each, all video-adjudicated), so no
# classification scores for them - instead they are overlaid on the PCA and
# t-SNE maps and each one is placed by a k=7 vote among the published-event
# windows: where does each special event live in raw-signal space?
#
# Run raw_event_knn.py conventions: same windows, same features, same seeds.

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.manifold import TSNE
from sklearn.neighbors import KNeighborsClassifier
from sklearn.preprocessing import StandardScaler

from raw_event_knn import (ANN, AUTO_RE, BG_PER_FINGER, CLASSES, HALF, RNG,
                           SENS, window_features)
from raw_stage_knn import finger_features

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "analysis/raw-event-knn"
DUMPS = Path(sys.argv[1]) if len(sys.argv) > 1 else None
SPECIALS = ["phantom", "finger_unload", "sensor_residual"]
SPECIAL_RE = re.compile(r"^\[auto:(\w+)\]\s+(\w+)(?:\s+(f\d))?")


def load_finger_feats(ep):
    ep_dir = SENS / f"episode_{ep:06d}"
    t0_ns = json.load(open(ep_dir / "alignment.json"))["episode_start_timestamp_ns"]
    return {"f0": finger_features(ep_dir / "sensor_1.csv", t0_ns),
            "f1": finger_features(ep_dir / "sensor_2.csv", t0_ns)}


def main():
    # -- published-event windows (identical construction to raw_event_knn) ----
    samples, labels, groups, feats_cache = [], [], [], {}
    for ep in range(63):
        ann_path = ANN / f"episode_{ep:06d}.json"
        if not ann_path.exists() or not (SENS / f"episode_{ep:06d}").exists():
            continue
        feats = load_finger_feats(ep)
        feats_cache[ep] = feats
        events = {"f0": [], "f1": []}
        for a in json.load(open(ann_path, encoding="utf-8"))["atoms"]:
            if a.get("style") != "interjection":
                continue
            m = AUTO_RE.match(a["content"])
            if m and m.group(2) in CLASSES:
                events[m.group(3)].append((a["timestamp"], m.group(2)))
        for fg, evs in events.items():
            feat = feats[fg]
            for t_ev, name in evs:
                v = window_features(feat, t_ev)
                if v is not None:
                    samples.append(v); labels.append(name); groups.append(ep)
            ev_times = np.array([t for t, _ in evs]) if evs else np.array([0.0])
            t = feat["t"].to_numpy()
            cand = t[(t > t[0] + HALF) & (t < t[-1] - HALF)]
            far = cand[np.abs(cand[:, None] - ev_times[None, :]).min(axis=1) >= 0.5]
            if len(far):
                for t_bg in RNG.choice(far, size=min(BG_PER_FINGER, len(far)), replace=False):
                    v = window_features(feat, t_bg)
                    if v is not None:
                        samples.append(v); labels.append("background"); groups.append(ep)
    X = np.vstack(samples)
    y = np.array(labels)
    print(f"published-event windows: {len(y)}")

    # -- special-class windows from our detector's atom dumps -----------------
    sp_samples, sp_rows = [], []
    for ep in range(63):
        dump = DUMPS / f"ep_{ep}.json"
        if not dump.exists():
            continue
        atoms = json.load(open(dump, encoding="utf-8"))["atoms"]
        for a in atoms:
            m = SPECIAL_RE.match(a.get("content", ""))
            if not m or m.group(2) not in SPECIALS or not m.group(3):
                continue
            feats = feats_cache.get(ep) or load_finger_feats(ep)
            feats_cache[ep] = feats
            v = window_features(feats[m.group(3)], a["timestamp"])
            if v is not None:
                sp_samples.append(v)
                sp_rows.append({"episode": ep, "t": a["timestamp"],
                                "finger": m.group(3), "label": m.group(2)})
    Xsp = np.vstack(sp_samples) if sp_samples else np.zeros((0, X.shape[1]))
    sp = pd.DataFrame(sp_rows)
    print(f"special windows: {len(sp)}")
    if len(sp):
        print(sp["label"].value_counts().to_string())

    # -- place specials by 7-NN vote among published windows ------------------
    sc = StandardScaler().fit(X)
    Xs, Xsps = sc.transform(X), sc.transform(Xsp)
    knn = KNeighborsClassifier(n_neighbors=7).fit(Xs, y)
    if len(sp):
        dist, idx = knn.kneighbors(Xsps)
        print("\nwhere each special event lands (7 nearest published windows):")
        for i, r in sp.iterrows():
            votes = pd.Series(y[idx[i]]).value_counts()
            vote_str = ", ".join(f"{c}x{n}" for c, n in votes.items())
            print(f"  ep{r['episode']:>2} {r['finger']} @{r['t']:6.2f}s  "
                  f"{r['label']:<16} -> {vote_str}")

    # -- maps -----------------------------------------------------------------
    p = PCA(n_components=2).fit(Xs)
    P, Psp = p.transform(Xs), p.transform(Xsps) if len(sp) else np.zeros((0, 2))
    Xall = np.vstack([Xs, Xsps])
    T = TSNE(n_components=2, perplexity=30, init="pca", learning_rate="auto",
             random_state=0).fit_transform(Xall)
    Tm, Tsp = T[: len(y)], T[len(y):]

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    sp_marks = {"phantom": ("*", "red"), "finger_unload": ("P", "black"),
                "sensor_residual": ("X", "magenta")}
    fig, axes = plt.subplots(1, 2, figsize=(16, 7))
    for ax, M, Msp, title in [(axes[0], P, Psp, "PCA"), (axes[1], Tm, Tsp, "t-SNE")]:
        for cls in CLASSES:
            msk = y == cls
            ax.scatter(M[msk, 0], M[msk, 1], s=9, alpha=0.5, label=f"{cls} (n={msk.sum()})")
        for lab, (mk, col) in sp_marks.items():
            msk = (sp["label"] == lab).to_numpy() if len(sp) else np.array([], bool)
            if msk.any():
                ax.scatter(Msp[msk, 0], Msp[msk, 1], s=160, marker=mk, c=col,
                           edgecolors="white", linewidths=0.8, zorder=5,
                           label=f"{lab} (n={msk.sum()})")
        ax.set_title(f"event windows, {title}")
        ax.grid(alpha=0.3)
    axes[1].legend(fontsize=8, loc="upper right")
    fig.tight_layout()
    fig.savefig(OUT / "event_pca_tsne_specials.png", dpi=130)
    if len(sp):
        sp.to_csv(OUT / "special_events.csv", index=False)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    sys.exit(main())
