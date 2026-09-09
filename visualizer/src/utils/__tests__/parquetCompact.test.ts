import { describe, expect, test } from "bun:test";

import { compactRows, materializeRows } from "../parquetUtils";

const taxels = (seed: number) =>
  Array.from({ length: 2 }, (_, f) =>
    Array.from({ length: 52 }, (_, i) =>
      Array.from({ length: 3 }, (_, k) =>
        Math.fround(seed + f * 100 + i + k / 10),
      ),
    ),
  );

describe("compact decoded rows", () => {
  test("fixed-shape numeric arrays become typed arrays and come back intact", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      index: BigInt(i),
      timestamp: i / 30,
      task_index: 0n,
      "observation.state": [1, 2, 3, 4, 5, i],
      "observation.sensors.paxini_fingertip": taxels(i),
      language_events: i === 2 ? [{ content: "x" }] : null,
    }));
    const columns = Object.keys(rows[0]);
    const compact = compactRows(
      rows,
      columns,
      new Set(["observation.sensors.paxini_fingertip"]),
    );
    const sensors = compact.columns.get(
      "observation.sensors.paxini_fingertip",
    )!;
    expect(sensors.kind).toBe("typed");
    if (sensors.kind === "typed") {
      expect(sensors.shape).toEqual([2, 52, 3]);
      expect(sensors.stride).toBe(312);
      expect(sensors.data).toBeInstanceOf(Float32Array);
      expect(sensors.data.length).toBe(5 * 312);
    }
    const state = compact.columns.get("observation.state")!;
    expect(state.kind).toBe("typed");
    if (state.kind === "typed") expect(state.data).toBeInstanceOf(Float64Array);
    // scalars, BigInt and the sparse struct column stay plain
    for (const name of ["index", "timestamp", "task_index", "language_events"])
      expect(compact.columns.get(name)!.kind).toBe("plain");

    const back = materializeRows(compact, 1, 4);
    expect(back.length).toBe(3);
    expect(back[0]).toEqual(rows[1]);
    expect(back[2]).toEqual(rows[3]);
    // fresh objects each time
    expect(materializeRows(compact, 1, 2)[0]).not.toBe(back[0]);
    expect(materializeRows(compact, 4, 99).length).toBe(1);
    expect(materializeRows(compact, 9, 12)).toEqual([]);
  });

  test("a ragged or partly null array column stays plain", () => {
    const rows = [
      {
        a: [1, 2, 3],
        b: [1, 2],
        c: [
          [1, 2],
          [3, 4],
        ],
      },
      { a: [1, 2], b: null, c: [[1, 2], [3]] },
      {
        a: [1, 2, 3],
        b: [3, 4],
        c: [
          [1, 2],
          [3, 4],
        ],
      },
    ];
    const compact = compactRows(rows, ["a", "b", "c"]);
    expect(compact.columns.get("a")!.kind).toBe("plain");
    expect(compact.columns.get("b")!.kind).toBe("plain");
    expect(compact.columns.get("c")!.kind).toBe("plain");
    expect(materializeRows(compact, 0, 3)).toEqual(rows);
  });

  test("columns default to the first row's keys; an empty table is fine", () => {
    const compact = compactRows([{ x: [1, 2] }, { x: [3, 4] }], []);
    expect([...compact.columns.keys()]).toEqual(["x"]);
    expect(materializeRows(compact, 0, 2)).toEqual([
      { x: [1, 2] },
      { x: [3, 4] },
    ]);
    const empty = compactRows([], ["x"]);
    expect(empty.nRows).toBe(0);
    expect(materializeRows(empty, 0, 1)).toEqual([]);
  });
});
