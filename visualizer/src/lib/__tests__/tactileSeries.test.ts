import { describe, expect, test } from "bun:test";

import {
  applyAdaptiveBaseline,
  buildSeriesFromCorrectedFrames,
  buildSeriesFromSensorFrames,
  buildTableToRawClockMap,
  measureQuantumN,
  parseRawCsvs,
  remapGripperClock,
  type GripperSeries,
} from "../tactileSeries";

// The instrument layer (PR A of Jingyi's split) on synthetic data: every
// number here is constructed, not measured, so each test pins one
// mechanical property of the builders.

const RATE = 30;

/** frames[i][finger][taxel] = [fx, fy, fz] for one finger */
function oneFinger(
  n: number,
  nTaxels: number,
  fill: (i: number, k: number) => [number, number, number],
): { frames: unknown[]; ts: number[] } {
  const frames: unknown[] = [];
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const row: number[][] = [];
    for (let k = 0; k < nTaxels; k++) row.push(fill(i, k));
    frames.push([row]);
    ts.push(i / RATE);
  }
  return { frames, ts };
}

function rawCsv(rows: Array<{ tNs: number; taxels: number[][] }>): string {
  const nT = rows[0].taxels.length;
  const header = ["timestamp_ns", "fx", "fy", "fz"];
  for (let k = 0; k < nT; k++) {
    const p = `p_${String(k).padStart(2, "0")}`;
    header.push(`${p}_fx`, `${p}_fy`, `${p}_fz`);
  }
  const lines = [header.join(",")];
  for (const r of rows) {
    const cols = [String(r.tNs), "0", "0", "0"];
    for (const [fx, fy, fz] of r.taxels) {
      cols.push(fx.toFixed(1), fy.toFixed(1), fz.toFixed(1));
    }
    lines.push(cols.join(","));
  }
  return lines.join("\n");
}

describe("center of pressure (copY fix, Jingyi's blocker 1)", () => {
  test("a static contact stays put as force decays, ghost taxels excluded", () => {
    // two taxels at y = 15 mm carry the load; a ghost taxel at y = 0 sits
    // at -0.5 N (the old all-taxel denominator made copY force-dependent)
    const layout: [number, number, number][] = [
      [-1, 15, 0],
      [1, 15, 0],
      [0, 0, 0],
      [0, 19, 0],
    ];
    const n = 30;
    const corrected: number[][][][] = [];
    const raw: unknown[] = [];
    const ts: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = 2.5 - (1.9 * i) / (n - 1); // 2.5 -> 0.6 N per taxel
      corrected.push([
        [
          [0, 0, a],
          [0, 0, a],
          [0, 0, -0.5],
          [0, 0, 0],
        ],
      ]);
      raw.push(corrected[i]);
      ts.push(i / RATE);
    }
    const s = buildSeriesFromCorrectedFrames(raw, corrected, ts, layout);
    expect(s).not.toBeNull();
    expect(s!.hasLayout).toBe(true);
    const copY = s!.fingers[0].copY!;
    for (let i = 0; i < n; i++) {
      expect(Math.abs(copY[i] - 15)).toBeLessThan(1e-9);
      expect(copY[i]).toBeGreaterThanOrEqual(0);
      expect(copY[i]).toBeLessThanOrEqual(19);
    }
  });
});

describe("drift correction (display convenience; never stored)", () => {
  // taxel 0 carries a 0.4 N standing offset through the whole approach
  // plateau (jaw open until 3 s), which then decays to zero by 4 s while
  // the memorized zero lags; taxel 1 takes a real 3 N load from 4.5 s.
  const n = 6 * RATE;
  const { frames, ts } = oneFinger(n, 3, (i, k) => {
    const t = i / RATE;
    if (k === 0) {
      const fz = t < 3 ? 0.4 : t < 4 ? 0.4 * (4 - t) : 0;
      return [fz > 0 ? 0.3 : 0, 0, fz];
    }
    if (k === 1) return [0, 0, t >= 4.5 ? 3.0 : 0];
    return [0, 0, 0];
  });
  const gripper: GripperSeries = { t: [], pos: [] };
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    gripper.t.push(t);
    gripper.pos.push(t < 3 ? 40 : t < 3.5 ? 40 - 60 * (t - 3) : 10);
  }
  const corr = applyAdaptiveBaseline(frames, ts, gripper, {
    quietMarginN: 1.0,
  })!;
  const at = (t: number) => corr[Math.round(t * RATE)][0];

  test("the plateau median removes a standing offset", () => {
    expect(Math.abs(at(1.0)[0][2])).toBeLessThan(0.05);
  });

  test("subtraction residue is clamped to no contact, shear included", () => {
    // raw 0.08 N against a zero that still remembers ~0.4 N
    expect(at(3.8)[0]).toEqual([0, 0, 0]);
    for (const frame of corr) {
      for (const taxel of frame[0]) expect(taxel[2]).toBeGreaterThanOrEqual(0);
    }
  });

  test("a real load is not absorbed", () => {
    expect(at(5.5)[1][2]).toBeGreaterThan(2.9);
  });
});

describe("raw channels and the force quantum", () => {
  test("quantumN is measured on the raw grid; fnRaw keeps what median-5 flattens", () => {
    const n = 100;
    const { frames, ts } = oneFinger(n, 2, (i, k) => {
      if (k === 0 && i === 50) return [0, 0, 1.0]; // one-frame graze
      if (k === 1 && i >= 10 && i < 20) return [0, 0, 0.2];
      return [0, 0, 0];
    });
    expect(measureQuantumN(frames)).toBe(0.2);
    const s = buildSeriesFromSensorFrames(frames, ts, null, null, {
      quietMarginN: 1.0,
    })!;
    expect(s.quantumN).toBe(0.2);
    expect(s.hasLayout).toBe(false);
    expect(Math.abs(s.rateHz - RATE)).toBeLessThan(0.01);
    const f = s.fingers[0];
    expect(f.fnRaw[50]).toBeCloseTo(1.0, 6);
    expect(f.fn[50]).toBe(0);
    expect(f.rawLoaded![50]).toBe(1);
    expect(Number.isNaN(f.copY![50])).toBe(true);
  });
});

describe("raw sidecar parser (duplicate-row axes)", () => {
  const rows91 = (n: number) =>
    Array.from({ length: n }, (_, r) => ({
      tNs: 1_000_000_000 + r * 11_000_000, // 11 ms = ~91 Hz logger
      taxels: [[0, 0, 0.1 * ((r % 40) + 10)]],
    }));

  test("deviceGridHz keeps the first row per device slot on a uniform axis", () => {
    const parsed = parseRawCsvs([rawCsv(rows91(91))], {
      deviceGridHz: 1000 / 12,
    })!;
    expect(parsed.frames.length).toBe(83); // floor(0.99 / 0.012) + 1
    for (const t of parsed.timestamps) {
      const slots = t / 0.012;
      expect(Math.abs(slots - Math.round(slots))).toBeLessThan(1e-6);
    }
  });

  test("dedupFrames drops byte-identical re-reads only", () => {
    const rows = Array.from({ length: 10 }, (_, r) => ({
      tNs: r * 11_000_000,
      taxels: [[0, 0, 0.2 * (Math.floor(r / 2) + 1)]], // pairs repeat
    }));
    const parsed = parseRawCsvs([rawCsv(rows)], { dedupFrames: true })!;
    expect(parsed.frames.length).toBe(5);
    expect(parseRawCsvs([rawCsv(rows)])!.frames.length).toBe(10);
  });
});

describe("table-to-raw clock map", () => {
  // the raw stream starts 0.5 s before the table; every table frame is a
  // snapshot of the latest raw row at capture
  const rawRows = Array.from({ length: 330 }, (_, r) => ({
    tNs: 5_000_000_000 + r * 11_000_000,
    // unique content per row (the matcher needs a one-to-one signature)
    taxels: [
      [0, 0, 0.1 * ((r % 40) + 10)],
      [0, 0, 0.1 * (Math.floor(r / 40) + 10)],
    ],
  }));
  const csv = rawCsv(rawRows);
  const tableTs: number[] = [];
  const frames: unknown[] = [];
  for (let i = 0; i < 90; i++) {
    const t = i / RATE;
    const r = Math.floor((t + 0.5) / 0.011);
    tableTs.push(t);
    frames.push([rawRows[r].taxels.map((x) => [...x])]);
  }

  test("recovers the offset by content matching", () => {
    const map = buildTableToRawClockMap(frames, tableTs, [csv]);
    expect(map).not.toBeNull();
    expect(Math.abs(map!(1.0) - 1.5)).toBeLessThan(0.012);
    expect(Math.abs(map!(2.0) - 2.5)).toBeLessThan(0.012);
    const g = remapGripperClock({ t: [1.0, 2.0], pos: [40, 10] }, map);
    expect(Math.abs(g!.t[0] - 1.5)).toBeLessThan(0.012);
    expect(remapGripperClock({ t: [1.0], pos: [40] }, null)!.t[0]).toBe(1.0);
  });

  test("returns null without contact to match on", () => {
    const empty = frames.map(() => [
      [
        [0, 0, 0],
        [0, 0, 0],
      ],
    ]);
    expect(buildTableToRawClockMap(empty, tableTs, [csv])).toBeNull();
  });
});
