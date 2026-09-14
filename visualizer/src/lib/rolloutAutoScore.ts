// In-browser automatic rollout scoring — a TypeScript port of the offline
// video scorer's heuristics, run on downscaled top-camera frames:
//
//   ball   red-hue HSV mask -> centroid + pixel area (area rises when the
//          ball is lifted toward the camera)
//   bowl   circle Hough transform on the first frame's gradient edges
//   arm    bright (near-white) mask proximity to the ball centroid
//   grip   gripper joint trajectory (actuation toward closed)
//
// Stage decision (highest wins): S5 ball ends inside the bowl circle;
// S3 lifted and passed near the bowl; S2 lifted; S1 arm reached the ball
// (or the gripper actuated near it); S0 otherwise. S4 (release attempted)
// is not separable automatically — reviewers upgrade S3 by hand.
//
// All functions are pure over RGBA buffers so they unit-test without a DOM.
// Pixel thresholds are expressed at a 640 px reference width and scaled.

export interface BowlCircle {
  x: number;
  y: number;
  r: number;
  score: number; // Hough votes, for confidence reporting
}

export interface FrameFeatures {
  t: number; // seconds, episode-relative
  ballX: number;
  ballY: number;
  ballArea: number; // red pixels at analysis scale (0 = not found)
  armNearBall: boolean;
}

export interface AutoScoreResult {
  stage: "S0" | "S1" | "S2" | "S3" | "S4" | "S5";
  suggestedFailure: string;
  evidence: string; // human-readable, goes into the notes field
  ballSeen: number; // frames with a ball detection
  frames: number;
}

// ---- pixel primitives --------------------------------------------------------

/** Red-ball mask test for one RGBA pixel (two red hue bands, saturated,
 * not too dark) — mirrors the offline scorer's HSV bands. */
export function isRedPixel(r: number, g: number, b: number): boolean {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx < 70) return false; // too dark
  const sat = mx === 0 ? 0 : (mx - mn) / mx;
  if (sat < 0.45) return false; // washed out
  // hue in [0,360): red wraps around 0
  const d = mx - mn;
  let h: number;
  if (mx === r) h = (60 * ((g - b) / d) + 360) % 360;
  else if (mx === g) h = 60 * ((b - r) / d) + 120;
  else h = 60 * ((r - g) / d) + 240;
  return h < 14 || h > 340;
}

/** Bright, low-saturation pixel — the white arm body and gripper. */
export function isWhitePixel(r: number, g: number, b: number): boolean {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx > 175 && mx - mn < 40;
}

/** Ball centroid + area and arm proximity for one frame. */
export function frameFeatures(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  t: number,
  armRadiusPx: number,
): FrameFeatures {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (isRedPixel(rgba[i], rgba[i + 1], rgba[i + 2])) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  if (n < 6) {
    return { t, ballX: -1, ballY: -1, ballArea: 0, armNearBall: false };
  }
  const bx = sx / n;
  const by = sy / n;
  // arm proximity: any white pixel within armRadiusPx of the ball centroid
  const r2 = armRadiusPx * armRadiusPx;
  const x0 = Math.max(0, Math.floor(bx - armRadiusPx));
  const x1 = Math.min(w - 1, Math.ceil(bx + armRadiusPx));
  const y0 = Math.max(0, Math.floor(by - armRadiusPx));
  const y1 = Math.min(h - 1, Math.ceil(by + armRadiusPx));
  let near = false;
  outer: for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - bx;
      const dy = y - by;
      if (dx * dx + dy * dy > r2) continue;
      const i = (y * w + x) * 4;
      if (isWhitePixel(rgba[i], rgba[i + 1], rgba[i + 2])) {
        near = true;
        break outer;
      }
    }
  }
  return { t, ballX: bx, ballY: by, ballArea: n, armNearBall: near };
}

// ---- bowl detection ----------------------------------------------------------

/** Circle Hough on gradient edges. Radius range as a fraction of width
 * (defaults sized for a tabletop bowl seen from the top camera). Returns the
 * best circle, or null when the vote is too weak to trust. */
export function detectBowl(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  rMinFrac = 0.055,
  rMaxFrac = 0.22,
): BowlCircle | null {
  // grayscale
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  // Sobel
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = gray[i - w - 1],
        b = gray[i - w],
        c = gray[i - w + 1];
      const d = gray[i - 1],
        f = gray[i + 1];
      const g = gray[i + w - 1],
        hh = gray[i + w],
        k = gray[i + w + 1];
      const vx = c + 2 * f + k - (a + 2 * d + g);
      const vy = g + 2 * hh + k - (a + 2 * b + c);
      gx[i] = vx;
      gy[i] = vy;
      mag[i] = Math.abs(vx) + Math.abs(vy);
    }
  }
  // edge threshold: keep the strongest ~4% of gradients
  const sorted = Float32Array.from(mag).sort();
  const thr = Math.max(60, sorted[Math.floor(sorted.length * 0.96)]);
  const rMin = Math.max(4, Math.round(w * rMinFrac));
  const rMax = Math.round(w * rMaxFrac);
  const rStep = 2;
  const nR = Math.floor((rMax - rMin) / rStep) + 1;
  const acc = new Int32Array(w * h * nR);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] < thr) continue;
      const m = Math.hypot(gx[i], gy[i]);
      if (m === 0) continue;
      const ux = gx[i] / m;
      const uy = gy[i] / m;
      for (let ri = 0; ri < nR; ri++) {
        const r = rMin + ri * rStep;
        // vote along the gradient in both directions
        for (const s of [1, -1]) {
          const cx = Math.round(x + s * ux * r);
          const cy = Math.round(y + s * uy * r);
          if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
          acc[(cy * w + cx) * nR + ri]++;
        }
      }
    }
  }
  let best = 0;
  let bestIdx = -1;
  for (let i = 0; i < acc.length; i++) {
    if (acc[i] > best) {
      best = acc[i];
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  const ri0 = bestIdx % nR;
  const pix0 = (bestIdx - ri0) / nR;
  const bx = pix0 % w;
  const by = Math.floor(pix0 / w);
  // votes disperse over neighboring (x, y, r) bins from rounding — score and
  // refine over the 3x3x3 neighborhood of the raw argmax
  let sum = 0;
  let wx = 0;
  let wy = 0;
  let wr = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dr = -1; dr <= 1; dr++) {
        const x = bx + dx;
        const y = by + dy;
        const ri = ri0 + dr;
        if (x < 0 || x >= w || y < 0 || y >= h || ri < 0 || ri >= nR) continue;
        const v = acc[(y * w + x) * nR + ri];
        sum += v;
        wx += v * x;
        wy += v * y;
        wr += v * (rMin + ri * rStep);
      }
    }
  }
  const r = sum > 0 ? wr / sum : rMin + ri0 * rStep;
  // confidence: neighborhood votes should cover a reasonable share of the
  // circumference
  const minVotes = Math.max(16, Math.round(2 * Math.PI * r * 0.25));
  if (sum < minVotes) return null;
  return {
    x: Math.round(wx / sum),
    y: Math.round(wy / sum),
    r: Math.round(r),
    score: sum,
  };
}

// ---- gripper -----------------------------------------------------------------

/** True when the gripper trajectory actuates by more than 35% of its own
 * range away from its starting value (a grasp attempt) AND that range is
 * meaningful against the signal's own scale — plain servo noise around a
 * fixed position must not count. */
export function gripperActuated(
  gripper: { t: number[]; pos: number[] } | null,
): boolean {
  if (!gripper || gripper.pos.length < 3) return false;
  const lo = Math.min(...gripper.pos);
  const hi = Math.max(...gripper.pos);
  const range = hi - lo;
  const scale = Math.max(Math.abs(hi), Math.abs(lo));
  if (range <= 1e-9 || scale <= 1e-9) return false;
  if (range < 0.15 * scale) return false; // noise around a held position
  const start = gripper.pos[0];
  return gripper.pos.some((v) => Math.abs(v - start) > 0.35 * range);
}

// ---- stage decision ----------------------------------------------------------

const REF_W = 640; // thresholds below are in pixels at this width
const LIFT_AREA_RATIO = 1.08; // ball area gain when lifted toward the camera
const NEAR_BOWL_PX = 90;
const IN_BOWL_R = 0.85;

export function decideStages(
  frames: FrameFeatures[],
  bowl: BowlCircle | null,
  gripper: { t: number[]; pos: number[] } | null,
  analysisWidth: number,
): AutoScoreResult {
  const scale = analysisWidth / REF_W;
  const seen = frames.filter((f) => f.ballArea > 0);
  const grip = gripperActuated(gripper);
  if (seen.length < 3) {
    return {
      stage: grip ? "S1" : "S0",
      suggestedFailure: grip ? "F3" : "F6",
      evidence:
        `ball not tracked (${seen.length}/${frames.length} frames)` +
        (grip ? "; gripper actuated" : ""),
      ballSeen: seen.length,
      frames: frames.length,
    };
  }
  // baseline area: median of the first up-to-8 detections
  const head = seen
    .slice(0, 8)
    .map((f) => f.ballArea)
    .sort((a, b) => a - b);
  const baseArea = head[Math.floor(head.length / 2)];
  // lifted: sustained area gain over >= 3 consecutive detections
  let liftRun = 0;
  let lifted = false;
  let minBowlDistLifted = Infinity;
  for (const f of seen) {
    if (f.ballArea > LIFT_AREA_RATIO * baseArea) {
      liftRun++;
      if (liftRun >= 3) {
        lifted = true;
        if (bowl) {
          const d = Math.hypot(f.ballX - bowl.x, f.ballY - bowl.y);
          if (d < minBowlDistLifted) minBowlDistLifted = d;
        }
      }
    } else {
      liftRun = 0;
    }
  }
  // final position: median of the last 5 detections
  const tail = seen.slice(-5);
  const fx = tail.map((f) => f.ballX).sort((a, b) => a - b)[
    Math.floor(tail.length / 2)
  ];
  const fy = tail.map((f) => f.ballY).sort((a, b) => a - b)[
    Math.floor(tail.length / 2)
  ];
  const endInBowl =
    bowl != null && Math.hypot(fx - bowl.x, fy - bowl.y) < IN_BOWL_R * bowl.r;
  const nearBowl = lifted && minBowlDistLifted < NEAR_BOWL_PX * scale;
  const reached = seen.some((f) => f.armNearBall) || grip;

  let stage: AutoScoreResult["stage"];
  let fail: string;
  if (endInBowl && lifted) {
    stage = "S5";
    fail = "F0";
  } else if (nearBowl) {
    stage = "S3";
    fail = "F5";
  } else if (lifted) {
    stage = "S2";
    fail = "F4";
  } else if (reached) {
    stage = "S1";
    fail = grip ? "F3" : "F2";
  } else {
    stage = "S0";
    fail = "F6";
  }
  const bits = [
    `ball ${seen.length}/${frames.length} frames`,
    bowl
      ? `bowl (${bowl.x},${bowl.y}) r${bowl.r}`
      : "bowl not found (S3/S5 unavailable)",
    lifted ? `lifted (area > ${LIFT_AREA_RATIO}x base)` : "never lifted",
  ];
  if (lifted && bowl) {
    bits.push(`min bowl dist ${Math.round(minBowlDistLifted)}px`);
  }
  if (grip) bits.push("gripper actuated");
  return {
    stage,
    suggestedFailure: fail,
    evidence: bits.join("; "),
    ballSeen: seen.length,
    frames: frames.length,
  };
}

// ---- CSV import --------------------------------------------------------------

export interface ImportedReview {
  episode: number;
  stage: string;
  scene?: string;
  failure?: string;
  notes?: string;
}

/** Parse an offline scorer CSV. Header must name an episode column and a
 * stage column; scene/failure/notes are optional. Rows with an unknown
 * stage are skipped. Returns rows plus a skipped count. */
export function parseAutoLabelCsv(text: string): {
  rows: ImportedReview[];
  skipped: number;
} {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { rows: [], skipped: 0 };
  const header = lines[0]
    .replace(/^﻿/, "")
    .split(",")
    .map((c) => c.trim().toLowerCase());
  const iEp = header.findIndex((c) => /^(episode|episode_index|ep)$/.test(c));
  const iStage = header.findIndex((c) => /stage/.test(c));
  if (iEp < 0 || iStage < 0) return { rows: [], skipped: lines.length - 1 };
  const iScene = header.findIndex((c) => /scene/.test(c));
  const iFail = header.findIndex((c) => /fail/.test(c));
  const iNotes = header.findIndex((c) => /note/.test(c));
  const rows: ImportedReview[] = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const ep = Number(cols[iEp]);
    const stageRaw = (cols[iStage] ?? "").trim();
    const m = /^S([0-5])/i.exec(stageRaw);
    if (!Number.isInteger(ep) || ep < 0 || !m) {
      skipped++;
      continue;
    }
    const failRaw = iFail >= 0 ? (cols[iFail] ?? "").trim() : "";
    const fm = /^F([0-8])/i.exec(failRaw);
    rows.push({
      episode: ep,
      stage: `S${m[1]}`,
      scene: iScene >= 0 ? (cols[iScene] ?? "").trim() || undefined : undefined,
      failure: fm ? `F${fm[1]}` : undefined,
      notes: iNotes >= 0 ? (cols[iNotes] ?? "").trim() || undefined : undefined,
    });
  }
  return { rows, skipped };
}
