# Jingyi's replies on PR A and PR B (verbatim)

Source: the Community pages of her Space (discussions 1 and 2), read
2026-09-07. Everything under "Status" is ours.

## PR #1 (PR A, instruments) — merged

Her only comment before merging: "Thanks!!" Status changed to merged. On
her main it is the squash commit `0a3f2cf` "SoTac annotator improvements:
detector, review UI, artifact screen (#1)".

## PR #2 (PR B, interpretation layer) — merged

---

Merged. One thing I will add myself on main afterwards, no action needed from you: when profile_unverified is set, Save will skip the interpretation layer atoms so template runs can be viewed on a new rig but never committed until a verified profile exists.

Answers to your questions:

Dataset trim: still wanted, after batch auto annotation. No rush, I know you are on another project.
Batch auto annotation: yes, when you get to it.
Reference corpus builder: with the batch tooling is fine.

One more for the list, whenever you get back to this: I want the 0x7C live sensor block recorded as a raw sidecar next to the current 91 Hz logger stream and readable in the raw stream panel. That is the 12 Hall sensors × 3 readings, 36 values at 16× finer resolution than the force block, refreshed as a whole block every 12 ms. It is the device's own 83.3 Hz axis without the logger's duplicate rows, and it is the measurement the 52 force points are reconstructed from, so the slip and hf calibration would finally sit on the honest signal. Log it arrival driven, one row per block change, not on a fixed poll.

I will keep working on main in the meantime, so anything you pick up later, start from main rather than this branch.

---

On her main the PR B content is commit `e3714c1`, on top of `0a3f2cf`;
the PR itself shows "closed" because she rebased rather than pressed merge.

## Status (ours, 2026-09-07)

| her item | state |
|---|---|
| Save skips interpretation-layer atoms when `profile_unverified` | hers, on main, "no action needed" — pick it up when we re-base on her main |
| batch auto-annotation | in PR #3 on her Space (batch commit 7e7bccd + trim commit 0eba4c0 + merge of her main 4e45332; renamed "Batch auto-annotation and dataset trim"), pushed 2026-09-14, still a draft until published; awaiting her review |
| dataset trim | in PR #3 with the batch (second commit); her three census questions are in the PR description |
| reference-corpus builder | open — the one ask left on our side; to be rebuilt on her Hub loaders (script in her Space, or a button on the batch page that commits the corpus into the dataset) |
| 0x7C live sensor block as an arrival-driven raw sidecar, readable in the raw stream panel | the READER she wrote herself (main 5e31def, 2026-09-12: `lib/rawSidecar.ts`, `raw-sidecar-panel.tsx`, `findRawSidecarSessions`) for HER recorder's format — session-long `t_epoch_ns,e0_x…e11_z` (37 columns, relative counts, 0.3–1.2 kHz), `baseline.csv`, `session.json`, under `board_raw/<sensor>/session_<stamp>/` or `live_raw/<name>/session_<stamp>/`, windowed per episode by the 91 Hz CSV's clock. Our `paxini-raw/1` spec is superseded for the visualizer; a recorder on our side should write her layout |
| start from main, not this branch | done: PR #3 carries her main of 2026-09-12 merged in; the workspace is synced to the same tree |
