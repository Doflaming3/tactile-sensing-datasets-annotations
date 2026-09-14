// Rollout review model: per-episode outcome annotation for evaluation
// (rollout) datasets, saved to the dataset repo as one aggregated JSON file
// (`annotations/rollout_reviews.json`) so the summary needs a single fetch —
// same pattern as review_status.json.
//
// Rubric: the reviewer picks the HIGHEST stage the policy reached (each stage
// carries a fixed progress score), one primary failure mode, and a free-text
// scene label (e.g. "1-6" for bowl at point 1, ball at point 6). An episode
// counts as a success iff it reached the final stage.

import { getDatasetPathPrefix } from "./versionUtils";
import { hubResolveUrl } from "./repoRef";
import { getAuthToken } from "./auth";
import { commitJsonFileToHub } from "./hubCommit";

const HUB = "https://huggingface.co";

export interface StageDef {
  id: string;
  label: string;
  score: number;
}

/** Progress stages, lowest to highest. Highest stage reached wins. */
export const ROLLOUT_STAGES: StageDef[] = [
  { id: "S0", label: "no progress / freeze", score: 0 },
  { id: "S1", label: "reached the object", score: 0.2 },
  { id: "S2", label: "grasped (lifted)", score: 0.4 },
  { id: "S3", label: "transported toward target", score: 0.7 },
  { id: "S4", label: "release attempted at target", score: 0.8 },
  { id: "S5", label: "success (object in target)", score: 1.0 },
];

export const SUCCESS_STAGE_ID = "S5";

export interface FailureDef {
  id: string;
  label: string;
}

/** Primary failure mode — one per episode; F0 for clean successes. */
export const ROLLOUT_FAILURES: FailureDef[] = [
  { id: "F0", label: "none" },
  { id: "F1", label: "overreach" },
  { id: "F2", label: "underreach" },
  { id: "F3", label: "bad grasp pose" },
  { id: "F4", label: "dropped in transit" },
  { id: "F5", label: "missed target at release" },
  { id: "F6", label: "freeze / no attempt" },
  { id: "F7", label: "collision" },
  { id: "F8", label: "other" },
];

export interface RolloutReview {
  stage: string; // stage id, e.g. "S5"
  score: number; // the stage's progress score
  failure: string; // failure id, e.g. "F0"
  scene?: string; // free-text scene label, e.g. "1-6"
  notes?: string;
  reviewed_at: string; // ISO timestamp
  /** "auto" = machine-scored (in-browser tracker or imported CSV), not yet
   * confirmed by a person; "human" = entered or confirmed by a reviewer.
   * Absent on entries saved before this field existed — treated as human. */
  source?: "auto" | "human";
}

export function stageScore(stageId: string): number {
  return ROLLOUT_STAGES.find((s) => s.id === stageId)?.score ?? 0;
}

export interface RolloutReviews {
  schema_version: 1;
  episodes: Record<string, RolloutReview>;
}

export function emptyRolloutReviews(): RolloutReviews {
  return { schema_version: 1, episodes: {} };
}

export function rolloutReviewsPath(): string {
  return `${getDatasetPathPrefix()}annotations/rollout_reviews.json`;
}

/** True when the repo id looks like a rollout / evaluation dataset. The
 * panel additionally treats any dataset that already has a reviews file as
 * a rollout dataset, so this heuristic only gates first-time use. */
export function isRolloutRepoName(repoId: string): boolean {
  return /rollout/i.test(repoId);
}

/** Fetch the aggregated reviews file. Returns null when it does not exist
 * (never reviewed) — callers use that to distinguish "no file" from "empty". */
export async function fetchRolloutReviews(
  repoId: string,
): Promise<RolloutReviews | null> {
  const token = getAuthToken();
  try {
    const res = await fetch(
      hubResolveUrl(`${HUB}/datasets`, repoId, rolloutReviewsPath()),
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as RolloutReviews;
    return j && typeof j === "object" && j.episodes ? j : null;
  } catch {
    return null;
  }
}

/** Save (or clear, with review=null) one episode's review and commit the
 * updated aggregated file. Re-fetches before writing so concurrent reviewers
 * lose at most their own episode. Returns the committed file. */
export async function saveRolloutReview(
  repoId: string,
  episodeId: number,
  review: RolloutReview | null,
): Promise<RolloutReviews> {
  const current = (await fetchRolloutReviews(repoId)) ?? emptyRolloutReviews();
  const key = String(episodeId);
  if (review) {
    current.episodes[key] = review;
  } else {
    delete current.episodes[key];
  }
  await commitJsonFileToHub(
    repoId,
    rolloutReviewsPath(),
    current,
    review
      ? `rollout review: episode ${episodeId} ${review.stage}/${review.failure}` +
          (review.scene ? ` scene ${review.scene}` : "")
      : `rollout review: episode ${episodeId} cleared`,
  );
  return current;
}

/** Bulk-merge machine-scored reviews (CSV import or batch auto-scoring) and
 * commit once. Entries whose episode already has a HUMAN review are skipped
 * unless overwriteHuman is set; auto entries are always replaced. Returns
 * the committed file and the number of entries written. */
export async function saveRolloutReviewsBulk(
  repoId: string,
  entries: Array<{
    episode: number;
    stage: string;
    scene?: string;
    failure?: string;
    notes?: string;
  }>,
  summary: string,
  overwriteHuman = false,
): Promise<{ reviews: RolloutReviews; written: number; kept: number }> {
  const current = (await fetchRolloutReviews(repoId)) ?? emptyRolloutReviews();
  let written = 0;
  let kept = 0;
  const now = new Date().toISOString();
  for (const e of entries) {
    const key = String(e.episode);
    const existing = current.episodes[key];
    if (existing && existing.source !== "auto" && !overwriteHuman) {
      kept++;
      continue;
    }
    current.episodes[key] = {
      stage: e.stage,
      score: stageScore(e.stage),
      failure: e.failure ?? (e.stage === SUCCESS_STAGE_ID ? "F0" : "F8"),
      scene: e.scene,
      notes: e.notes,
      reviewed_at: now,
      source: "auto",
    };
    written++;
  }
  if (written > 0) {
    await commitJsonFileToHub(repoId, rolloutReviewsPath(), current, summary);
  }
  return { reviews: current, written, kept };
}

/** Wilson 95% score interval for k successes out of n. */
export function wilsonInterval(
  k: number,
  n: number,
  z = 1.96,
): [number, number] {
  if (n <= 0) return [0, 0];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [
    Math.max(0, (center - half) / denom),
    Math.min(1, (center + half) / denom),
  ];
}

export interface SceneSummary {
  scene: string;
  n: number;
  successes: number;
  meanScore: number;
}

export interface RolloutSummary {
  reviewed: number;
  /** machine-scored entries not yet confirmed by a person */
  autoUnconfirmed: number;
  successes: number;
  successRate: number;
  ci95: [number, number];
  meanScore: number;
  failures: Array<{ id: string; n: number }>;
  scenes: SceneSummary[];
}

export function summarizeRolloutReviews(
  reviews: RolloutReviews,
): RolloutSummary {
  const all = Object.values(reviews.episodes);
  const n = all.length;
  const successes = all.filter((r) => r.stage === SUCCESS_STAGE_ID).length;
  const meanScore = n ? all.reduce((s, r) => s + (r.score ?? 0), 0) / n : 0;
  const failCounts = new Map<string, number>();
  for (const r of all) {
    if (r.failure && r.failure !== "F0") {
      failCounts.set(r.failure, (failCounts.get(r.failure) ?? 0) + 1);
    }
  }
  const failures = [...failCounts.entries()]
    .map(([id, cnt]) => ({ id, n: cnt }))
    .sort((a, b) => b.n - a.n);
  const sceneMap = new Map<string, RolloutReview[]>();
  for (const r of all) {
    const s = (r.scene ?? "").trim() || "(no scene)";
    const arr = sceneMap.get(s) ?? [];
    arr.push(r);
    sceneMap.set(s, arr);
  }
  const scenes: SceneSummary[] = [...sceneMap.entries()]
    .map(([scene, rs]) => ({
      scene,
      n: rs.length,
      successes: rs.filter((r) => r.stage === SUCCESS_STAGE_ID).length,
      meanScore: rs.reduce((s, r) => s + (r.score ?? 0), 0) / rs.length,
    }))
    .sort((a, b) =>
      a.scene.localeCompare(b.scene, undefined, { numeric: true }),
    );
  return {
    reviewed: n,
    autoUnconfirmed: all.filter((r) => r.source === "auto").length,
    successes,
    successRate: n ? successes / n : 0,
    ci95: wilsonInterval(successes, n),
    meanScore,
    failures,
    scenes,
  };
}
