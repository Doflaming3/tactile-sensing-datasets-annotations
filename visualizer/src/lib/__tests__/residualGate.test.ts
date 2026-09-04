import { describe, expect, test } from "bun:test";

import { applyAdaptiveBaseline, type GripperSeries } from "../eventDetection";

// Rule 1 (post-release residual gate), shaped like sotac ep37 finger 1:
// a 12-taxel hold at one quantum each, the ball leaves at tDrop (11
// taxels zero in one frame), then taxel #1 stays stuck at one quantum and
// the released set bursts back for 3 frames every 0.5 s. The corrected
// frames must be empty after the release; a sustained re-touch and a
// retry (jaw re-close) must NOT be masked; a start-of-episode stuck
// taxel is masked while a sustained table touch is not.
const RATE = 30;
const Q = 0.2;
const N_TAXELS = 16;

type Scenario = {
  durS: number;
  tOn: number;
  tDrop: number;
  retouch?: [number, number]; // sustained 8-taxel load
  startStuck?: boolean; // taxel #1 stuck at one quantum from 0.5 s to tOn
  tableTouch?: [number, number]; // 7 taxels (1.4 N) sustained, pre-grasp
  recloseAt?: number; // jaw closes 6 units here (retry) and stays
  dip?: [number, number]; // hold thins to 3 taxels (0.6 N) in this window
  thinGraze?: [number, number]; // 3 taxels at one quantum, pre-grasp
};

function frames(sc: Scenario): { frames: unknown[]; ts: number[] } {
  const n = Math.round(sc.durS * RATE);
  const out: unknown[] = [];
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const row: number[][] = Array.from({ length: N_TAXELS }, () => [0, 0, 0]);
    if (t >= sc.tOn && t < sc.tDrop) {
      const thin = sc.dip && t >= sc.dip[0] && t < sc.dip[1];
      for (let k = 0; k < (thin ? 3 : 12); k++) row[k][2] = Q;
    }
    if (t >= sc.tDrop) {
      row[1][2] = Q; // stuck
      const phase = (t - sc.tDrop) % 0.5;
      if (phase < 3 / RATE) {
        for (let k = 0; k < 9; k++) row[k][2] = Q; // burst
      }
    }
    if (sc.retouch && t >= sc.retouch[0] && t < sc.retouch[1]) {
      for (let k = 4; k < 12; k++) row[k][2] = Q;
    }
    if (sc.startStuck && t >= 0.5 && t < sc.tOn) row[1][2] = Q;
    if (sc.tableTouch && t >= sc.tableTouch[0] && t < sc.tableTouch[1]) {
      for (let k = 0; k < 7; k++) row[k][2] = Q;
    }
    if (sc.thinGraze && t >= sc.thinGraze[0] && t < sc.thinGraze[1]) {
      for (let k = 0; k < 3; k++) row[k][2] = Q;
    }
    const idle: number[][] = Array.from({ length: N_TAXELS }, () => [0, 0, 0]);
    out.push([row, idle]);
    ts.push(t);
  }
  return { frames: out, ts };
}

function gripper(sc: Scenario): GripperSeries {
  const t: number[] = [];
  const pos: number[] = [];
  for (let i = 0; i < Math.round(sc.durS * RATE); i++) {
    const tt = i / RATE;
    let p = 40;
    if (tt >= sc.tOn - 0.5 && tt < sc.tOn) p = 40 - 60 * (tt - (sc.tOn - 0.5));
    else if (tt >= sc.tOn && tt < sc.tDrop - 0.1) p = 10;
    else if (tt >= sc.tDrop - 0.1 && tt < sc.tDrop + 0.4)
      p = 10 + 70 * (tt - (sc.tDrop - 0.1));
    else if (tt >= sc.tDrop + 0.4) p = 45;
    if (sc.recloseAt !== undefined && tt >= sc.recloseAt) p = 39;
    t.push(tt);
    pos.push(p);
  }
  return { t, pos };
}

function fingerSum(sc: Scenario): (t: number) => number {
  const { frames: fr, ts } = frames(sc);
  const corr = applyAdaptiveBaseline(fr, ts, gripper(sc));
  expect(corr).not.toBeNull();
  return (tq: number) => {
    let i = 0;
    for (let k = 0; k < ts.length; k++) {
      if (Math.abs(ts[k] - tq) < Math.abs(ts[i] - tq)) i = k;
    }
    return corr![i][0].reduce((a, tx) => a + tx[2], 0);
  };
}

const base: Scenario = { durS: 10, tOn: 2.0, tDrop: 5.0 };

describe("post-release residual gate", () => {
  test("stuck taxel and bursts vanish after the release", () => {
    const at = fingerSum(base);
    expect(at(3.5)).toBeGreaterThan(2.0); // the hold survives
    // 5.55 and 7.03 sit inside bursts, the rest on the stuck taxel alone
    for (const tq of [5.2, 5.55, 6.2, 6.52, 7.03, 8.5, 9.9]) {
      expect(at(tq)).toBe(0);
    }
  });

  test("a sustained re-touch is visible from its first frame", () => {
    const at = fingerSum({ ...base, retouch: [7.0, 8.0] });
    expect(at(7.03)).toBeGreaterThan(1.0);
    expect(at(7.5)).toBeGreaterThan(1.0);
    expect(at(6.5)).toBe(0); // still masked before it
  });

  test("a retry (jaw re-close) ends the gate when a new hold follows", () => {
    const at = fingerSum({ ...base, recloseAt: 7.0, retouch: [8.0, 9.0] });
    expect(at(6.0)).toBe(0);
    expect(at(7.53)).toBeGreaterThan(0); // the burst at 7.5 now passes
  });

  test("a post-task reset close with nothing in hand keeps the gate", () => {
    const at = fingerSum({ ...base, recloseAt: 7.0 });
    expect(at(7.53)).toBe(0);
    expect(at(9.9)).toBe(0);
  });

  test("pre-grasp: a start stuck taxel is refused, a 7-taxel table touch is not", () => {
    const stuck = fingerSum({ ...base, startStuck: true });
    expect(stuck(1.0)).toBe(0);
    const touch = fingerSum({ ...base, tableTouch: [0.8, 1.4] });
    expect(touch(1.0)).toBeGreaterThan(1.0);
  });

  test("pre-grasp: a 3-taxel graze while the jaw is closing stays visible", () => {
    // the jaw closes from 1.5 s; a thin 3-taxel touch at 1.7-1.8 s is a
    // grab's first frames, not residual
    const at = fingerSum({ ...base, thinGraze: [1.7, 1.8] });
    expect(at(1.75)).toBeGreaterThan(0);
  });

  test("a mid-hold dip is not an exit: the re-grip stays visible", () => {
    // hold 2-5 s at 2.4 N, thins to 3 taxels (0.6 N) for 0.5 s at 3.5 s,
    // back to 12 taxels; the release only comes at 5 s
    const at = fingerSum({ ...base, dip: [3.5, 4.0] });
    expect(at(3.7)).toBeGreaterThan(0); // the dip itself is real signal
    expect(at(4.5)).toBeGreaterThan(2.0); // the re-grip is not masked
    expect(at(6.0)).toBe(0); // the real release still arms the gate
  });
});
