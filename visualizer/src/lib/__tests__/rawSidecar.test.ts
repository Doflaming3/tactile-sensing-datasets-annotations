import { describe, expect, test } from "bun:test";
import {
  parseBaselineCsv,
  parseSidecarWindow,
  csvEpochRange,
} from "../rawSidecar";

const HEADER =
  "t_epoch_ns," +
  Array.from({ length: 12 }, (_, i) => `e${i}_x,e${i}_y,e${i}_z`).join(",");

/** Build a sidecar CSV: rows every stepNs from startNs, all elements at
 * `base` counts except element 0, whose z ramps by `ramp` per row. */
function makeCsv(
  startNs: number,
  rows: number,
  stepNs: number,
  base = 100,
  ramp = 0,
): string {
  const lines = [HEADER];
  for (let r = 0; r < rows; r++) {
    const vals: number[] = [];
    for (let e = 0; e < 12; e++) {
      vals.push(base, base, e === 0 ? base + r * ramp : base);
    }
    lines.push(`${startNs + r * stepNs},${vals.join(",")}`);
  }
  return lines.join("\n") + "\n";
}

const BASELINE_CSV =
  "element,x,y,z\n" +
  Array.from({ length: 12 }, (_, i) => `${i},100.00,100.00,100.00`).join("\n") +
  "\n";

describe("parseBaselineCsv", () => {
  test("reads 12 element rows", () => {
    const b = parseBaselineCsv(BASELINE_CSV);
    expect(b).not.toBeNull();
    expect(b!.values.length).toBe(12);
    expect(b!.values[11]).toEqual([100, 100, 100]);
  });
  test("rejects empty input", () => {
    expect(parseBaselineCsv("")).toBeNull();
    expect(parseBaselineCsv("element,x,y,z\n")).toBeNull();
  });
});

describe("parseSidecarWindow", () => {
  const T0 = 1_789_156_423_799_340_000; // realistic epoch ns
  const STEP = 840_000; // ~1190 Hz

  test("windows rows by epoch time and maps to relative seconds", () => {
    const csv = makeCsv(T0, 1000, STEP);
    // keep only rows 100..199 (approximately)
    const lo = T0 + 100 * STEP;
    const hi = T0 + 199 * STEP;
    const w = parseSidecarWindow(csv, lo, hi, T0, null);
    expect(w).not.toBeNull();
    expect(w!.t.length).toBeGreaterThanOrEqual(98);
    expect(w!.t.length).toBeLessThanOrEqual(102);
    expect(w!.t[0]).toBeCloseTo((100 * STEP) / 1e9, 3);
    expect(w!.hz).toBeGreaterThan(1100);
    expect(w!.hz).toBeLessThan(1300);
  });

  test("baseline subtraction zeroes a flat signal", () => {
    const csv = makeCsv(T0, 50, STEP);
    const b = parseBaselineCsv(BASELINE_CSV);
    const w = parseSidecarWindow(csv, T0, T0 + 60 * STEP, T0, b);
    expect(w).not.toBeNull();
    expect(Math.max(...w!.peak)).toBeCloseTo(0, 5);
  });

  test("without baseline the raw counts show through", () => {
    const csv = makeCsv(T0, 50, STEP);
    const w = parseSidecarWindow(csv, T0, T0 + 60 * STEP, T0, null);
    // |(100,100,100)| = 173.2
    expect(w!.mean[0]).toBeCloseTo(Math.hypot(100, 100, 100), 1);
  });

  test("a ramp on one element drives peak but dilutes mean", () => {
    const csv = makeCsv(T0, 50, STEP, 100, 12); // e0_z ramps
    const b = parseBaselineCsv(BASELINE_CSV);
    const w = parseSidecarWindow(csv, T0, T0 + 60 * STEP, T0, b)!;
    const last = w.t.length - 1;
    expect(w.peak[last]).toBeCloseTo(49 * 12, 0);
    expect(w.mean[last]).toBeCloseTo((49 * 12) / 12, 0);
  });

  test("rejects a CSV with the wrong header", () => {
    expect(parseSidecarWindow("time,a,b\n1,2,3\n", 0, 10, 0, null)).toBeNull();
  });
});

describe("csvEpochRange", () => {
  test("reads first and last calibrated timestamps", () => {
    const csv =
      "calibrated_timestamp_ns,fx,fy,fz\n" +
      "1000000000,0,0,0\n2000000000,0,0,0\n3000000000,0,0,0\n";
    expect(csvEpochRange(csv)).toEqual({ first: 1e9, last: 3e9 });
  });
  test("null when the column is missing", () => {
    expect(csvEpochRange("t,fz\n1,2\n3,4\n")).toBeNull();
  });
});
