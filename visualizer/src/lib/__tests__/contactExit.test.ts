import { describe, expect, test } from "bun:test";

import {
  buildSeriesFromSensorFrames,
  detectEvents,
  type GripperSeries,
} from "../eventDetection";
import { SOTAC_PROFILE } from "../rigProfile";

// Rule 2 (single-taxel exit floor), shaped like sotac ep37 finger 1: a
// 12-taxel hold at one force quantum each; at tDrop all but `stuck`
// taxels go to zero in one frame while the stuck ones keep reporting one
// quantum for the rest of the episode. One stuck taxel cannot be holding
// anything — the exit must land at the collapse. Two stuck taxels are a
// possible (thin) contact — the floor must stay out of it. The jaw
// re-closes 0.1 s after the collapse (a retry) so rule 1's post-release
// gate is off before the exit debounce elapses and rule 2 alone decides.
const RATE = 91;
const Q = 0.2; // N, sotac's measured quantum
const N_TAXELS = 16;

function makeFrames(
  durS: number,
  tOn: number,
  tDrop: number,
  stuck: number,
): { frames: unknown[]; ts: number[] } {
  const n = Math.round(durS * RATE);
  const frames: unknown[] = [];
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const row: number[][] = [];
    for (let k = 0; k < N_TAXELS; k++) {
      let fz = 0;
      if (t >= tOn && t < tDrop && k < 12) fz = Q;
      if (t >= tDrop && k < stuck) fz = Q;
      // the retry lands: a sustained 12-taxel hold 1.5 s after the collapse,
      // which confirms the re-close as a new grab for rule 1
      if (t >= tDrop + 1.5 && t < tDrop + 2.5 && k < 12) fz = Q;
      row.push([0, 0, fz]);
    }
    // finger 1 idle throughout
    const idle: number[][] = Array.from({ length: N_TAXELS }, () => [0, 0, 0]);
    frames.push([row, idle]);
    ts.push(t);
  }
  return { frames, ts };
}

// jaw: open at 40, closes to 10 over tOn-0.5..tOn, opens to 45 over
// tDrop-0.3..tDrop-0.05 (so the exit reads as a release), then a RETRY:
// closes 6 units at tDrop+0.1 and stays. The retry ends rule 1's
// post-release gate inside the 0.3 s exit debounce, so rule 2 alone
// decides whether the exit lands at the collapse.
function makeGripper(durS: number, tOn: number, tDrop: number): GripperSeries {
  const t: number[] = [];
  const pos: number[] = [];
  for (let i = 0; i < Math.round(durS * 30); i++) {
    const tt = i / 30;
    let p = 40;
    if (tt >= tOn - 0.5 && tt < tOn) p = 40 - 60 * (tt - (tOn - 0.5));
    else if (tt >= tOn && tt < tDrop - 0.3) p = 10;
    else if (tt >= tDrop - 0.3 && tt < tDrop - 0.05)
      p = 10 + 140 * (tt - (tDrop - 0.3));
    else if (tt >= tDrop - 0.05 && tt < tDrop + 0.1) p = 45;
    else if (tt >= tDrop + 0.1) p = 39;
    t.push(tt);
    pos.push(p);
  }
  return { t, pos };
}

function firstExit(stuck: number): number {
  const durS = 12; // room for the two-taxel control's late, force-based exit
  const tOn = 2.0;
  const tDrop = 5.0;
  const { frames, ts } = makeFrames(durS, tOn, tDrop, stuck);
  const gripper = makeGripper(durS, tOn, tDrop);
  const series = buildSeriesFromSensorFrames(
    frames,
    ts,
    null,
    gripper,
    SOTAC_PROFILE,
  );
  expect(series).not.toBeNull();
  expect(series!.quantumN).toBeCloseTo(Q, 6);
  const res = detectEvents(series!, gripper, undefined, undefined, {
    profile: SOTAC_PROFILE,
  });
  const exits = res.events.filter(
    (e) => e.finger === 0 && (e.label === "release" || e.label === "drop"),
  );
  expect(exits.length).toBeGreaterThan(0);
  return exits[0].startS;
}

describe("single-taxel exit floor", () => {
  test("one stuck taxel at a quantum: contact ends at the collapse", () => {
    expect(firstExit(1)).toBeCloseTo(5.0, 1);
  });

  test("two stuck taxels: the floor stays out, exit follows the force", () => {
    // the idle tracker absorbs the two-taxel 0.4 N over ~2 s, so the
    // force-based exit lands well after the collapse — rule 2 must not
    // pull it forward
    expect(firstExit(2)).toBeGreaterThan(6.0);
  });
});
