# How Jingyi trimmed sotac — a census (trim cycle 1)

Her ask (PR #1 review, 2026-09-02): find the dead time from the trajectory
signals ("arm joints static, jaw at rest, no tactile load"), trim it from
every modality in one click, timestamps and frame_index re-based, proposed
cut points on the timeline for the reviewer to adjust, source dataset never
modified, output to a separate repo. Before building that: what did she do
by hand? Every curated episode is a contiguous slice of a raw one, so the
cuts can be read off exactly.

Data: `data/sotac_raw` (pinned `18e0dfed`, raw 0–76) vs `data/sotac`
(pinned `e0fcfeb3`, the old 63) with videos and sidecars; and the tables
only of `Jingyi-Z/sotac` at `7d1afea9` (main, 163) vs `Jingyi-Z/sotac_raw`
at `326fe149` (177) for all 163. Script: `scripts/trim_census.py`
(alignment by exact match of the state+action rows; onset/end detectors;
video and sidecar checks), `scripts/trim_rule_search.py` (which rule
reproduces her cuts). Tables: `analysis/trim-census-old63.csv`,
`analysis/trim-census-all163.csv`.

## Alignment

All 163 curated episodes match one raw episode exactly, as a contiguous
slice. 14 raw episodes were dropped: 2, 3, 5, 9, 10, 12, 20, 23, 62–67.
Rows are re-based: timestamp from 0, frame_index from 0, index contiguous
across the dataset.

Renumbering on main (curated → raw): 0–1 = raw 0–1, 2 = raw 4, 3–5 = raw
6–8, 6–20 = raw 47–61, **21–70 = raw 77–126 (new)**, 71 = raw 11, 72–78 =
raw 13–19, 79–80 = raw 21–22, 81–83 = raw 24–26, 84–92 = raw 68–76, 93–112
= raw 27–46, **113–162 = raw 127–176 (new)**. So the old 63 and the new
100 are interleaved by task; `episode N` on main is not the same recording
as `episode N` at the pin (see DATA.md).

## Two procedures, not one

| | old 63 (raw 0–76) | new 100 (raw 77–176) |
|---|---|---|
| start cut, median (range) | 91 frames = 3.0 s (48–210) | 58 frames = 1.9 s (0–154) |
| end cut, median (max) | 38 frames = 1.3 s (112) | 66 frames = 2.2 s (299) |
| curated length, median | 13.0 s (raw 18.2 s) | 9.9 s (raw 14.7 s) |
| start cut vs arm motion onset | onset − 11 frames, std 17 | onset − 11 to −16 frames, std 6–10 |
| end cut vs arm motion end | end + 3 frames, std 17; 11 episodes cut *before* the arm stopped | end + 16 frames, std 4; 1 early |
| nothing cut at the end | 4 episodes | 0 |
| cut on whole seconds? | no (frame-precise, flat modulo-30 distribution) | no |

**The new 100 were cut by an automatic rule.** Searching onset/end
definitions on the joint signals against her cuts: start = the first frame
where the *commanded* joints (`action`) move faster than 0.2–1 °/frame for
5 frames, minus 11–14 frames (0.4–0.5 s); 68–85 % of her start cuts are
within ±3 frames of that. End = the last frame where the *measured* joints
(`observation.state`) move faster than 0.5 °/frame, plus 16 frames
(0.53 s); 92 % within ±3 frames. Jaw and tactile signals play no part: the
jaw's first motion is 1.5–2.4 s after her cut, the first tactile load
later still. So "arm joints static" is the binding condition of her spec;
"jaw at rest, no tactile load" are implied by it.

**The old 63 were cut more loosely** — by hand, or by an earlier version of
the rule: margins about 0.4 s before the arm moves and 0.1 s after it
stops, with a wider spread, 11 episodes ending before the arm has fully
stopped, and 10 episodes where the arm is not still at the start of the
raw recording (it is settling from the previous reset), where the cut sits
58–120 frames after the first motion — judgment, not the rule.

## What the trim did to each modality (old 63, where the files are local)

- **Videos: re-pointed, not re-encoded.** The 9 mp4 files of sotac are byte
  for byte the same size as sotac_raw's; each episode's
  `videos/<cam>/from_timestamp` moved by exactly the cut. v3's segmented
  video makes the dead frames simply unreferenced. On main the video files
  were rewritten with the renumbering, so this check does not apply there.
- **Sidecars: cut at the start for all 63**, to the frame (the CSV's first
  row sits at the new episode start). **Cut at the end for 59**: the 4
  episodes that got no end cut (curated 0, 2, 3, 4 = raw 0, 4, 6, 7) keep
  sidecars running 31–41 s past the episode end, through the reset. Every
  other sidecar ends within 0.03 s of the episode. This is the residual
  the detector's `clipSeries` has been guarding against.
- **Rows:** timestamps and frame_index re-based, index contiguous.

The new 100's sidecars and videos were not checked (tables only downloaded).

## What this means for the tool

- A cut-point detector = the arm's motion envelope from the joint signals
  with ~0.5 s margins reproduces her recent cuts to within ±3 frames in
  85–92 % of episodes. A proposed cut the reviewer rarely touches is
  realistic; the remaining cases are the ones where the arm is still
  settling at the raw start, which the timeline handles will absorb.
- Re-trimming the old 63 by the same rule would tighten them and fix the 4
  sidecar tails and the 11 early ends. Whether she wants that is her call;
  it shifts every annotation on those episodes by the new start cut.
- Videos need no re-encoding for v3 datasets: re-point the windows, as she
  did. Sidecars are row cuts by time. Annotations shift by the start cut.
- Ground truth for scoring the detector: the new 100 (clean rule); the old
  63 as a second, noisier set.

## Questions for Jingyi

1. Which tool produced the new-100 cuts (a script in `lerobotac`?), and is
   the 0.5 s margin deliberate? Matching it exactly keeps old and new data
   consistent.
2. Should the old 63 be re-cut by the same rule when the tool exists?
3. The 4 sidecar tails (curated 0, 2, 3, 4 at the pin; hub 0, 2, 3, 4 on
   main) — fix in place, or leave until the re-trim?
