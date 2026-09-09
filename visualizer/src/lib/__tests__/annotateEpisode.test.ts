import { describe, expect, test } from "bun:test";

import type { SensorFramesMap } from "@/app/[org]/[dataset]/[episode]/fetch-data";

import {
  annotateEpisode,
  armSeriesFrom,
  gripperSeriesFrom,
  pickRawFiles,
  rawFileRelPath,
} from "../annotateEpisode";
import { SOTAC_PROFILE } from "../rigProfile";

// The synthetic episode of baseMode.test.ts, as the app would hand it over:
// a sensorFrames map plus flat chart rows carrying the jaw and two arm
// joints. Full mode yields the base events and a failed_attempt span.
const RATE = 30;
const Q = 0.2;

export function syntheticEpisode(withTactile = true): {
  sensorFrames: SensorFramesMap | undefined;
  flatChartData: Record<string, number>[];
} {
  const n = 12 * RATE;
  const frames: unknown[] = [];
  const timestamps: number[] = [];
  const rows: Record<string, number>[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const row: number[][] = Array.from({ length: 16 }, () => [0, 0, 0]);
    if (t >= 5.5 && t < 8) for (let k = 0; k < 12; k++) row[k][2] = Q;
    if (t >= 8) {
      row[1][2] = Q;
      if ((t - 8) % 0.5 < 3 / RATE) for (let k = 0; k < 9; k++) row[k][2] = Q;
    }
    frames.push([row, Array.from({ length: 16 }, () => [0, 0, 0])]);
    timestamps.push(t);
    let p = 40;
    if (t >= 2.5 && t < 3) p = 40 - 40 * (t - 2.5);
    else if (t >= 3 && t < 3.5) p = 20;
    else if (t >= 3.5 && t < 4) p = 20 + 40 * (t - 3.5);
    else if (t >= 5 && t < 5.5) p = 40 - 60 * (t - 5);
    else if (t >= 5.5 && t < 7.9) p = 10;
    else if (t >= 7.9 && t < 8.4) p = 10 + 70 * (t - 7.9);
    else if (t >= 8.4) p = 45;
    rows.push({
      timestamp: t,
      "observation.state | gripper.pos": p,
      "action | gripper.pos": p,
      "observation.state | shoulder_pan.pos": t > 8 ? 10 * (t - 8) : 0,
      "observation.state | elbow_flex.pos": 90,
      "action | shoulder_pan.pos": 0,
    });
  }
  return {
    sensorFrames: withTactile
      ? {
          "observation.sensors.paxini_fingertip": {
            shape: [2, 16, 3],
            frames,
            timestamps,
          },
        }
      : undefined,
    flatChartData: rows,
  };
}

describe("inputs from the flat chart rows", () => {
  const { flatChartData } = syntheticEpisode();
  test("the jaw comes from the observation column, never the action", () => {
    const g = gripperSeriesFrom(flatChartData)!;
    expect(g.t.length).toBe(flatChartData.length);
    expect(g.pos[0]).toBe(40);
    expect(gripperSeriesFrom([])).toBeNull();
  });
  test("the arm excludes the gripper and the action columns", () => {
    const a = armSeriesFrom(flatChartData)!;
    expect(a.joints[0].length).toBe(2);
    expect(armSeriesFrom(undefined)).toBeNull();
  });
});

describe("raw sidecar selection", () => {
  test("per-episode folders, else the unscoped files", () => {
    const all = [
      "sensors/paxini_fingertip/episode_000023/sensor_1.csv",
      "sensors/paxini_fingertip/episode_000023/sensor_2.csv",
      "sensors/paxini_fingertip/episode_000024/sensor_1.csv",
    ];
    expect(pickRawFiles(all, 23)).toEqual(all.slice(0, 2));
    expect(pickRawFiles(all, 99)).toEqual([]);
    expect(pickRawFiles(["sensors/x/sensor_1.csv"], 5)).toEqual([
      "sensors/x/sensor_1.csv",
    ]);
    expect(rawFileRelPath("ep7", "ep7/sensors/x/sensor_1.csv")).toBe(
      "sensors/x/sensor_1.csv",
    );
    expect(rawFileRelPath(null, "sensors/x/sensor_1.csv")).toBe(
      "sensors/x/sensor_1.csv",
    );
  });
});

describe("annotateEpisode", () => {
  const ep = syntheticEpisode();
  const inputs = {
    sensorFrames: ep.sensorFrames,
    gripper: gripperSeriesFrom(ep.flatChartData),
    arm: armSeriesFrom(ep.flatChartData),
  };

  test("runs on the table when no raw sidecar exists, and says so", () => {
    const o = annotateEpisode(inputs, {
      profile: SOTAC_PROFILE,
      episodeIndex: 0,
    });
    expect(o.status).toBe("ok");
    expect(o.source).toBe("table");
    expect(o.rawFallback).toBe(true);
    expect(o.events).toBeGreaterThan(0);
    expect(o.result!.spans.some((s) => s.kind === "failed_attempt")).toBe(true);
    expect(o.recordedAtoms.length).toBeGreaterThan(0);
    expect(
      o.recordedAtoms.every(
        (a) => a.content?.startsWith("[auto:") || a.style === "subtask",
      ),
    ).toBe(true);
  });

  test("table by choice is not a fallback", () => {
    const o = annotateEpisode(inputs, {
      profile: SOTAC_PROFILE,
      episodeIndex: 0,
      useRaw: false,
    });
    expect(o.rawFallback).toBe(false);
    expect(o.source).toBe("table");
  });

  test("no tactile feature: nothing to run on", () => {
    const o = annotateEpisode(
      { ...inputs, sensorFrames: undefined },
      { profile: SOTAC_PROFILE, episodeIndex: 0 },
    );
    expect(o.status).toBe("no_tactile");
    expect(o.result).toBeNull();
    expect(o.recordedAtoms).toEqual([]);
  });
});
