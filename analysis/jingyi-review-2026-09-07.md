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
| batch auto-annotation | built 2026-09-09 (workspace): a dataset-level batch page (`/{org}/{dataset}/batch`) runs every episode, merges with the Hub files, stages the proposals into the browser for click-through review, triage list, one-commit save with a batch report; PR D from her main after Zheng's test |
| dataset trim | still wanted, after batch; no rush |
| reference-corpus builder | ships with the batch tooling |
| 0x7C live sensor block as an arrival-driven raw sidecar, readable in the raw stream panel | new; two halves: the recorder (her data-collection side) and the reader (the visualizer's raw stream panel + later the slip/hf calibration on that axis) |
| start from main, not this branch | our vendored tree must be re-based on her main (`e3714c1` today) before any new work |
