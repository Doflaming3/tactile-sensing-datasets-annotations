# Ground-truth audit: what changed between the episode 0–5 save pairs

2026-08-27. Produced by `scripts/extract_deltas.py` over the preserved
revisions in `data/annotation-history/` (see DATA.md), cross-referenced
against the visualizer Space's git log (`src/lib/eventDetection.ts`,
commit times converted from UTC-4 to UTC).

## Verdict

**The save pairs contain no evidence of human timeline editing.** Every
delta is auto-formatted (`[auto:conf] label finger span`), zero atoms were
moved or text-edited, and each delta pattern matches a detector commit that
landed between the two saves. Episodes 0–5 are regression-test snapshots of
an evolving detector — not human-corrected ground truth. **The dataset
currently contains no annotation ground truth at all.**

## Detector commit timeline (UTC), interleaved with saves

| Time | Event |
|---|---|
| 08-26 23:49 | ep0 save 1 (24 atoms) |
| 08-27 00:09 | `52b4b11` — place persistence check + **place backfill from final force drop** |
| 08-27 00:16 | `bd55a13` — compact event labels, **drop wordy info suffix** |
| 08-27 00:24 | ep0 save 2 (29 atoms) |
| 08-27 00:26 / 00:29 | ep1 save 1 (21), ep2 save 1 (20) |
| 08-27 01:11 | `8c3be6c` — raw parsing: hold last taxel frame over firmware dropouts |
| 08-27 01:17 | `da167ee` — 0.2 s contact-entry debounce ("approach brushes no longer spam contact/drop pairs") |
| 08-27 01:21–01:28 | ep3 (18), ep2 save 2 (15), ep1 save 2 (19), ep4 (16), ep5 (17) |

## Per-pair deltas and their attribution

**ep0 (24→29): +5, −0, 0 moved/modified.** Added: `place f0/f1 0.18s`
(the backfill feature from `52b4b11` — a class absent from save 1) and three
short slips. Every save-1 atom survives bit-for-bit.

**ep1 (21→19): +1, −3.** Deleted: two slips at ~6.1–6.2 s and a
`place f1 0.30s` (consistent with the raw dropout-hold in `8c3be6c`
removing zero-frame-induced false force drops, and the place persistence
check). Added: one `slip f1 0.19s` at the end.

**ep2 (20→15): +1, −6.** Deleted: two `contact_onset`+`drop` pairs
(2.54/2.56 s and 11.94/11.98 s — contact→drop within ~25–45 ms, exactly the
debounce signature from `da167ee`) plus two slips at ~6.4 s. Added: one
`slip f1 0.19s`.

**ep45 control (double-save 19 s apart): identical.** Saving is
deterministic; deltas above are real behavior changes, not noise.

## Consequences for the work plan

1. **T1.1 cannot be "score against episodes 0–5".** Scoring the detector
   against its own output is circular. T1.1 becomes *create* ground truth:
   hand-label a stratified sample of episodes (include some of the 10
   multi-attempt and 6 failure/partial episodes), or get Jingyi's list of
   episodes she has actually eyeball-verified.
2. **T1.2 needs reframing.** The empty `${""}` slot in `resultToAtoms` is
   not an oversight — `bd55a13` deliberately dropped the info suffix for
   compactness. Restoring it verbatim would revert her intentional choice.
   The detail should return as *structured data* (a field on the atom, like
   the existing `camera`/`tool_calls` slots), not as longer content strings.
3. **Question list for Jingyi**: replace "were 0–5 regenerated after the
   debounce fix?" (answer recovered: effectively yes, they track detector
   versions) with "which episodes, if any, have you actually verified by
   hand — and can we hand-label N episodes as the scoring set?"
