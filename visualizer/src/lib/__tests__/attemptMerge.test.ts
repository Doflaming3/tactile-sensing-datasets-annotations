import { describe, expect, test } from "bun:test";

import { mergeAttemptSpans } from "../eventDetection";

// Calibration cases = the census behind the rule (2026-08-31): jaw reopen
// between spans — ep54 0.1u (one grab, merge), ep31 17.4u / ep45 17.2u
// (real retry cycles, keep).
describe("mergeAttemptSpans", () => {
  test("ep54: no reopen between → one span", () => {
    expect(
      mergeAttemptSpans(
        [
          [2.4, 2.4],
          [3.4, 3.4],
        ],
        [0.1],
      ),
    ).toEqual([[2.4, 3.4]]);
  });

  test("ep31: 17.4u reopen → stays two spans", () => {
    expect(
      mergeAttemptSpans(
        [
          [4.3, 5.0],
          [6.6, 7.1],
        ],
        [17.4],
      ),
    ).toEqual([
      [4.3, 5.0],
      [6.6, 7.1],
    ]);
  });

  test("chain of three merges through consecutive quiet gaps", () => {
    expect(
      mergeAttemptSpans(
        [
          [1, 2],
          [3, 4],
          [5, 6],
        ],
        [0.5, 0.2],
      ),
    ).toEqual([[1, 6]]);
  });

  test("mixed: quiet gap merges, reopen splits", () => {
    expect(
      mergeAttemptSpans(
        [
          [1, 2],
          [3, 4],
          [8, 9],
        ],
        [0.5, 12],
      ),
    ).toEqual([
      [1, 4],
      [8, 9],
    ]);
  });
});
