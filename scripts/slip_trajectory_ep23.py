# Zheng's ep23 video verdict: "jaw loosens a bit -> ball slides down a bit,
# then after transport the ball gradually slides down." Question: do the slip
# windows GROUP into phases, or form a LINEAR time-ordered trajectory after
# dimension reduction?
#
# Tests, on ep23 (ep30 as contrast):
#   1. Physical trend at slip events: grip (sum fz), shear angle, and
#      center-of-pressure Y (true mm, from taxel-layouts.ts geometry;
#      +Y = finger long axis) vs event time - Spearman rho. A gradual slide
#      = monotonic CoP drift + decaying grip. A phase grouping = a step.
#   2. Embedding: project the episode's slip windows into PCA fit on all 244
#      corpus slips; correlate PC1/PC2 with event time (linear trajectory?)
#      and score a 2-phase split at the transport anchor (silhouette).

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.decomposition import PCA
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import StandardScaler

from raw_event_knn import ANN, SENS, window_features
from raw_stage_knn import finger_features

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "analysis/raw-event-knn"
EV_RE = re.compile(r"^\[auto:(\w+)\]\s+(\w+)(?:\s+(f\d))?(?:\s+([\d.]+)s)?")
EPS = [23, 30]
HALF = 0.35


def cop_y(fz, ty, valid_mask=None):
    """Positive-mass CoP along the finger (mm): fz-weighted average with
    numerator AND denominator over the same fz>0.05 taxel set. Fixed per
    Jingyi's PR #1 review — the old all-taxel denominator (negatives
    included, post-baseline) made CoP force-dependent: a static contact
    'traveled' as grip decayed."""
    pos = fz > 0.05
    den = (fz * pos).sum(axis=1)
    cop = np.where(den > 0.2,
                   (fz * ty * pos).sum(axis=1) / np.maximum(den, 1e-9),
                   np.nan)
    if valid_mask is not None:
        cop = np.where(valid_mask, cop, np.nan)
    return cop


def taxel_layout_y(n=52):
    # parse [x, y, z] triples for the n-taxel layout out of taxel-layouts.ts
    src = (ROOT / "visualizer/src/lib/taxel-layouts.ts").read_text(encoding="utf-8")
    m = re.search(rf"\b{n}:\s*{{.*?points:\s*\[(.*?)\]\s*,?\s*}}", src, re.S)
    triples = re.findall(r"\[\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\]", m.group(1))
    pts = np.array(triples, float)[:n]
    return pts[:, 1]  # Y, mm, finger long axis


def load_taxels(ep, sensor_file):
    ep_dir = SENS / f"episode_{ep:06d}"
    t0_ns = json.load(open(ep_dir / "alignment.json"))["episode_start_timestamp_ns"]
    df = pd.read_csv(ep_dir / sensor_file).dropna(subset=["calibrated_timestamp_ns"])
    t = (df["calibrated_timestamp_ns"].to_numpy(np.int64) - t0_ns) / 1e9
    cols = df.columns
    fx = df[[c for c in cols if c.startswith("p_") and c.endswith("_fx")]].to_numpy(float)
    fy = df[[c for c in cols if c.startswith("p_") and c.endswith("_fy")]].to_numpy(float)
    fz = df[[c for c in cols if c.startswith("p_") and c.endswith("_fz")]].to_numpy(float)
    base = t < 1.0
    fx -= np.median(fx[base], axis=0)
    fy -= np.median(fy[base], axis=0)
    fz -= np.median(fz[base], axis=0)
    return t, fx, fy, fz


def episode_events(ep):
    slips, anchors = [], {}
    for a in json.load(open(ANN / f"episode_{ep:06d}.json", encoding="utf-8"))["atoms"]:
        if a.get("style") == "subtask":
            anchors[a["content"]] = a["timestamp"]
        elif a.get("style") == "interjection":
            m = EV_RE.match(a["content"])
            if m and m.group(2) == "slip":
                slips.append((a["timestamp"], m.group(3)))
    return sorted(slips), anchors


def main():
    ty = taxel_layout_y()
    print(f"taxel layout: 52 pts, Y span {ty.min():.1f}..{ty.max():.1f} mm\n")

    # PCA basis from ALL corpus slips (same windows as raw_event_knn)
    all_vecs, all_meta = [], []
    for ep in range(63):
        ann = ANN / f"episode_{ep:06d}.json"
        if not ann.exists() or not (SENS / f"episode_{ep:06d}").exists():
            continue
        t0 = json.load(open(SENS / f"episode_{ep:06d}/alignment.json"))["episode_start_timestamp_ns"]
        feats = {"f0": finger_features(SENS / f"episode_{ep:06d}/sensor_1.csv", t0),
                 "f1": finger_features(SENS / f"episode_{ep:06d}/sensor_2.csv", t0)}
        for a in json.load(open(ann, encoding="utf-8"))["atoms"]:
            if a.get("style") != "interjection":
                continue
            m = EV_RE.match(a["content"])
            if m and m.group(2) == "slip":
                v = window_features(feats[m.group(3)], a["timestamp"])
                if v is not None:
                    all_vecs.append(v)
                    all_meta.append((ep, a["timestamp"], m.group(3)))
    Xall = np.vstack(all_vecs)
    sc = StandardScaler().fit(Xall)
    pca = PCA(n_components=2).fit(sc.transform(Xall))
    Pall = pca.transform(sc.transform(Xall))
    meta = pd.DataFrame(all_meta, columns=["episode", "t", "finger"])

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(len(EPS), 3, figsize=(17, 4.8 * len(EPS)))

    for row, ep in enumerate(EPS):
        slips, anchors = episode_events(ep)
        transport = anchors.get("transport", np.nan)
        streams = {"f0": load_taxels(ep, "sensor_1.csv"),
                   "f1": load_taxels(ep, "sensor_2.csv")}

        # per-slip physical summaries on the slipping finger
        rows = []
        for t_ev, fg in slips:
            t, fx, fy, fz = streams[fg]
            w = (t >= t_ev - HALF) & (t <= t_ev + HALF)
            normal = fz[w].sum(axis=1)
            sfx, sfy = fx[w].sum(axis=1), fy[w].sum(axis=1)
            loaded = normal > 0.5
            cop = cop_y(fz[w], ty, valid_mask=loaded)
            rows.append({"t": t_ev, "finger": fg,
                         "grip": normal.mean(),
                         "shear_ang": np.degrees(np.arctan2(np.mean(sfy), np.mean(sfx))),
                         "cop_y": np.nanmean(cop),
                         "dcop": (np.nanmean(cop[-8:]) - np.nanmean(cop[:8]))})
        s = pd.DataFrame(rows)
        print(f"=== ep{ep} ({len(s)} slips, transport anchor {transport:.2f}s) ===")
        print(s.round(2).to_string(index=False))
        for col in ("grip", "cop_y"):
            rho, p = spearmanr(s["t"], s[col])
            print(f"  {col} vs time: spearman rho={rho:+.2f} (p={p:.3f})")
        tot = s["dcop"].sum()
        print(f"  net CoP drift across slip windows: {tot:+.2f} mm")

        # embedding: this episode's slips in corpus-slip PCA
        msk = (meta["episode"] == ep).to_numpy()
        P = Pall[msk]
        tt = meta.loc[msk, "t"].to_numpy()
        r1, p1 = spearmanr(tt, P[:, 0])
        r2, p2 = spearmanr(tt, P[:, 1])
        print(f"  PC1 vs time rho={r1:+.2f} (p={p1:.3f}), PC2 vs time rho={r2:+.2f} (p={p2:.3f})")
        phase = (tt >= transport).astype(int) if np.isfinite(transport) else None
        if phase is not None and 0 < phase.sum() < len(phase):
            sil = silhouette_score(P, phase)
            print(f"  2-phase split at transport: silhouette={sil:+.2f}")
        print()

        # --- plots ---
        fg_main = s["finger"].mode()[0]
        t, fx, fy, fz = streams[fg_main]
        normal = fz.sum(axis=1)
        cop = cop_y(fz, ty, valid_mask=normal > 0.5)
        ax = axes[row, 0]
        ax.plot(t, normal, "C0-", lw=0.8, label=f"grip {fg_main} (N)")
        ax2 = ax.twinx()
        ax2.plot(t, cop, "C3-", lw=0.8, label="CoP y (mm)")
        for t_ev, fg in slips:
            ax.axvline(t_ev, color="gray", alpha=0.4, lw=0.7)
        if np.isfinite(transport):
            ax.axvline(transport, color="green", lw=1.6, ls="--", label="transport")
        ax.set_xlim(max(0, slips[0][0] - 1.5), slips[-1][0] + 1.5)
        ax.set_title(f"ep{ep} {fg_main}: grip + CoP, slip marks")
        ax.legend(loc="upper left", fontsize=8); ax2.legend(loc="upper right", fontsize=8)

        ax = axes[row, 1]
        ax.scatter(Pall[:, 0], Pall[:, 1], s=8, c="lightgray")
        scat = ax.scatter(P[:, 0], P[:, 1], c=tt, cmap="viridis", s=70, edgecolors="k")
        for i in range(len(P) - 1):
            ax.annotate("", xy=P[i + 1, :2], xytext=P[i, :2],
                        arrowprops=dict(arrowstyle="->", color="k", alpha=0.4, lw=0.8))
        fig.colorbar(scat, ax=ax, label="event time (s)")
        ax.set_title(f"ep{ep} slips in corpus-slip PCA (arrows = time order)")

        ax = axes[row, 2]
        ax.scatter(s["t"], s["cop_y"], c="C3", label="CoP y (mm)")
        ax.scatter(s["t"], s["grip"], c="C0", label="grip (N)")
        if np.isfinite(transport):
            ax.axvline(transport, color="green", lw=1.6, ls="--")
        ax.set_xlabel("slip time (s)"); ax.set_title(f"ep{ep}: per-slip grip & CoP vs time")
        ax.legend(fontsize=8); ax.grid(alpha=0.3)

    fig.tight_layout()
    fig.savefig(OUT / "slip_trajectory_ep23_ep30.png", dpi=130)
    print(f"wrote {OUT / 'slip_trajectory_ep23_ep30.png'}")


if __name__ == "__main__":
    sys.exit(main())
