# Event (interjection) structure in the raw 91 Hz tactile stream (sotac,
# pinned e0fcfeb3). Companion to raw_stage_knn.py, one level down: instead of
# per-frame stage labels, each sample is a +/-0.35 s raw-signal window around
# one published interjection event on its tagged finger.
#
# Classes: slip, contact_onset, grasp_stable, place, release, drop
# (rotation/lift n=1 excluded), plus sampled "background" windows >=0.5 s from
# any event on that finger, as the none-of-the-above class.
#
# Window features: normal / shear / active-taxel / hf channels (same
# construction as raw_stage_knn.finger_features) resampled to 16 points each
# (64 dims), plus 4 scalars: pre-mean, post-mean, post-pre delta of normal,
# and window-max hf.
#
# Part A - KNN over event type, k swept, episode-grouped CV.
# Part B - k-means k swept: do event types emerge unsupervised? Plus PCA map.
#
# Same label caveat as the stage study: eps 0-5 human-corrected, 6-59 detector
# output. f0 = sensor_1.csv, f1 = sensor_2.csv (sorted order, as in
# run-detector.ts loadRawCsvTexts).

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import (adjusted_rand_score, confusion_matrix, f1_score,
                             normalized_mutual_info_score, silhouette_score)
from sklearn.model_selection import GroupKFold
from sklearn.neighbors import KNeighborsClassifier
from sklearn.preprocessing import StandardScaler

from raw_stage_knn import finger_features

ROOT = Path(__file__).resolve().parents[1]
SENS = ROOT / "data/sotac/sensors/paxini_fingertip"
ANN = ROOT / "data/sotac/annotations"
OUT = ROOT / "analysis/raw-event-knn"
OUT.mkdir(parents=True, exist_ok=True)

CLASSES = ["contact_onset", "grasp_stable", "slip", "place", "release", "drop",
           "background"]
HALF = 0.35          # window half-width, s
RESAMP = 16          # points per channel after resampling
CHANNELS = ["normal", "shear", "active", "hf"]
BG_PER_FINGER = 2    # background windows sampled per episode-finger
AUTO_RE = re.compile(r"^\[auto:(\w+)\]\s+(\w+)\s+(f\d)")
RNG = np.random.RandomState(0)


def window_features(feat: pd.DataFrame, t_ev: float):
    t = feat["t"].to_numpy()
    if t_ev - HALF < t[0] - 0.05 or t_ev + HALF > t[-1] + 0.05:
        return None
    grid = np.linspace(t_ev - HALF, t_ev + HALF, RESAMP)
    vec = [np.interp(grid, t, feat[ch].to_numpy()) for ch in CHANNELS]
    normal = vec[CHANNELS.index("normal")]
    pre = normal[: RESAMP // 2].mean()
    post = normal[RESAMP // 2:].mean()
    scalars = [pre, post, post - pre, vec[CHANNELS.index("hf")].max()]
    return np.concatenate(vec + [np.array(scalars)])


def main():
    samples, labels, groups = [], [], []
    for ep in range(63):
        ann_path = ANN / f"episode_{ep:06d}.json"
        ep_dir = SENS / f"episode_{ep:06d}"
        if not ann_path.exists() or not ep_dir.exists():
            continue
        t0_ns = json.load(open(ep_dir / "alignment.json"))["episode_start_timestamp_ns"]
        feats = {"f0": finger_features(ep_dir / "sensor_1.csv", t0_ns),
                 "f1": finger_features(ep_dir / "sensor_2.csv", t0_ns)}
        atoms = json.load(open(ann_path, encoding="utf-8"))["atoms"]
        events = {"f0": [], "f1": []}
        for a in atoms:
            if a.get("style") != "interjection":
                continue
            m = AUTO_RE.match(a["content"])
            if not m or m.group(2) not in CLASSES:
                continue
            events[m.group(3)].append((a["timestamp"], m.group(2)))

        for fg, evs in events.items():
            feat = feats[fg]
            for t_ev, name in evs:
                v = window_features(feat, t_ev)
                if v is not None:
                    samples.append(v); labels.append(name); groups.append(ep)
            # background: >=0.5 s from every event on this finger
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
    groups = np.array(groups)
    print(f"windows={len(y)}  dims={X.shape[1]}  episodes={len(np.unique(groups))}")
    print(pd.Series(y).value_counts().to_string(), "\n")

    # -- Part A: KNN sweep ----------------------------------------------------
    ks = [1, 3, 5, 7, 9, 15, 25, 51]
    gkf = GroupKFold(n_splits=5)
    rows, best, cm_best = [], (-1, None), None
    for k in ks:
        accs, f1s = [], []
        cm = np.zeros((len(CLASSES), len(CLASSES)), int)
        for tr, te in gkf.split(X, y, groups):
            sc = StandardScaler().fit(X[tr])
            clf = KNeighborsClassifier(n_neighbors=k, n_jobs=-1)
            clf.fit(sc.transform(X[tr]), y[tr])
            pred = clf.predict(sc.transform(X[te]))
            accs.append((pred == y[te]).mean())
            f1s.append(f1_score(y[te], pred, average="macro"))
            cm += confusion_matrix(y[te], pred, labels=CLASSES)
        rows.append({"k": k, "acc": np.mean(accs), "macro_f1": np.mean(f1s)})
        print(f"KNN k={k:>2}  acc={rows[-1]['acc']:.3f}  macroF1={rows[-1]['macro_f1']:.3f}")
        if rows[-1]["macro_f1"] > best[0]:
            best, cm_best = (rows[-1]["macro_f1"], k), cm
    knn_df = pd.DataFrame(rows)
    cm_df = pd.DataFrame(cm_best, index=CLASSES, columns=CLASSES)
    print(f"\nbest k={best[1]}; pooled confusion (rows=true, cols=pred):")
    print(cm_df.to_string())
    print("\nper-class recall:")
    for s, r in zip(CLASSES, cm_best.diagonal() / np.maximum(cm_best.sum(axis=1), 1)):
        print(f"  {s:<14} {r:.3f}")

    # -- Part B: k-means sweep ------------------------------------------------
    Xs = StandardScaler().fit_transform(X)
    km_rows, labels_at = [], {}
    for k in range(2, 13):
        km = KMeans(n_clusters=k, n_init=10, random_state=0).fit(Xs)
        labels_at[k] = km.labels_
        km_rows.append({"k": k,
                        "silhouette": silhouette_score(Xs, km.labels_),
                        "ARI": adjusted_rand_score(y, km.labels_),
                        "NMI": normalized_mutual_info_score(y, km.labels_)})
        r = km_rows[-1]
        print(f"kmeans k={k:>2}  sil={r['silhouette']:.3f}  ARI={r['ARI']:.3f}  NMI={r['NMI']:.3f}")
    km_df = pd.DataFrame(km_rows)
    print("\ncluster-vs-event contingency at k=7 (col-normalized):")
    ct = pd.crosstab(labels_at[7], y)[CLASSES]
    print((ct / ct.sum(axis=0)).round(2).to_string())

    knn_df.to_csv(OUT / "knn_sweep.csv", index=False)
    km_df.to_csv(OUT / "kmeans_sweep.csv", index=False)
    cm_df.to_csv(OUT / "knn_confusion_bestk.csv")
    ct.to_csv(OUT / "kmeans_k7_contingency.csv")

    # -- Figures --------------------------------------------------------------
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, 3, figsize=(16, 4.2))
    ax = axes[0]
    ax.plot(knn_df["k"], knn_df["acc"], "o-", label="accuracy")
    ax.plot(knn_df["k"], knn_df["macro_f1"], "s-", label="macro-F1")
    ax.set_xscale("log"); ax.set_xlabel("k (neighbors)")
    ax.set_title("KNN over event windows"); ax.grid(alpha=0.3); ax.legend()

    ax = axes[1]
    ax.plot(km_df["k"], km_df["silhouette"], "o-", label="silhouette")
    ax.plot(km_df["k"], km_df["ARI"], "s-", label="ARI vs events")
    ax.plot(km_df["k"], km_df["NMI"], "^-", label="NMI vs events")
    ax.set_xlabel("k (clusters)"); ax.set_title("k-means sweep")
    ax.grid(alpha=0.3); ax.legend()

    ax = axes[2]
    cmn = cm_best / np.maximum(cm_best.sum(axis=1, keepdims=True), 1)
    im = ax.imshow(cmn, cmap="Blues", vmin=0, vmax=1)
    ax.set_xticks(range(len(CLASSES)), CLASSES, rotation=35, ha="right")
    ax.set_yticks(range(len(CLASSES)), CLASSES)
    for i in range(len(CLASSES)):
        for j in range(len(CLASSES)):
            ax.text(j, i, f"{cmn[i, j]:.2f}", ha="center", va="center", fontsize=8,
                    color="white" if cmn[i, j] > 0.5 else "black")
    ax.set_title(f"KNN row-normalized confusion (k={best[1]})")
    fig.colorbar(im, ax=ax, fraction=0.046)
    fig.tight_layout()
    fig.savefig(OUT / "event_structure_sweeps.png", dpi=130)

    p2 = PCA(n_components=2).fit_transform(Xs)
    fig2, ax = plt.subplots(figsize=(8, 6.5))
    for cls in CLASSES:
        m = y == cls
        ax.scatter(p2[m, 0], p2[m, 1], s=10, alpha=0.6, label=f"{cls} (n={m.sum()})")
    ax.set_title("event windows, PCA of standardized features")
    ax.legend(fontsize=8); ax.grid(alpha=0.3)
    fig2.tight_layout()
    fig2.savefig(OUT / "event_pca.png", dpi=130)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    sys.exit(main())
