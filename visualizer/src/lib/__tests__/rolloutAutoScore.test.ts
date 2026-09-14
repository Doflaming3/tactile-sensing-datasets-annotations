import { describe, expect, test } from "bun:test";
import {
  isRedPixel,
  isWhitePixel,
  frameFeatures,
  detectBowl,
  decideStages,
  gripperActuated,
  parseAutoLabelCsv,
  type FrameFeatures,
} from "../rolloutAutoScore";

const W = 320;
const H = 240;

/** Blank dark-table frame. */
function blank(): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 30;
    d[i + 1] = 32;
    d[i + 2] = 34;
    d[i + 3] = 255;
  }
  return d;
}

function fillDisk(
  d: Uint8ClampedArray,
  cx: number,
  cy: number,
  r: number,
  rgb: [number, number, number],
) {
  for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const i = (y * W + x) * 4;
      d[i] = rgb[0];
      d[i + 1] = rgb[1];
      d[i + 2] = rgb[2];
    }
  }
}

/** Bright ring (bowl rim). */
function fillRing(
  d: Uint8ClampedArray,
  cx: number,
  cy: number,
  r: number,
  thick: number,
  rgb: [number, number, number],
) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      if (Math.abs(dist - r) > thick) continue;
      const i = (y * W + x) * 4;
      d[i] = rgb[0];
      d[i + 1] = rgb[1];
      d[i + 2] = rgb[2];
    }
  }
}

const RED: [number, number, number] = [200, 30, 25];
const WHITE: [number, number, number] = [230, 228, 225];

describe("pixel classifiers", () => {
  test("red ball pixel passes, table and white arm do not", () => {
    expect(isRedPixel(200, 30, 25)).toBe(true);
    expect(isRedPixel(30, 32, 34)).toBe(false);
    expect(isRedPixel(230, 228, 225)).toBe(false);
    expect(isWhitePixel(230, 228, 225)).toBe(true);
    expect(isWhitePixel(200, 30, 25)).toBe(false);
  });
});

describe("frameFeatures", () => {
  test("finds the ball centroid and area", () => {
    const d = blank();
    fillDisk(d, 100, 120, 8, RED);
    const f = frameFeatures(d, W, H, 1.0, 25);
    expect(f.ballArea).toBeGreaterThan(150);
    expect(f.ballX).toBeCloseTo(100, 0);
    expect(f.ballY).toBeCloseTo(120, 0);
    expect(f.armNearBall).toBe(false);
  });
  test("arm proximity when a white blob sits next to the ball", () => {
    const d = blank();
    fillDisk(d, 100, 120, 8, RED);
    fillDisk(d, 118, 120, 6, WHITE);
    const f = frameFeatures(d, W, H, 1.0, 25);
    expect(f.armNearBall).toBe(true);
  });
  test("no ball -> zero area", () => {
    const f = frameFeatures(blank(), W, H, 0, 25);
    expect(f.ballArea).toBe(0);
  });
});

describe("detectBowl", () => {
  test("finds a rim ring within a few px", () => {
    const d = blank();
    fillRing(d, 220, 90, 36, 1.5, WHITE);
    const bowl = detectBowl(d, W, H);
    expect(bowl).not.toBeNull();
    expect(Math.abs(bowl!.x - 220)).toBeLessThanOrEqual(4);
    expect(Math.abs(bowl!.y - 90)).toBeLessThanOrEqual(4);
    expect(Math.abs(bowl!.r - 36)).toBeLessThanOrEqual(4);
  });
  test("returns null on a blank frame", () => {
    expect(detectBowl(blank(), W, H)).toBeNull();
  });
});

describe("gripperActuated", () => {
  test("detects a close from an open start", () => {
    const pos = [40, 40, 39, 20, 5, 5, 6, 30];
    expect(gripperActuated({ t: pos.map((_, i) => i), pos })).toBe(true);
  });
  test("flat trajectory is not actuation", () => {
    const pos = [40, 40, 41, 40, 39, 40];
    expect(gripperActuated({ t: pos.map((_, i) => i), pos })).toBe(false);
  });
});

describe("decideStages", () => {
  const bowl = { x: 220, y: 90, r: 36, score: 100 };
  const mk = (
    t: number,
    x: number,
    y: number,
    area: number,
    near = false,
  ): FrameFeatures => ({
    t,
    ballX: x,
    ballY: y,
    ballArea: area,
    armNearBall: near,
  });

  test("S5 when the ball ends inside the bowl after a lift", () => {
    const frames = [
      ...Array.from({ length: 10 }, (_, i) => mk(i, 100, 120, 200)),
      ...Array.from({ length: 8 }, (_, i) => mk(10 + i, 150, 105, 260)),
      ...Array.from({ length: 6 }, (_, i) => mk(18 + i, 220, 92, 200)),
    ];
    const r = decideStages(frames, bowl, null, W);
    expect(r.stage).toBe("S5");
    expect(r.suggestedFailure).toBe("F0");
  });

  test("S3 when lifted and passed near the bowl but ended outside", () => {
    const frames = [
      ...Array.from({ length: 10 }, (_, i) => mk(i, 100, 120, 200)),
      ...Array.from({ length: 8 }, (_, i) => mk(10 + i, 200, 110, 260)),
      ...Array.from({ length: 6 }, (_, i) => mk(18 + i, 60, 200, 200)),
    ];
    const r = decideStages(frames, bowl, null, W);
    expect(r.stage).toBe("S3");
    expect(r.suggestedFailure).toBe("F5");
  });

  test("S2 when lifted far from the bowl", () => {
    const frames = [
      ...Array.from({ length: 10 }, (_, i) => mk(i, 60, 200, 200)),
      ...Array.from({ length: 8 }, (_, i) => mk(10 + i, 62, 198, 260)),
      ...Array.from({ length: 6 }, (_, i) => mk(18 + i, 60, 200, 200)),
    ];
    const r = decideStages(frames, bowl, null, W);
    expect(r.stage).toBe("S2");
    expect(r.suggestedFailure).toBe("F4");
  });

  test("S1 when the arm reached the ball but never lifted", () => {
    const frames = [
      ...Array.from({ length: 12 }, (_, i) => mk(i, 100, 120, 200)),
      ...Array.from({ length: 8 }, (_, i) => mk(12 + i, 100, 120, 200, true)),
    ];
    const r = decideStages(frames, bowl, null, W);
    expect(r.stage).toBe("S1");
  });

  test("S0 when nothing happens", () => {
    const frames = Array.from({ length: 20 }, (_, i) => mk(i, 100, 120, 200));
    const r = decideStages(frames, bowl, null, W);
    expect(r.stage).toBe("S0");
    expect(r.suggestedFailure).toBe("F6");
  });

  test("ball never tracked + gripper actuated -> S1/F3", () => {
    const frames = Array.from({ length: 20 }, (_, i) => mk(i, -1, -1, 0));
    const pos = [40, 40, 5, 5, 40];
    const r = decideStages(frames, bowl, { t: pos.map((_, i) => i), pos }, W);
    expect(r.stage).toBe("S1");
    expect(r.suggestedFailure).toBe("F3");
  });

  test("no bowl found caps at S2 and says so", () => {
    const frames = [
      ...Array.from({ length: 10 }, (_, i) => mk(i, 100, 120, 200)),
      ...Array.from({ length: 8 }, (_, i) => mk(10 + i, 200, 100, 260)),
      ...Array.from({ length: 6 }, (_, i) => mk(18 + i, 220, 92, 200)),
    ];
    const r = decideStages(frames, null, null, W);
    expect(r.stage).toBe("S2");
    expect(r.evidence).toContain("bowl not found");
  });
});

describe("parseAutoLabelCsv", () => {
  test("parses episode/stage/scene/failure columns loosely", () => {
    const csv =
      "episode_index,scene,auto_stage,failure_mode,notes\n" +
      "0,1-6,S5_ball_in_bowl,F0_none,clean\n" +
      "1,1-6,S2_grasp,F4_drop_transit,\n" +
      "2,1-2,bogus,,\n";
    const { rows, skipped } = parseAutoLabelCsv(csv);
    expect(rows.length).toBe(2);
    expect(skipped).toBe(1);
    expect(rows[0]).toEqual({
      episode: 0,
      stage: "S5",
      scene: "1-6",
      failure: "F0",
      notes: "clean",
    });
    expect(rows[1].stage).toBe("S2");
    expect(rows[1].failure).toBe("F4");
  });
  test("missing required columns -> nothing imported", () => {
    const { rows } = parseAutoLabelCsv("a,b\n1,2\n");
    expect(rows.length).toBe(0);
  });
});
