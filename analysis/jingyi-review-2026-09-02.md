# Jingyi's review of PR #1 (verbatim)

Source: the Community page of PR #1 on her Space
(`huggingface.co/spaces/Jingyi-Z/lerobotac-dataset-visualizer`, discussion 1),
comment by `Jingyi-Z` (Owner), 2026-09-02. Copied verbatim from the page
text captured that day so that later cycles work from her words, not from a
summary. Everything under "Status" is ours.

---

Thanks, the method work and the provenance on the constants are strong. Tests pass, tsc is clean, no conflicts with main. Not merging as one PR yet. Three blockers, then please split it.

Blockers

copY is not a center of pressure. eventDetection.ts:588-598 sums fz*y over taxels with fz > 0.05 but divides by the sum over all taxels. With the adaptive baseline making negative fz routine, the ratio becomes force dependent. On the 52 taxel layout with a fixed contact at y = 15 mm, reported copY goes from 17 mm at 5 N to 29 mm at 1.2 N. The pad ends at 19.3 mm. A static contact decaying 2.6 to 1.2 N shows about 5.7 mm of fake travel against SLIDE_MIN_MM = 2.0, so sustained_slide sits on an artifact. Fix the denominator, assert copY inside the layout range, re-derive ep23 and ep48, re-check rotationTauNmm.

Drift correction reached the display with no toggle. tactile-panel.tsx:125-154 renders applyAdaptiveBaseline output in the arrows, timeline and stats with no label. I use this view to audit vendor zero point and drift, so it must default to raw, corrected view behind a labelled toggle. Please also do not let this correction leak into anything downstream of the dataset: the initial zero is a median over the approach plateau up to the first jaw close, which reads the episode's future, so a policy cannot reproduce it at deployment. The real fix is a recorder side re-zero at every episode start, which your notes already call for. Until the vendor ships that, the detector can keep the adaptive tracker, but the stored data and the default view stay raw.

weak_contact deletion is finger blind. resultToRecordedAtoms:2793-2801 drops every saved atom in the window by timestamp, while the span is computed from one finger at 2147-2156. So when finger 0 holds at 8 N and finger 1 only grazes at 1.5 N, finger 1's weak_contact span deletes finger 0's contact_onset, grasp_stable and lift from the saved file. Rule for the save path: when the two fingers disagree, keep both records. A span computed from one finger may only remove that finger's atoms, never the partner's. Carry the finger index on the span, drop only matching atoms, and return spans as structured objects rather than regex parsing toFixed(1) strings. Also reconcile BRIEF_CONTACT_STRONG_N = 2.0 with WEAK_ATTEMPT_MAX_N = 2.3, since between them one rule rescues a contact only for the other to delete it.

Before the second PR merges

context.result changes output (2500-2517, 2657-2698), so the 56/59 agreement is partly circular. Remove the result argument from detectEvents entirely. Sotac is the first and only dataset with hand annotations, and it exists to check the detector. Every dataset from here on arrives with no labels and is reviewed by a human only after auto annotation, so the visualizer must not contain any evaluation against ground truth. Keep that in the offline scripts.

Jaw unit and Newton constants (RELEASE_TRAVEL_MIN, AIR_CLOSE_POS, WEAK_ATTEMPT_MAX_N and others) are SO-101 plus one specific parallel gripper plus one 52 taxel pad. Future datasets will come from other arms, and even SO-101 rigs will carry different grippers, so none of these numbers transfer. Move them into DetectionThresholds with a per dataset profile, and refuse to run the attempt and phantom layer when no profile is supplied rather than falling back to sotac values.

Emit no_layout, no_gripper, no_arm flags instead of silently losing rotation, slip and slide. Same reason as above: future datasets will carry other sensors and other taxel layouts, not only the twelve Paxini tables. When resolveTaxelLayout returns null the detector must say so in the output, and the per dataset profile should be able to supply a layout the same way it supplies thresholds.

Drop tsconfig.tsbuildinfo, it is a build cache that changes on every compile and belongs in .gitignore. screen-reference.json is 328 KB of feature vectors extracted from sotac, and the signal screen runs KNN against it on every dataset. The script that generates it, scripts/build-screen-reference.ts, is referenced by .prettierignore but not included, so nobody can rebuild it for another sensor or rig. Either add the script, or move the corpus out of src and load it from the per dataset profile like the layout and thresholds.

Keep as is

The clock map, deviceGridHz, and the 91 Hz logger over 83 Hz device finding. I will pass that one to the vendor.

Split

PR A: clock map, deviceGridHz, copY fix, raw channels, display toggle, capability flags. Mergeable after 1 and 2.

PR B: event taxonomy, attempts, phantom and residual logic, hesitation, signal screen. Behind a per dataset opt in and out of the default save path.

Two additions for PR B, if not too much trouble

Dataset trim. Use the trajectory signals (arm joints static, jaw at rest, no tactile load) to find the dead time before each recording actually starts and after it ends, then trim it from every modality in one click: video frames, depth, tactile, raw sidecar CSVs, and the parquet rows, with timestamps and frame_index re-based so the episode still loads. Show the proposed cut points on the timeline first so the reviewer can adjust them. The source dataset is never modified: raw recordings stay where they are (sotac_raw), and the trimmed and annotated output is written to a separate dataset repo (sotac), the same split we use today.

Batch auto annotation. Run the detector over every episode of a dataset and save all annotations to the Hub in one commit, with a progress view and a list of episodes that failed or raised flags so the reviewer knows where to look first.

---

## Status (ours, 2026-09-04)

| her item | where | state |
|---|---|---|
| Blocker 1, copY denominator + on-pad invariant | cycle 1, df51942 | done, corpus bit-identical |
| Blocker 2, display defaults raw, correction behind a labelled toggle, never stored | cycle 2, 9d9d5f0 (+ be22e16, f7b35e4) | done |
| Blocker 3, finger-scoped deletion, structured spans, 2.0 vs 2.3 reconciled | cycle 3, 2ab63df | done (PR B, save path) |
| remove `context.result` from `detectEvents` | cycle 4, 48f84ed | done; evaluation lives in the runner |
| rig constants into a per-dataset profile; refuse to run without one | cycle 5, 15f189b | done as a profile; Zheng's ruling: a TEMPLATE with a reminder and a `profile_unverified` flag instead of a hard refusal |
| `no_layout` / `no_gripper` / `no_arm` flags | cycle 5 | done |
| profile can supply a taxel layout | — | open (PR B) |
| drop `tsconfig.tsbuildinfo` | cycle 6, 27ef038 | ignore line in the Space tree; drops out of the assembled PRs |
| ship `build-screen-reference.ts` or move the corpus into the profile | cycles 5–6, B1 | corpus out of `src`: `public/screen-reference/`, named by the profile's path, fetched by the app / read by the runner, out of the bundle; builder still workspace-only (her "or") |
| PR B out of the default save path, behind a per-dataset opt-in | — | open (PR B) |
| split into PR A / PR B | cycle 7 | 7a: instrument module split (this commit); 7b: PR A assembly |
| dataset trim, batch auto-annotation | — | PR B round (ask whether trim is still needed: she trimmed Jingming's episodes herself) |
