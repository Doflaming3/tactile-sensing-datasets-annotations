# Jingyi's review of PR #3 (batch + trim), verbatim

Source: her comment on the PR, 2026-09-15 18:29 (Hub time), read from the
Community page. Everything under "Status" is ours.

---

Hi Ryan,

Thank you very much for this one. The batch page and the trim executor are both what I had in mind, and the single row group finding is a nice win for the viewer as well. I went through it carefully and I need one more round before merging, mainly because a few paths can quietly delete human annotations for a whole dataset in one commit. Here is what I found, worst first.

**Things that can lose annotations**

1. If the Hub returns a 429 or a 5xx while a worker fetches an episode's annotation file, fetchAnnotationsFromHub returns null just like a missing file. The merge then starts from empty, the episode is staged, and Commit overwrites the Hub copy with detector output only. With four workers fetching in parallel this will happen. Could you return null only on 404 and throw otherwise, so the row shows as failed instead?

2. isAutoAtom treats any subtask atom with the assistant role and one of the four labels as the detector's. The manual subtask add in the panel makes exactly that shape, and so does a detector atom after someone drags its boundary. So a hand corrected grasp boundary gets deleted and re-added at the detector's time on the next batch run, on every episode. The test does not catch it because it builds the human atom with the user role, which the UI never does. I think the detector should tag its own subtask atoms and the predicate should require the tag. Untagged atoms then survive.

3. The batch commit does not send a parentCommit. The run reads each file once inside the worker, and Commit can happen days later from localStorage, so anything committed in between by the single Save or by another person is overwritten for all staged episodes at once. Would you mind recording the branch sha at run start and sending it with the commit, and showing the 412 as "re-run"?

4. The commit button sends readLocalAtoms verbatim, without atomsForSave. If someone on a template profile flips the session opt in and clicks Auto-label inside a staged episode, finger_unload atoms land in the local slot and Commit ships them. The run side applies the rule, the commit side does not.

5. atomsForSave returns everything when the profile is null. The profile is null for a moment on every page load and the Save button is already enabled by then. Please treat null as unverified. The batch page already does.

**Two more to fix**

6. When a worker crashes, the in-flight episode falls back to the main thread, which is right, but the dead slot stays in the pool and becomes the preferred target for the next episode. postMessage to it is a silent no-op and the run freezes. With one worker on a small laptop that is every crash. Mark the slot dead or recreate it, and add a messageerror listener.

7. batch_report.json is written at the repo root but read through the ?root= prefix, so on a rooted dataset it is never found.

**Smaller**

- An empty local copy is not counted as an edit, so an episode someone cleared on purpose gets re-staged.
- Staged episodes show no unsaved pill, since staging sets the saved snapshot. I would rather a proposal read as unsaved until Commit.
- After a commit the rows stay staged, so a second Commit re-sends every file.

**Your three trim questions**

1. The newer cuts came from my detect_cuts.py: joint speed onset and offset at 0.3 deg per frame over sustained motion windows, 10 frame lead and trail, and a tactile contact guard with the per episode 10th percentile baseline removed. I can send it over.
2. Yes, let us re-cut the old 63 by the same rule once this lands.
3. The four sidecar tails can wait for the re-trim.

No changes from me on the executor. The four episode round trip against my own cuts is exactly the right test.

Thank you very much for your help!

---

## Status (ours, 2026-09-15)

Every finding checked against the code: all correct. Fixed 2026-09-15 in
one follow-up commit on PR #3's branch, each with a test
(`reviewRound1.test.ts`, `reviewRound1b.test.ts`; the item-1 and item-2
tests were written red first). Load test against the live Hub
(`scripts/hub-burst-test.ts`): no refusal at up to 64 parallel requests
and 600 requests/s, so item 1 is a logic hole for the rare error, not a
jam; the fix stands.

| # | her finding | fix |
|---|---|---|
| 1 | a 429/5xx on the Hub file reads as "no file" → merge from empty → Commit overwrites | `fetchAnnotationsFromHub`: null on 404 only, throw otherwise; the row fails |
| 2 | `isAutoAtom` takes any assistant subtask with a canonical label, which is also what a manual add or a dragged detector atom looks like | the detector tags its subtask atoms (`origin: "auto"`); the predicate requires the tag; untagged survive. And the merge drops a detector subtask whose label already exists untagged, so legacy files do not get a second set |
| 3 | no `parentCommit`: a Commit days later overwrites whatever landed in between | the run records the branch sha at start (`report.baseSha`); Commit sends it as `parentCommit`; a 412 reads "the dataset moved since the run — re-run" |
| 4 | Commit sends the local copies verbatim, without the save rule | `atomsForSave` applied per entry at commit time, with the active profile |
| 5 | `atomsForSave` returns everything when the profile is null, and Save is enabled before the profile resolves | null = unverified |
| 6 | a crashed worker's slot stays the preferred target; `postMessage` to it is a no-op; the run freezes | the slot is marked dead and skipped; with no live slot the fallback runs directly; `messageerror` handled like a crash |
| 7 | `batch_report.json` written at the root, read through `?root=` | one `batchReportPath()` with the prefix for both |
| s1 | an empty local copy is not an edit | any local copy that differs from the Hub file, the proposal and the marker is an edit, empty included |
| s2 | a staged proposal reads as saved | the annotations context takes the Hub file as the saved snapshot, so a staged (or edited) local copy shows the unsaved pill until Commit / Save |
| s3 | rows stay staged after a commit | after a commit the rows read "committed", the staging markers go, a second Commit has nothing to send |

Trim answers: her `detect_cuts.py` — accept the offer (0.3 deg/frame over
sustained windows, 10-frame lead and trail, tactile contact guard with the
per-episode 10th-percentile baseline removed); match the visualizer's
detector to it once it arrives. Re-cut of the old 63 after the merge; the
four sidecar tails wait for it.

## Cross-check (ours, 2026-09-15, after the round)

Four holes found reading the paths that feed each fix, all closed with
tests: an edit (drag, panel change) now strips the detector's mark, else
a dragged detector atom stayed marked and was still replaced — her item-2
scenario; a 200 whose body is not an annotations file throws instead of
reading as empty; a plain visit no longer writes an empty local copy that
a later run would read as a cleared episode; a worker that stops
answering is given up after 180 s and its job runs on the main thread.
Known limits, stated: unmarked subtasks in the 64 legacy files are treated
as a person's and never refreshed by a run (accepted by her rule); a
dragged detector EVENT keeps its `[auto:…]` label and is still replaced on
a rerun; the single Save has no parent-version check of its own (hers,
untouched here).

## Follow-ups after the round (2026-09-15, same day)

Zheng's questions once the fixes had shipped; two further commits on the
PR #3 branch.

- **A dead worker is terminated and, up to twice, replaced.** Marking a
  crashed or hung worker dead had left its thread alive — the pool held the
  reference, so it kept its memory and, hung, its core, until the page was
  left — and the slot was never replaced, so every later run on the page
  had one worker fewer. Now the worker is terminated on death; a dead slot
  is given a fresh worker when every live one is busy, twice per slot at
  most; a late event from the replaced worker is ignored.
- **Every episode read has a deadline.** A fetch that stalled on the
  worker's fallback, or on the main-thread run without workers, held the
  run forever. One episode's read (fetches and detector together) now has
  three minutes everywhere: inside a worker, which answers with an error
  and lives on (the pool gives up on a thread that cannot even answer a
  minute after that); on the fallback; on the default reader. The row
  fails with "no answer in 180 s" and the run goes on.
