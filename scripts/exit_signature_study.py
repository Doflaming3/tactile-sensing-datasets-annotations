"""Exit-signature study (cycle 4, Zheng's ask, 2026-09-04): is there something
INSIDE the tactile data that tells an uncontrolled loss (drop, squeeze-out,
escape) from a deliberate exit (release, placement) — without the recorded
outcome and without the jaw?

Why: the sustained-slide terminal veto keeps ep23's loosening slide and kills
ep53's / ep50's placing slides correctly, but also kills ep48's escape slide
(11.1 s) because the escape's exit looks, to the success template, like a
place + release. The outcome used to switch the veto off; the detector may no
longer read the outcome. So: learn loss-vs-deliberate from every exit in the
corpus (tactile only), then ask where the exits after the four slides fall.

Three layers, in the order Zheng asked for:
  1. standard statistics on hand-made physical features (loss vs deliberate,
     Mann-Whitney U, class percentiles of the four slide-exits);
  2. KNN on those features, leave-one-episode-out;
  3. small MLP (features, and raw downsampled windows) and a small 1-D CNN on
     the raw windows, leave-one-episode-out.
Also: descriptive per-taxel statistics on the four slide windows themselves.

Inputs: the local sotac mirror (raw 91 Hz sidecar CSVs), the taxel layout
(taxel-layouts.ts) and a detector dump directory (run-detector --json per
episode) for the event list. Tactile only: no jaw, no arm, no outcome.
Outputs: analysis/exit-signature/{report.md, exits.csv}.
Usage: python scripts/exit_signature_study.py <dump-dir>
"""
from __future__ import annotations

import json
import re
import sys
import warnings
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows cp1252 console

import numpy as np
import pandas as pd
from scipy.stats import mannwhitneyu

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
DUMPS = Path(sys.argv[1]) if len(sys.argv) > 1 else None
OUT = ROOT / "analysis" / "exit-signature"
OUT.mkdir(parents=True, exist_ok=True)
RATE = 90.88
PRE_S, POST_S = 1.0, 0.3  # window around an exit
SEED = 0

# ------------------------------------------------------------------ geometry
def taxel_layout(n: int = 52) -> np.ndarray:
    src = (ROOT / "visualizer/src/lib/taxel-layouts.ts").read_text(encoding="utf-8")
    m = re.search(rf"\b{n}:\s*{{.*?points:\s*\[(.*?)\]\s*,?\s*}}", src, re.S)
    if not m:
        raise SystemExit("layout not found")
    trip = re.findall(r"\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]", m.group(1))
    pts = np.array([[float(a), float(b), float(c)] for a, b, c in trip])
    assert len(pts) == n, len(pts)
    return pts

LAYOUT = taxel_layout()
TX, TY = LAYOUT[:, 0], LAYOUT[:, 1]

# ------------------------------------------------------------------ raw data
_cache: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}

def raw_finger(ep: int, finger: int) -> tuple[np.ndarray, np.ndarray]:
    """t (s, logger axis) and F [n, 52, 3] (N) for one finger's sidecar."""
    key = (ep, finger)
    if key in _cache:
        return _cache[key]
    p = ROOT / "data/sotac/sensors/paxini_fingertip" / f"episode_{ep:06d}" / f"sensor_{finger + 1}.csv"
    df = pd.read_csv(p)
    t = (df["timestamp_ns"].to_numpy(float) - df["timestamp_ns"].iloc[0]) / 1e9
    F = np.stack(
        [np.stack([df[f"p_{k:02d}_{ax}"].to_numpy(float) for ax in ("fx", "fy", "fz")], axis=1) for k in range(52)],
        axis=1,
    )
    _cache[key] = (t, F)
    return t, F

# ------------------------------------------------------------------ signals
def channels(t: np.ndarray, F: np.ndarray) -> dict[str, np.ndarray]:
    fz = F[:, :, 2]
    fx, fy = F[:, :, 0], F[:, :, 1]
    fn = fz.sum(axis=1)
    sfx, sfy = fx.sum(axis=1), fy.sum(axis=1)
    fs = np.hypot(sfx, sfy)
    active = (fz > 0).sum(axis=1)
    w = np.where(fz > 0, fz, 0.0)
    m = w.sum(axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        copx = np.where(m > 0.2, (w * TX).sum(axis=1) / m, np.nan)
        copy = np.where(m > 0.2, (w * TY).sum(axis=1) / m, np.nan)
    # spin torque about the CoP (N*mm): z-component of r x f over taxels
    tau = np.zeros(len(t))
    ok = m > 0.2
    rx = TX[None, :] - np.nan_to_num(copx)[:, None]
    ry = TY[None, :] - np.nan_to_num(copy)[:, None]
    tau[ok] = (rx * fy - ry * fx)[ok].sum(axis=1)
    # shear-to-normal ratio (friction-utilisation proxy)
    with np.errstate(invalid="ignore", divide="ignore"):
        mu = np.where(fn > 0.3, fs / fn, np.nan)
    dfs = np.gradient(fs, t, edge_order=1)
    return dict(fn=fn, fs=fs, sfx=sfx, sfy=sfy, active=active.astype(float), copx=copx, copy=copy, tau=tau, mu=mu, dfs=dfs)

def seg(t: np.ndarray, a: float, b: float) -> np.ndarray:
    return (t >= a) & (t <= b)

def slope(t: np.ndarray, y: np.ndarray, mask: np.ndarray) -> float:
    tt, yy = t[mask], y[mask]
    ok = np.isfinite(yy)
    if ok.sum() < 4:
        return np.nan
    return float(np.polyfit(tt[ok], yy[ok], 1)[0])

def nanmean(x):
    x = np.asarray(x, float)
    return float(np.nanmean(x)) if np.isfinite(x).any() else np.nan

def features(ep: int, finger: int, t_exit: float) -> dict[str, float] | None:
    t, F = raw_finger(ep, finger)
    if t_exit - PRE_S < t[0] or t_exit + POST_S > t[-1]:
        return None
    C = channels(t, F)
    w_pre = seg(t, t_exit - PRE_S, t_exit - 0.5)     # hold, 1.0-0.5 s before
    w_near = seg(t, t_exit - 0.5, t_exit - 0.05)     # the last half second
    w_last = seg(t, t_exit - 0.2, t_exit - 0.02)     # the last 0.2 s
    w_post = seg(t, t_exit + 0.05, t_exit + POST_S)  # after the exit
    fn = C["fn"]
    f = {}
    lvl = nanmean(fn[w_pre])
    f["fn_hold_N"] = lvl
    f["fn_near_N"] = nanmean(fn[w_near])
    f["fn_last_N"] = nanmean(fn[w_last])
    f["fn_near_ratio"] = f["fn_near_N"] / lvl if lvl > 0 else np.nan
    f["fn_slope_near_rel"] = slope(t, fn, w_near) / lvl if lvl > 0 else np.nan
    # unload speed: time for fn to fall from 80% to 20% of hold level before the exit
    thr80, thr20 = 0.8 * lvl, 0.2 * lvl
    idx = np.where(seg(t, t_exit - PRE_S, t_exit + POST_S))[0]
    t80 = t20 = np.nan
    for i in idx:
        if np.isnan(t80) and fn[i] <= thr80 and t[i] > t_exit - 0.8:
            t80 = t[i]
        if not np.isnan(t80) and fn[i] <= thr20:
            t20 = t[i]
            break
    f["unload_80to20_s"] = (t20 - t80) if np.isfinite(t80) and np.isfinite(t20) else np.nan
    f["fn_post_N"] = nanmean(fn[w_post])
    # contact spread
    act = C["active"]
    f["active_hold"] = nanmean(act[w_pre])
    f["active_last"] = nanmean(act[w_last])
    f["active_slope_near"] = slope(t, act, w_near)
    # centre of pressure
    cy, cx = C["copy"], C["copx"]
    def travel(c, mask):
        v = c[mask]
        v = v[np.isfinite(v)]
        return (float(v[-1] - v[0]) if len(v) > 3 else np.nan)
    f["copy_travel_near_mm"] = travel(cy, w_near)
    f["copx_travel_near_mm"] = travel(cx, w_near)
    f["cop_speed_near_mm_s"] = slope(t, cy, w_near)
    f["copy_hold_mm"] = nanmean(cy[w_pre])
    # shear
    fs = C["fs"]
    f["fs_hold_N"] = nanmean(fs[w_pre])
    f["fs_near_N"] = nanmean(fs[w_near])
    f["mu_hold"] = nanmean(C["mu"][w_pre])
    f["mu_near"] = nanmean(C["mu"][w_near])
    f["mu_max_near"] = float(np.nanmax(C["mu"][w_near])) if np.isfinite(C["mu"][w_near]).any() else np.nan
    f["mu_slope_near"] = slope(t, C["mu"], w_near)
    # shear direction swing (deg) between hold and the last 0.2 s
    def sdir(mask):
        x, y = nanmean(C["sfx"][mask]), nanmean(C["sfy"][mask])
        return np.degrees(np.arctan2(y, x)) if np.hypot(x, y) > 0.05 else np.nan
    a, b = sdir(w_pre), sdir(w_last)
    f["shear_swing_deg"] = abs(((a - b) + 180) % 360 - 180) if np.isfinite(a) and np.isfinite(b) else np.nan
    # spin torque and hf texture
    f["tau_max_near"] = float(np.nanmax(np.abs(C["tau"][w_near]))) if w_near.any() else np.nan
    f["tau_hold"] = nanmean(np.abs(C["tau"][w_pre]))
    win = max(3, int(round(RATE * 0.11)))
    d2 = np.convolve(C["dfs"] ** 2, np.ones(win) / win, mode="same")
    hf = np.sqrt(d2)
    f["hf_max_near"] = float(np.nanmax(hf[w_near])) if w_near.any() else np.nan
    f["hf_hold"] = nanmean(hf[w_pre])
    # partner finger at this exit
    tp, Fp = raw_finger(ep, 1 - finger)
    Cp = channels(tp, Fp)
    wp_near = seg(tp, t_exit - 0.5, t_exit - 0.05)
    wp_pre = seg(tp, t_exit - PRE_S, t_exit - 0.5)
    wp_post = seg(tp, t_exit + 0.05, t_exit + POST_S)
    f["partner_fn_near_N"] = nanmean(Cp["fn"][wp_near])
    f["partner_fn_post_N"] = nanmean(Cp["fn"][wp_post])
    plvl = nanmean(Cp["fn"][wp_pre])
    f["partner_slope_near_rel"] = slope(tp, Cp["fn"], wp_near) / plvl if plvl > 0.3 else np.nan
    f["partner_mu_near"] = nanmean(Cp["mu"][wp_near])
    return f

def raw_window(ep: int, finger: int, t_exit: float, n_out: int = 40) -> np.ndarray | None:
    """[channels, n_out] raw window for the small models: fn, fs, active,
    copy, |tau|, mu, partner fn — each resampled to n_out samples over
    [t_exit-1.0, t_exit+0.3] and scaled per channel by robust corpus units."""
    t, F = raw_finger(ep, finger)
    if t_exit - PRE_S < t[0] or t_exit + POST_S > t[-1]:
        return None
    C = channels(t, F)
    tp, Fp = raw_finger(ep, 1 - finger)
    Cp = channels(tp, Fp)
    grid = np.linspace(t_exit - PRE_S, t_exit + POST_S, n_out)
    def rs(tt, y):
        y = np.asarray(y, float)
        ok = np.isfinite(y)
        if ok.sum() < 3:
            return np.zeros(n_out)
        return np.interp(grid, tt[ok], y[ok])
    ch = [
        rs(t, C["fn"]) / 5.0,
        rs(t, C["fs"]) / 2.0,
        rs(t, C["active"]) / 20.0,
        rs(t, C["copy"] - np.nanmedian(C["copy"][seg(t, t_exit - PRE_S, t_exit)])) / 3.0,
        rs(t, np.abs(C["tau"])) / 20.0,
        rs(t, np.nan_to_num(C["mu"], nan=0.0)),
        rs(tp, Cp["fn"]) / 5.0,
    ]
    return np.stack(ch, axis=0)

# ------------------------------------------------------------------ events
ATOM_RE = re.compile(r"^\[auto:(\w+)\] (\w+) f(\d)(?: ([\d.]+)s)?(.*)$")

def load_exits(dumps: Path):
    rows = []
    for ep in range(63):
        p = dumps / f"ep_{ep}.json"
        if not p.exists():
            continue
        j = json.load(open(p, encoding="utf-8"))
        weak = [(float(a), float(b)) for a, b in re.findall(r"weak_contact@([\d.]+)-([\d.]+)s", " ".join(j["flags"]))]
        for a in j["atoms"]:
            if a.get("style") != "interjection":
                continue
            m = ATOM_RE.match(a["content"])
            if not m:
                continue
            conf, label, fi, dur, rest = m.groups()
            if label not in ("release", "drop", "finger_unload"):
                continue
            ts = float(a["timestamp"])
            if any(s - 0.05 <= ts <= e + 0.05 for s, e in weak):
                continue  # phantom by calibration
            jm = re.search(r"jaw([+-][\d.]+)u", rest)
            rows.append(dict(ep=ep, finger=int(fi), t=ts, label=label, conf=conf,
                             jaw=float(jm.group(1)) if jm else np.nan))
    return pd.DataFrame(rows)

# gold overrides from video (the escape is labelled "release" by the template)
GOLD_LOSS = {(48, 12.18), (48, 12.2)}

def main():
    if DUMPS is None or not DUMPS.exists():
        raise SystemExit("usage: exit_signature_study.py <dump-dir>")
    ex = load_exits(DUMPS)
    ex["cls"] = np.where(ex["label"] == "drop", "loss", np.where(ex["label"] == "release", "deliberate", "unload"))
    for (ep, ts) in GOLD_LOSS:
        ex.loc[(ex.ep == ep) & (np.abs(ex.t - ts) < 0.03), "cls"] = "loss"
    feats, raws, keep = [], [], []
    for i, r in ex.iterrows():
        f = features(int(r.ep), int(r.finger), float(r.t))
        w = raw_window(int(r.ep), int(r.finger), float(r.t))
        if f is None or w is None:
            continue
        feats.append(f); raws.append(w); keep.append(i)
    ex = ex.loc[keep].reset_index(drop=True)
    X = pd.DataFrame(feats)
    R = np.stack(raws)
    df = pd.concat([ex, X], axis=1)
    df.to_csv(OUT / "exits.csv", index=False)

    lines = []
    P = lines.append
    P("# Exit signature study: loss vs deliberate exit, tactile only\n")
    P(f"Dump: `{DUMPS.name}`. Windows: {PRE_S:.1f} s before to {POST_S:.1f} s after each exit, raw 91 Hz sidecar, both fingers' data, no jaw, no arm, no outcome.\n")
    n = df.cls.value_counts().to_dict()
    P(f"Exits: {len(df)} — {n}. `loss` = detector drops (+ ep48's escape exits 12.18/12.20 by video); `deliberate` = releases; `unload` = finger_unload (reported, not trained on).\n")

    # ---- targets: exits that follow the four slides
    targets = {
        "ep23 loosening slide @10.2 (kept)": [(23, 11.87), (23, 12.01)],
        "ep48 ESCAPE slide @11.1 (vetoed)": [(48, 12.18), (48, 12.2)],
        "ep50 settling slide @10.9 (vetoed)": [(50, 12.18), (50, 13.13)],
        "ep53 placing slide @9.7 (vetoed)": [(53, 10.85), (53, 10.96)],
    }
    def find(ep, ts):
        m = df[(df.ep == ep) & (np.abs(df.t - ts) < 0.03)]
        return m.index[0] if len(m) else None

    # ---- 1. statistics
    P("## 1. Standard statistics (loss vs deliberate)\n")
    P("Median [IQR] per class, Mann-Whitney U p (two-sided), and where the four slide-exits fall as class percentiles (loss-percentile / deliberate-percentile).\n")
    fcols = list(X.columns)
    loss = df[df.cls == "loss"]; dele = df[df.cls == "deliberate"]
    stat_rows = []
    for c in fcols:
        a, b = loss[c].dropna(), dele[c].dropna()
        if len(a) < 5 or len(b) < 5:
            continue
        p = mannwhitneyu(a, b).pvalue
        auc = mannwhitneyu(a, b).statistic / (len(a) * len(b))
        stat_rows.append((c, np.median(a), np.percentile(a, 25), np.percentile(a, 75), np.median(b), np.percentile(b, 25), np.percentile(b, 75), p, auc))
    stat_rows.sort(key=lambda r: r[7])
    P("| feature | loss median [IQR] | deliberate median [IQR] | p | AUC(loss>deliberate) |")
    P("|---|---|---|---|---|")
    for c, ma, qa1, qa3, mb, qb1, qb3, p, auc in stat_rows:
        P(f"| {c} | {ma:.3g} [{qa1:.3g}, {qa3:.3g}] | {mb:.3g} [{qb1:.3g}, {qb3:.3g}] | {p:.2g} | {auc:.2f} |")
    P("")
    top = [r[0] for r in stat_rows[:8]]
    P("Four slide-exits on the eight most separating features (value, then loss-pct / deliberate-pct):\n")
    P("| exit | " + " | ".join(top) + " |")
    P("|---|" + "---|" * len(top))
    for name, lst in targets.items():
        for ep, ts in lst:
            i = find(ep, ts)
            if i is None:
                P(f"| {name} {ts} | (not an exit event in this dump) |")
                continue
            cells = []
            for c in top:
                v = df.loc[i, c]
                if not np.isfinite(v):
                    cells.append("n/a"); continue
                pl = (loss[c].dropna() <= v).mean() * 100
                pd_ = (dele[c].dropna() <= v).mean() * 100
                cells.append(f"{v:.3g} ({pl:.0f}/{pd_:.0f})")
            P(f"| {name} f{df.loc[i,'finger']} @{ts} | " + " | ".join(cells) + " |")
    P("")

    # ---- 2/3. models, leave-one-episode-out
    from sklearn.impute import SimpleImputer
    from sklearn.neighbors import KNeighborsClassifier
    from sklearn.neural_network import MLPClassifier
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.metrics import balanced_accuracy_score, roc_auc_score

    train = df[df.cls.isin(["loss", "deliberate"])].copy()
    y = (train.cls == "loss").astype(int).to_numpy()
    Xf = train[fcols].to_numpy(float)
    Rf = R[train.index.to_numpy()]
    eps = train.ep.to_numpy()

    def loeo(make, Xm):
        pred = np.zeros(len(y), float)
        for e in np.unique(eps):
            tr, te = eps != e, eps == e
            if y[tr].min() == y[tr].max():
                pred[te] = y[tr][0]; continue
            clf = make()
            clf.fit(Xm[tr], y[tr])
            pred[te] = clf.predict_proba(Xm[te])[:, 1]
        return pred

    P("## 2. KNN on the features (leave-one-episode-out)\n")
    P("| model | balanced acc. | ROC-AUC | loss recall | deliberate recall |")
    P("|---|---|---|---|---|")
    results = {}
    def report(name, pred):
        yb = (pred >= 0.5).astype(int)
        ba = balanced_accuracy_score(y, yb)
        auc = roc_auc_score(y, pred) if len(np.unique(y)) > 1 else np.nan
        rl = (yb[y == 1] == 1).mean(); rd = (yb[y == 0] == 0).mean()
        P(f"| {name} | {ba:.2f} | {auc:.2f} | {rl:.2f} | {rd:.2f} |")
        results[name] = pred
    for k in (5, 7, 11):
        pred = loeo(lambda: make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), KNeighborsClassifier(n_neighbors=k, weights="distance")), Xf)
        report(f"KNN k={k}, features", pred)
    P("")
    P("## 3. Small models (leave-one-episode-out)\n")
    P("| model | balanced acc. | ROC-AUC | loss recall | deliberate recall |")
    P("|---|---|---|---|---|")
    mlp_f = lambda: make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), MLPClassifier(hidden_layer_sizes=(32, 16), alpha=1e-2, max_iter=2000, random_state=SEED))
    pred_mlp_f = loeo(mlp_f, Xf); report("MLP 32-16 on features", pred_mlp_f)
    Rflat = Rf.reshape(len(Rf), -1)
    mlp_r = lambda: make_pipeline(StandardScaler(), MLPClassifier(hidden_layer_sizes=(64, 16), alpha=1e-1, max_iter=2000, random_state=SEED))
    pred_mlp_r = loeo(mlp_r, Rflat); report("MLP 64-16 on raw windows (7ch x 40)", pred_mlp_r)

    # 1-D CNN (torch) — tiny, LOEO, class-weighted
    try:
        import torch
        import torch.nn as nn
        torch.manual_seed(SEED)
        class Net(nn.Module):
            def __init__(self, ch):
                super().__init__()
                self.net = nn.Sequential(
                    nn.Conv1d(ch, 16, 5, padding=2), nn.ReLU(), nn.MaxPool1d(2),
                    nn.Conv1d(16, 16, 5, padding=2), nn.ReLU(), nn.AdaptiveAvgPool1d(1),
                    nn.Flatten(), nn.Linear(16, 1))
            def forward(self, x):
                return self.net(x).squeeze(1)
        def cnn_loeo():
            pred = np.zeros(len(y), float)
            Xt = torch.tensor(Rf, dtype=torch.float32)
            yt = torch.tensor(y, dtype=torch.float32)
            for e in np.unique(eps):
                tr = torch.tensor(eps != e); te = ~tr
                if yt[tr].min() == yt[tr].max():
                    pred[te.numpy()] = float(yt[tr][0]); continue
                net = Net(Rf.shape[1])
                pos = float(yt[tr].sum()); neg = float((1 - yt[tr]).sum())
                crit = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(neg / max(pos, 1.0)))
                opt = torch.optim.Adam(net.parameters(), lr=3e-3, weight_decay=1e-3)
                for _ in range(150):
                    opt.zero_grad(); loss_v = crit(net(Xt[tr]), yt[tr]); loss_v.backward(); opt.step()
                with torch.no_grad():
                    pred[te.numpy()] = torch.sigmoid(net(Xt[te])).numpy()
            return pred
        pred_cnn = cnn_loeo(); report("1-D CNN (2 conv x 16) on raw windows", pred_cnn)
    except Exception as e:  # noqa: BLE001
        P(f"| 1-D CNN | skipped: {type(e).__name__}: {e} | | | |")
    P("")

    # ---- the four slide-exits under each model (trained on everything else)
    P("## 4. Where the slide-exits fall (probability of LOSS, model trained on all other episodes)\n")
    P("| exit | " + " | ".join(results.keys()) + " |")
    P("|---|" + "---|" * len(results))
    for name, lst in targets.items():
        for ep, ts in lst:
            i = find(ep, ts)
            if i is None:
                continue
            cells = []
            for mname, _ in results.items():
                tr = train.ep.to_numpy() != ep
                if mname.startswith("KNN"):
                    k = int(re.search(r"k=(\d+)", mname).group(1))
                    clf = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), KNeighborsClassifier(n_neighbors=k, weights="distance")).fit(Xf[tr], y[tr])
                    pr = clf.predict_proba(df.loc[[i], fcols].to_numpy(float))[0, 1]
                elif "features" in mname:
                    clf = mlp_f().fit(Xf[tr], y[tr]); pr = clf.predict_proba(df.loc[[i], fcols].to_numpy(float))[0, 1]
                elif "MLP" in mname:
                    clf = mlp_r().fit(Rflat[tr], y[tr]); pr = clf.predict_proba(R[i].reshape(1, -1))[0, 1]
                else:
                    pr = np.nan  # CNN: LOEO value reported via results when the exit is in the training frame
                    j = np.where(train.index.to_numpy() == i)[0]
                    if len(j):
                        pr = results[mname][j[0]]
                cells.append(f"{pr:.2f}" if np.isfinite(pr) else "n/a")
            P(f"| {name} f{df.loc[i,'finger']} @{ts} (dump label {df.loc[i,'label']}) | " + " | ".join(cells) + " |")
    P("")
    P("Reading: a value near 1 means 'looks like the losses', near 0 'looks like the deliberate releases'. ep48's exits are the only ones whose gold label (loss, by video) disagrees with the template's label (release).\n")

    # ---- 5. the four slide windows themselves
    P("## 5. The four slide windows, per-taxel descriptive statistics\n")
    P("Window: 0.5 s before the flagged slide instant to 1.0 s after, slide finger (from the detector's slide flag) — force trend, contact spread, CoP travel along the finger (+ = toward the fingertip end of the layout), shear-to-normal ratio, partner finger.\n")
    slides = [(23, 0, 10.2, "loosening, kept"), (48, 1, 11.1, "ESCAPE, vetoed"), (50, 1, 10.9, "settling onto bowl, vetoed"), (53, 0, 9.7, "placing, vetoed")]
    P("| slide | fn start→end (N) | active taxels start→end | CoP Y travel (mm) | mu start→max | tau max (N mm) | partner fn start→end (N) |")
    P("|---|---|---|---|---|---|---|")
    for ep, fi, ts, note in slides:
        for finger in (fi, 1 - fi):
            t, F = raw_finger(ep, finger); C = channels(t, F)
            w = seg(t, ts - 0.5, ts + 1.0)
            w0 = seg(t, ts - 0.5, ts - 0.3); w1 = seg(t, ts + 0.8, ts + 1.0)
            cy = C["copy"][w]; cy = cy[np.isfinite(cy)]
            tp, Fp = raw_finger(ep, 1 - finger); Cp = channels(tp, Fp)
            wp0 = seg(tp, ts - 0.5, ts - 0.3); wp1 = seg(tp, ts + 0.8, ts + 1.0)
            tag = f"ep{ep} f{finger}{' (slide finger)' if finger == fi else ''} — {note}"
            P(f"| {tag} | {nanmean(C['fn'][w0]):.1f}→{nanmean(C['fn'][w1]):.1f} | {nanmean(C['active'][w0]):.0f}→{nanmean(C['active'][w1]):.0f} | {(cy[-1]-cy[0]) if len(cy)>3 else np.nan:+.1f} | {nanmean(C['mu'][w0]):.2f}→{np.nanmax(C['mu'][w]) if np.isfinite(C['mu'][w]).any() else np.nan:.2f} | {np.nanmax(np.abs(C['tau'][w])):.0f} | {nanmean(Cp['fn'][wp0]):.1f}→{nanmean(Cp['fn'][wp1]):.1f} |")
    P("")
    (OUT / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))

if __name__ == "__main__":
    main()
