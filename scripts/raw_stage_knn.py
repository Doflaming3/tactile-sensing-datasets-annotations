# Stage structure in the raw 91 Hz tactile stream (sotac, pinned e0fcfeb3).
#
# Question: do the four manipulation stages (approach / grasp / transport /
# place_release, from the published subtask annotations) exist as groups in
# raw tactile space?
#   Part A - KNN classifier, k swept, episode-grouped CV: are stages separable
#            given labels?
#   Part B - k-means, k swept: do stages emerge unsupervised?
#
# Features are tactile-only (no gripper, no arm): per finger, per raw frame:
#   normal   sum of per-taxel fz (baseline-corrected)
#   shear    |(sum fx, sum fy)|
#   peak     max per-taxel |F|
#   active   taxels with |fz| > 0.15 N (floor is 0.1 N/LSB)
#   dn       normal-force rate over a ~0.11 s window
#   hf       mean |frame-to-frame normal diff| over the same window
# Baseline = per-taxel median over the episode's first 1.0 s (cruder than the
# detector's jaw-gated plateau zeroing - raw CSVs carry no jaw - so settled
# phantoms like ep47's are NOT removed; that is a known caveat, not a bug).
#
# Labels are the published stage boundaries: only eps 0-5 are human-corrected,
# 6-59 are detector output. Scores measure structure, not gold accuracy.

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.metrics import (adjusted_rand_score, confusion_matrix, f1_score,
                             normalized_mutual_info_score, silhouette_score)
from sklearn.model_selection import GroupKFold
from sklearn.neighbors import KNeighborsClassifier
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]
SENS = ROOT / "data/sotac/sensors/paxini_fingertip"
ANN = ROOT / "data/sotac/annotations"
OUT = ROOT / "analysis/raw-stage-knn"
OUT.mkdir(parents=True, exist_ok=True)

STAGES = ["approach", "grasp", "transport", "place_release"]
WIN = 10  # ~0.11 s at 91 Hz, matches the detector's hf window
RNG = 0


def finger_features(csv_path: Path, t0_ns: int) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df = df.dropna(subset=["calibrated_timestamp_ns"])
    t = (df["calibrated_timestamp_ns"].to_numpy(np.int64) - t0_ns) / 1e9
    cols = df.columns
    fx = df[[c for c in cols if c.startswith("p_") and c.endswith("_fx")]].to_numpy(float)
    fy = df[[c for c in cols if c.startswith("p_") and c.endswith("_fy")]].to_numpy(float)
    fz = df[[c for c in cols if c.startswith("p_") and c.endswith("_fz")]].to_numpy(float)

    base = t < 1.0
    if base.sum() < 10:
        base = np.arange(len(t)) < 30
    fx = fx - np.median(fx[base], axis=0)
    fy = fy - np.median(fy[base], axis=0)
    fz = fz - np.median(fz[base], axis=0)

    normal = fz.sum(axis=1)
    shear = np.hypot(fx.sum(axis=1), fy.sum(axis=1))
    peak = np.sqrt(fx**2 + fy**2 + fz**2).max(axis=1)
    active = (np.abs(fz) > 0.15).sum(axis=1)

    dn = np.zeros_like(normal)
    dt = t[WIN:] - t[:-WIN]
    dn[WIN:] = (normal[WIN:] - normal[:-WIN]) / np.where(dt > 1e-6, dt, 1e-6)
    hf = (
        pd.Series(np.abs(np.diff(normal, prepend=normal[0])))
        .rolling(WIN, min_periods=1)
        .mean()
        .to_numpy()
    )

    return pd.DataFrame(
        {"t": t, "normal": normal, "shear": shear, "peak": peak,
         "active": active, "dn": dn, "hf": hf}
    ).sort_values("t")


def stage_boundaries(ann_path: Path):
    atoms = json.load(open(ann_path, encoding="utf-8"))["atoms"]
    bounds = [(a["timestamp"], a["content"]) for a in atoms
              if a.get("style") == "subtask" and a["content"] in STAGES]
    bounds.sort()
    return bounds


def load_episode(ep: int):
    ann_path = ANN / f"episode_{ep:06d}.json"
    ep_dir = SENS / f"episode_{ep:06d}"
    if not ann_path.exists() or not ep_dir.exists():
        return None
    t0_ns = json.load(open(ep_dir / "alignment.json"))["episode_start_timestamp_ns"]
    f1 = finger_features(ep_dir / "sensor_1.csv", t0_ns)
    f2 = finger_features(ep_dir / "sensor_2.csv", t0_ns)
    merged = pd.merge_asof(f1, f2, on="t", direction="nearest",
                           tolerance=0.02, suffixes=("_f0", "_f1")).dropna()

    bounds = stage_boundaries(ann_path)
    times = np.array([b[0] for b in bounds])
    names = [b[1] for b in bounds]
    idx = np.clip(np.searchsorted(times, merged["t"].to_numpy(), side="right") - 1, 0, None)
    merged["stage"] = [names[i] for i in idx]
    merged["episode"] = ep
    return merged


def main():
    frames = []
    for ep in range(63):
        m = load_episode(ep)
        if m is not None:
            frames.append(m)
    data = pd.concat(frames, ignore_index=True)
    feat_cols = [c for c in data.columns if c not in ("t", "stage", "episode")]
    X_raw = data[feat_cols].to_numpy(float)
    y = data["stage"].to_numpy()
    groups = data["episode"].to_numpy()
    print(f"episodes={data['episode'].nunique()}  frames={len(data)}  dims={len(feat_cols)}")
    print(data["stage"].value_counts().to_string(), "\n")

    # -- Part A: KNN, episode-grouped 5-fold CV, k swept ----------------------
    ks = [1, 3, 5, 9, 15, 25, 51, 101, 201]
    gkf = GroupKFold(n_splits=5)
    knn_rows = []
    cm_best, best = None, (-1, None)
    for k in ks:
        accs, f1s = [], []
        cm = np.zeros((len(STAGES), len(STAGES)), int)
        for tr, te in gkf.split(X_raw, y, groups):
            sc = StandardScaler().fit(X_raw[tr])
            clf = KNeighborsClassifier(n_neighbors=k, n_jobs=-1)
            clf.fit(sc.transform(X_raw[tr]), y[tr])
            pred = clf.predict(sc.transform(X_raw[te]))
            accs.append((pred == y[te]).mean())
            f1s.append(f1_score(y[te], pred, average="macro"))
            cm += confusion_matrix(y[te], pred, labels=STAGES)
        row = {"k": k, "acc": np.mean(accs), "macro_f1": np.mean(f1s)}
        knn_rows.append(row)
        print(f"KNN k={k:>3}  acc={row['acc']:.3f}  macroF1={row['macro_f1']:.3f}")
        if row["macro_f1"] > best[0]:
            best = (row["macro_f1"], k)
            cm_best = cm
    knn_df = pd.DataFrame(knn_rows)
    print(f"\nbest k={best[1]} by macro-F1; pooled confusion (rows=true, cols=pred):")
    cm_df = pd.DataFrame(cm_best, index=STAGES, columns=STAGES)
    print(cm_df.to_string(), "\n")
    recalls = cm_best.diagonal() / cm_best.sum(axis=1)
    for s, r in zip(STAGES, recalls):
        print(f"  recall {s:<14} {r:.3f}")

    # -- Part B: k-means, k swept --------------------------------------------
    Xs = StandardScaler().fit_transform(X_raw)
    rng = np.random.RandomState(RNG)
    sil_idx = rng.choice(len(Xs), size=min(10000, len(Xs)), replace=False)
    km_rows = []
    labels_at = {}
    for k in range(2, 13):
        km = KMeans(n_clusters=k, n_init=10, random_state=RNG).fit(Xs)
        lab = km.labels_
        labels_at[k] = lab
        km_rows.append({
            "k": k,
            "silhouette": silhouette_score(Xs[sil_idx], lab[sil_idx]),
            "ARI": adjusted_rand_score(y, lab),
            "NMI": normalized_mutual_info_score(y, lab),
            "inertia": km.inertia_,
        })
        r = km_rows[-1]
        print(f"kmeans k={k:>2}  sil={r['silhouette']:.3f}  ARI={r['ARI']:.3f}  NMI={r['NMI']:.3f}")
    km_df = pd.DataFrame(km_rows)

    print("\ncluster-vs-stage contingency at k=4 (rows=cluster, cols=stage, col-normalized):")
    ct4 = pd.crosstab(labels_at[4], y)[STAGES]
    print((ct4 / ct4.sum(axis=0)).round(2).to_string())

    knn_df.to_csv(OUT / "knn_sweep.csv", index=False)
    km_df.to_csv(OUT / "kmeans_sweep.csv", index=False)
    cm_df.to_csv(OUT / "knn_confusion_bestk.csv")
    ct4.to_csv(OUT / "kmeans_k4_contingency.csv")

    # -- Figures --------------------------------------------------------------
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, 3, figsize=(15, 4))
    ax = axes[0]
    ax.plot(knn_df["k"], knn_df["acc"], "o-", label="accuracy")
    ax.plot(knn_df["k"], knn_df["macro_f1"], "s-", label="macro-F1")
    ax.set_xscale("log"); ax.set_xlabel("k (neighbors)"); ax.set_title("KNN, episode-grouped 5-fold CV")
    ax.grid(alpha=0.3); ax.legend()

    ax = axes[1]
    ax.plot(km_df["k"], km_df["silhouette"], "o-", label="silhouette")
    ax.plot(km_df["k"], km_df["ARI"], "s-", label="ARI vs stages")
    ax.plot(km_df["k"], km_df["NMI"], "^-", label="NMI vs stages")
    ax.set_xlabel("k (clusters)"); ax.set_title("k-means sweep")
    ax.grid(alpha=0.3); ax.legend()

    ax = axes[2]
    cmn = cm_best / cm_best.sum(axis=1, keepdims=True)
    im = ax.imshow(cmn, cmap="Blues", vmin=0, vmax=1)
    ax.set_xticks(range(4), STAGES, rotation=30, ha="right")
    ax.set_yticks(range(4), STAGES)
    for i in range(4):
        for j in range(4):
            ax.text(j, i, f"{cmn[i, j]:.2f}", ha="center", va="center",
                    color="white" if cmn[i, j] > 0.5 else "black")
    ax.set_title(f"KNN row-normalized confusion (k={best[1]})")
    fig.colorbar(im, ax=ax, fraction=0.046)
    fig.tight_layout()
    fig.savefig(OUT / "stage_structure_sweeps.png", dpi=130)

    # Example episode timeline: true stages vs k=4 cluster assignment.
    ep_show = 2
    mask = groups == ep_show
    fig2, ax = plt.subplots(figsize=(12, 3))
    tt = data.loc[mask, "t"].to_numpy()
    stage_num = np.array([STAGES.index(s) for s in y[mask]])
    ax.plot(tt, stage_num, "k-", lw=2, label="true stage")
    ax.plot(tt, labels_at[4][mask], ".", ms=2, alpha=0.5, label="k-means k=4 cluster")
    ax.set_yticks(range(4), STAGES)
    ax.set_xlabel("t (s)"); ax.set_title(f"episode {ep_show}: stages vs k=4 clusters")
    ax.legend(); ax.grid(alpha=0.3)
    fig2.tight_layout()
    fig2.savefig(OUT / "episode_timeline_k4.png", dpi=130)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    sys.exit(main())
