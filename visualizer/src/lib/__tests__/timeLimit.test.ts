import { describe, expect, test } from "bun:test";

import { withTimeout } from "../timeLimit";

const after = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("withTimeout", () => {
  test("work that finishes in time passes through, value or error", async () => {
    expect(await withTimeout(after(5, 7), 200, "late")).toBe(7);
    await expect(
      withTimeout(Promise.reject(new Error("its own error")), 200, "late"),
    ).rejects.toThrow("its own error");
  });

  test("work that does not finish in time rejects with the message", async () => {
    const never = new Promise<number>(() => {});
    const t0 = performance.now();
    await expect(withTimeout(never, 20, "no answer")).rejects.toThrow(
      "no answer",
    );
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test("no limit means waiting", async () => {
    expect(await withTimeout(after(30, "slow"), 0, "late")).toBe("slow");
  });
});
