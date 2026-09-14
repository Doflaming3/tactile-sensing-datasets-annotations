import { describe, expect, test } from "bun:test";
import {
  ROLLOUT_STAGES,
  SUCCESS_STAGE_ID,
  isRolloutRepoName,
  wilsonInterval,
  summarizeRolloutReviews,
  emptyRolloutReviews,
  type RolloutReview,
} from "../rolloutReview";

const review = (
  stage: string,
  scene?: string,
  failure = stage === SUCCESS_STAGE_ID ? "F0" : "F8",
): RolloutReview => ({
  stage,
  score: ROLLOUT_STAGES.find((s) => s.id === stage)!.score,
  failure,
  scene,
  reviewed_at: "2026-09-12T00:00:00Z",
});

describe("isRolloutRepoName", () => {
  test("matches rollout eval repos, not training repos", () => {
    expect(isRolloutRepoName("Jingyi-Z/rollout_eval_A_71ep")).toBe(true);
    expect(isRolloutRepoName("org/My-Rollout-Set")).toBe(true);
    expect(isRolloutRepoName("Jingyi-Z/sotac_ball_71ep")).toBe(false);
  });
});

describe("wilsonInterval", () => {
  test("n=0 gives [0,0]", () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 0]);
  });
  test("19/30 gives the known 46-78% interval", () => {
    const [lo, hi] = wilsonInterval(19, 30);
    expect(lo).toBeCloseTo(0.455, 2);
    expect(hi).toBeCloseTo(0.78, 2);
  });
  test("0/30 stays clamped at 0", () => {
    const [lo, hi] = wilsonInterval(0, 30);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(0);
    expect(hi).toBeLessThan(0.2);
  });
  test("bounds stay inside [0,1]", () => {
    const [lo, hi] = wilsonInterval(30, 30);
    expect(lo).toBeGreaterThan(0.8);
    expect(hi).toBe(1);
  });
});

describe("summarizeRolloutReviews", () => {
  test("empty file summarizes to zeros", () => {
    const s = summarizeRolloutReviews(emptyRolloutReviews());
    expect(s.reviewed).toBe(0);
    expect(s.successes).toBe(0);
    expect(s.scenes).toEqual([]);
  });

  test("counts successes, mean score, failures and scenes", () => {
    const reviews = emptyRolloutReviews();
    reviews.episodes["0"] = review("S5", "1-6");
    reviews.episodes["1"] = review("S5", "1-6");
    reviews.episodes["2"] = review("S2", "1-6", "F4");
    reviews.episodes["3"] = review("S1", "1-2", "F2");
    reviews.episodes["4"] = review("S3", undefined, "F4");
    const s = summarizeRolloutReviews(reviews);
    expect(s.reviewed).toBe(5);
    expect(s.successes).toBe(2);
    expect(s.successRate).toBeCloseTo(0.4, 5);
    // (1 + 1 + 0.4 + 0.2 + 0.7) / 5
    expect(s.meanScore).toBeCloseTo(0.66, 5);
    expect(s.failures).toEqual([
      { id: "F4", n: 2 },
      { id: "F2", n: 1 },
    ]);
    const byScene = Object.fromEntries(s.scenes.map((x) => [x.scene, x]));
    expect(byScene["1-6"].n).toBe(3);
    expect(byScene["1-6"].successes).toBe(2);
    expect(byScene["1-2"].n).toBe(1);
    expect(byScene["(no scene)"].n).toBe(1);
  });

  test("scene sort is numeric-aware", () => {
    const reviews = emptyRolloutReviews();
    reviews.episodes["0"] = review("S0", "1-10", "F6");
    reviews.episodes["1"] = review("S0", "1-2", "F6");
    const s = summarizeRolloutReviews(reviews);
    expect(s.scenes.map((x) => x.scene)).toEqual(["1-2", "1-10"]);
  });
});
