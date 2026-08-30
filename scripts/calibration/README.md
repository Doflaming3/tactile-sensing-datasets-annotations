# Calibration toolkit

The census scripts that derived every Tier-2 constant in
`visualizer/src/lib/eventDetection.ts` (see `analysis/portability.md`
for the rule classification and per-constant margins). **These scripts
ARE the porting procedure**: on a new dataset/rig, check the Tier-3
preconditions, run each census, place every threshold in its measured
margin, then video-verify the members nearest each line.

Run everything from the repo root with bun (TS) or python. All scripts
default to `data/sotac`; company-format data goes through the same
local-mirror layout (see `DATA.md`).

| Script | Calibrates | Output to read |
|---|---|---|
| `exit-audit.ts` | release/drop rules: net-travel threshold + window, closing veto, peel geometry. Prints every terminal with jaw travel split, opening offsets, bout peak, decay, and a rule simulation (`FLIP` lines = label changes under the simulated rule). | classes A–D totals; keep the release/churn margins separated |
| `place-census.ts` | place hygiene (D1–D5): plateau, grip recovery before the finger's terminal, distance to the place_release anchor, air-span membership, terminal kind. | recovery% vs unload-gap margins (sotac: real max 1.43 s vs false min 1.7 s) |
| `jaw-close-survey.ts` | pads-meet threshold (air_grasp) + hold-width range: min jaw position inside every attempt span vs every real hold. | the gap between air-close dwell and the tightest real hold (sotac: 0.5 vs 2.8) |
| `jaw-air-dwell.py` | pads-meet threshold sanity: every sub-threshold jaw dwell corpus-wide. | should list ONLY genuine pad-meet closes |
| `hand-after-drop.ts` | attempt rules: hand-total force and jaw rise after candidate drops (edit `CASES` to the episodes under study). | hand-quiet threshold + jaw-retry rise margins |
| `asym-exits.py` | finger_unload / sensor_residual windows: per-episode finger-exit asymmetry families (EARLY/LATE/TAIL/ONESIDED). Reads `analysis/exit-audit.txt` — produce it first with `bun scripts/calibration/exit-audit.ts > analysis/exit-audit.txt`. | the sync threshold (sotac: sync <0.4 s, asymmetric >=0.95 s) |

Protocol per constant:
1. Run the relevant census on the full corpus.
2. Plot/inspect the two classes the rule must separate; place the
   threshold inside the measured margin, not at either class edge.
3. Hand the members nearest the line to video review (Zheng's loop);
   a verdict against the rule means the rule's PRINCIPLE gets
   re-examined, not just the number.
4. Record the margin and its calibration set in
   `analysis/portability.md`.
