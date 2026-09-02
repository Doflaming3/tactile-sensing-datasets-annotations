"use client";

// PXSR-style tactile sensor panel: one 3D view per fingertip/taxel channel,
// a contact timeline (click to seek), and per-channel stats.
//
// Rendering notes:
// * Arrows use drei <Segments> (three.js Line2 "fat lines") because
//   LineBasicMaterial.linewidth is ignored by WebGL -- plain lines are always
//   1px and effectively invisible.
// * Arrow LENGTH is normalized: direction comes from the force vector, length
//   = clamp(|F|/forceMax, 0.18, 1) * maxLen. A 0.3 N touch is a short but
//   clearly visible needle; magnitude is also encoded in the color ramp.
// * Playback-synced via TimeContext; the timeline seeks through it too.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, Segments, Segment } from "@react-three/drei";
import * as THREE from "three";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  Legend,
} from "recharts";
import { useTime } from "@/context/time-context";
import { resolveTaxelLayout } from "@/lib/taxel-layouts";
import {
  applyAdaptiveBaseline,
  type GripperSeries,
} from "@/lib/eventDetection";
import RawStreamPanel from "@/components/raw-stream-panel";
import {
  computeFolderTactileAggregate,
  type FolderTactileRow,
} from "@/utils/folderStats";
import type { SensorFramesMap } from "@/app/[org]/[dataset]/[episode]/fetch-data";

const CONTACT_THR_N = 0.05;
const CHANNEL_COLORS = ["#38bdf8", "#a78bfa", "#34d399", "#f472b6"];

// ---- force colormap (PXSR-like) -------------------------------------------

const STOPS: [number, [number, number, number]][] = [
  [0.0, [0, 180, 40]],
  [0.4, [235, 235, 0]],
  [0.7, [245, 140, 0]],
  [1.0, [220, 0, 0]],
];

function forceColor(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [t0, c0] = STOPS[i];
    const [t1, c1] = STOPS[i + 1];
    if (x <= t1) {
      const f = t1 === t0 ? 0 : (x - t0) / (t1 - t0);
      return [
        (c0[0] + (c1[0] - c0[0]) * f) / 255,
        (c0[1] + (c1[1] - c0[1]) * f) / 255,
        (c0[2] + (c1[2] - c0[2]) * f) / 255,
      ];
    }
  }
  return [STOPS[STOPS.length - 1][1][0] / 255, 0, 0];
}

function forceColorCss(t: number): string {
  const [r, g, b] = forceColor(t);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

// ---- channel extraction -----------------------------------------------------

type Channel = {
  label: string;
  nPoints: number;
  at: (fi: number) => number[][];
  timestamps: number[];
};

function expandChannels(
  name: string,
  shape: number[],
  frames: unknown[],
  timestamps: number[],
): Channel[] {
  const short = name.replace("observation.sensors.", "");
  if (shape.length === 2) {
    return [
      {
        label: short,
        nPoints: shape[0],
        timestamps,
        at: (fi) => frames[fi] as number[][],
      },
    ];
  }
  if (shape.length === 3 && shape[0] <= 4) {
    return Array.from({ length: shape[0] }, (_, k) => ({
      label: `${short}[${k}]`,
      nPoints: shape[1],
      timestamps,
      at: (fi: number) => (frames[fi] as number[][][])[k],
    }));
  }
  if (shape.length === 3) {
    return [
      {
        label: short,
        nPoints: shape[1],
        timestamps,
        at: (fi) => {
          const buf = frames[fi] as number[][][];
          return buf[buf.length - 1];
        },
      },
    ];
  }
  return [];
}

// ---- display mode: RAW by default (Jingyi's PR #1 review, blocker 2) -------
// The tactile displays are the audit surface for vendor zero points and
// drift, so they must show what the sensor reported. The auto-labeler's
// adaptive drift correction is available for the DISPLAY as an explicit,
// labelled, session-only opt-in: one shared switch flips every tactile view
// (arrows, timeline, stats, tiles) at once. Deliberately NOT persisted —
// a reload always returns to raw, so the audit default can never silently
// become the corrected view. The detector itself keeps using the correction
// internally (approved in review); stored data is never modified either way.
let driftCorrectedView = false;
const driftViewSubs = new Set<() => void>();

function setDriftCorrectedView(v: boolean) {
  driftCorrectedView = v;
  driftViewSubs.forEach((cb) => cb());
}

function useDriftCorrectedView(): boolean {
  return useSyncExternalStore(
    (cb) => {
      driftViewSubs.add(cb);
      return () => driftViewSubs.delete(cb);
    },
    () => driftCorrectedView,
    () => false,
  );
}

const DRIFT_TOGGLE_TITLE =
  "Default is RAW sensor output (for auditing vendor zero points and " +
  "drift). Turning this on applies the auto-labeler's adaptive baseline " +
  "to the DISPLAY only — one switch flips every tactile view; saved data " +
  "is never modified; resets to raw on reload.";

function DriftViewToggle({ compact = false }: { compact?: boolean }) {
  const corrected = useDriftCorrectedView();
  if (compact) {
    return (
      <button
        type="button"
        title={DRIFT_TOGGLE_TITLE}
        onClick={() => setDriftCorrectedView(!corrected)}
        className={`px-1.5 rounded border text-[10px] ${
          corrected
            ? "border-amber-500/50 text-amber-300 bg-amber-500/10"
            : "border-slate-600/60 text-slate-400"
        }`}
      >
        {corrected ? "view: corrected" : "view: raw"}
      </button>
    );
  }
  return (
    <label
      className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer"
      title={DRIFT_TOGGLE_TITLE}
    >
      <input
        type="checkbox"
        checked={corrected}
        onChange={(e) => setDriftCorrectedView(e.target.checked)}
      />
      drift-corrected view (display only)
    </label>
  );
}

function channelsFrom(
  sensorFrames: SensorFramesMap,
  gripper?: GripperSeries | null,
  corrected = false,
): Channel[] {
  const out: Channel[] = [];
  for (const [name, sf] of Object.entries(sensorFrames)) {
    let frames = sf.frames;
    if (corrected) {
      // opt-in only — see the display-mode note above. Buffered (N,P,3)
      // history shapes are left raw; (F,P,3) and (P,3) are corrected.
      // After correction, taxels whose fz went NEGATIVE (signal decayed
      // below the captured baseline — routine on drift fingers) claim no
      // contact and are zeroed for display: rendering the negative
      // residual as an arrow fabricates force the sensor never reported
      // (Zheng's catch, ep47 @16s: corrected view showed a cluster where
      // raw showed nothing).
      const clampNeg = (fr: unknown[]): unknown[] =>
        fr.map((frame) =>
          (frame as number[][][]).map((finger) =>
            finger.map((p) => (Number(p[2]) <= 0 ? [0, 0, 0] : p)),
          ),
        );
      try {
        if (sf.shape.length === 3 && sf.shape[0] <= 4) {
          const corr = applyAdaptiveBaseline(
            sf.frames,
            sf.timestamps,
            gripper,
          ) as unknown[] | null;
          if (corr) frames = clampNeg(corr);
        } else if (sf.shape.length === 2) {
          const wrapped = sf.frames.map((fr) => [fr]);
          const corr = applyAdaptiveBaseline(wrapped, sf.timestamps, gripper);
          if (corr)
            frames = clampNeg(corr).map((fr) => (fr as number[][][])[0]);
        }
      } catch {
        frames = sf.frames; // raw beats a crashed panel
      }
    }
    out.push(...expandChannels(name, sf.shape, frames, sf.timestamps));
  }
  return out.filter((c) => resolveTaxelLayout(c.nPoints));
}

function frameIndexFor(ts: number[], currentTime: number, fps: number): number {
  let fi = Math.min(ts.length - 1, Math.max(0, Math.round(currentTime * fps)));
  if (
    ts.length > 1 &&
    (ts[fi] === undefined || Math.abs(ts[fi] - currentTime) > 1.5 / fps)
  ) {
    let lo = 0,
      hi = ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts[mid] <= currentTime) lo = mid;
      else hi = mid - 1;
    }
    fi = lo;
  }
  return fi;
}

// ---- 3D scene for one channel ----------------------------------------------

type ArrowSeg = {
  start: [number, number, number];
  end: [number, number, number];
  color: string;
};

/** Frames the taxel cloud to fill the canvas at ANY aspect ratio / zoom:
 * camera distance is computed from the layout bounding box and the live
 * viewport aspect, re-fit on every resize. Replaces the old fixed camera,
 * which left dead space and off-center pads on wide or zoomed canvases. */
function FitCamera({ points }: { points: [number, number, number][] }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const ctrls = useThree((s) => s.controls);
  useEffect(() => {
    if (!points.length) return;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (const [x, y, z] of points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    // margin for force arrows around the pad
    const halfW = ((maxX - minX) / 2) * 1.45 + 3;
    const halfH = ((maxY - minY) / 2) * 1.3 + 3;
    const aspect = size.width / Math.max(size.height, 1);
    const vTan = Math.tan((camera.fov * Math.PI) / 360);
    const dist = Math.max(halfH / vTan, halfW / (vTan * aspect)) + maxZ;
    camera.aspect = aspect;
    camera.position.set(cx, cy + dist * 0.28, dist);
    camera.lookAt(cx, cy, 0);
    camera.updateProjectionMatrix();
    // Keep OrbitControls (makeDefault) orbiting around the pad center,
    // otherwise it re-targets the origin and undoes the framing.
    const controls = ctrls as unknown as {
      target?: { set: (x: number, y: number, z: number) => void };
      update?: () => void;
    } | null;
    if (controls?.target) {
      controls.target.set(cx, cy, 0);
      controls.update?.();
    }
  }, [points, size.width, size.height, camera, ctrls]);
  return null;
}

function ChannelScene({
  channel,
  frameIdx,
  maxLen,
  forceMax,
}: {
  channel: Channel;
  frameIdx: number;
  maxLen: number;
  forceMax: number;
}) {
  const layout = resolveTaxelLayout(channel.nPoints);

  const anatomy = useMemo(() => {
    if (!layout) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(layout.points.flat()), 3),
    );
    return new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: 0x969ba5,
        size: 2.5,
        sizeAttenuation: false,
      }),
    );
  }, [layout]);

  const { dots, segs } = useMemo(() => {
    if (!layout) return { dots: null, segs: [] as ArrowSeg[] };
    const forces = channel.at(frameIdx) ?? [];
    const dotPos: number[] = [];
    const dotCol: number[] = [];
    const segs: ArrowSeg[] = [];
    const n = Math.min(forces.length, layout.points.length);
    for (let i = 0; i < n; i++) {
      const fx = Number(forces[i][0]);
      const fy = Number(forces[i][1]);
      const fz = Number(forces[i][2]);
      const mag = Math.hypot(fx, fy, fz);
      if (mag < CONTACT_THR_N) continue;
      const [x, y, z] = layout.points[i];
      const t = mag / forceMax;
      dotPos.push(x, y, z);
      dotCol.push(...forceColor(t));
      // normalized direction, visibility-clamped length
      const len = Math.max(0.18, Math.min(1, t)) * maxLen;
      const inv = len / mag;
      segs.push({
        start: [x, y, z],
        end: [x + fx * inv, y + fy * inv, z + fz * inv],
        color: forceColorCss(t),
      });
    }
    let dots: THREE.Points | null = null;
    if (dotPos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(dotPos), 3),
      );
      g.setAttribute(
        "color",
        new THREE.BufferAttribute(new Float32Array(dotCol), 3),
      );
      dots = new THREE.Points(
        g,
        new THREE.PointsMaterial({
          vertexColors: true,
          size: 9,
          sizeAttenuation: false,
        }),
      );
    }
    return { dots, segs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, channel, frameIdx, maxLen, forceMax]);

  if (!layout) return null;
  return (
    <>
      {anatomy && <primitive object={anatomy} />}
      {dots && <primitive object={dots} />}
      {segs.length > 0 && (
        <Segments limit={300} lineWidth={3}>
          {segs.map((s, i) => (
            <Segment key={i} start={s.start} end={s.end} color={s.color} />
          ))}
        </Segments>
      )}
    </>
  );
}

// ---- contact timeline (recharts, click to seek) -----------------------------

type TimelineRow = Record<string, number>;

function buildTimeline(channels: Channel[]): TimelineRow[] {
  if (!channels.length) return [];
  const nFrames = channels[0].timestamps.length;
  const step = Math.max(1, Math.floor(nFrames / 900));

  const rows: TimelineRow[] = [];
  for (let fi = 0; fi < nFrames; fi += step) {
    const row: TimelineRow = { t: channels[0].timestamps[fi] ?? 0 };
    channels.forEach((ch, k) => {
      const f = ch.at(fi) ?? [];
      let sumFz = 0;
      let peak = 0;
      for (const p of f) {
        const fx = Number(p[0]);
        const fy = Number(p[1]);
        const fz = Number(p[2]);
        sumFz += fz;
        const m = Math.hypot(fx, fy, fz);
        if (m > peak) peak = m;
      }
      row[`sumFz_${k}`] = Number(sumFz.toFixed(2));
      row[`peak_${k}`] = Number(peak.toFixed(2));
    });
    rows.push(row);
  }
  return rows;
}

function ContactTimeline({
  channels,
  fill = false,
}: {
  channels: Channel[];
  fill?: boolean;
}) {
  const { currentTime, seek } = useTime();
  const data = useMemo(() => buildTimeline(channels), [channels]);
  if (!data.length) return null;
  return (
    <div
      className={fill ? "h-full min-h-0" : "mt-3"}
      style={fill ? undefined : { height: "min(18vh, 200px)", minHeight: 120 }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 4, right: 8, bottom: 0, left: -18 }}
          onClick={(e) => {
            const t = Number(
              (e as { activeLabel?: string | number }).activeLabel,
            );
            if (Number.isFinite(t)) seek(t, "external");
          }}
        >
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            tick={{ fontSize: 10, fill: "#64748b" }}
            tickFormatter={(v: number) => `${v.toFixed(0)}s`}
          />
          <YAxis tick={{ fontSize: 10, fill: "#64748b" }} width={46} />
          <Tooltip
            contentStyle={{
              background: "#0b0e15",
              border: "1px solid #1e293b",
              fontSize: 11,
            }}
            labelFormatter={(v) => `t = ${Number(v).toFixed(2)} s`}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {channels.map((ch, k) => (
            <Line
              key={`s${k}`}
              dataKey={`sumFz_${k}`}
              name={`${ch.label} ΣFz`}
              stroke={CHANNEL_COLORS[k % CHANNEL_COLORS.length]}
              dot={false}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
          ))}
          {channels.map((ch, k) => (
            <Line
              key={`p${k}`}
              dataKey={`peak_${k}`}
              name={`${ch.label} peak|F|`}
              stroke={CHANNEL_COLORS[k % CHANNEL_COLORS.length]}
              strokeDasharray="4 3"
              dot={false}
              strokeWidth={1}
              isAnimationActive={false}
            />
          ))}
          <ReferenceLine x={currentTime} stroke="#ef4444" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---- stats ------------------------------------------------------------------

export function TactileStats({
  sensorFrames,
  gripper = null,
}: {
  sensorFrames: SensorFramesMap;
  gripper?: GripperSeries | null;
}) {
  const corrected = useDriftCorrectedView();
  const channels = useMemo(
    () => channelsFrom(sensorFrames, gripper, corrected),
    [sensorFrames, gripper, corrected],
  );
  const rows = useMemo(() => {
    return channels.map((ch) => {
      const n = ch.timestamps.length;
      let peak = 0;
      let peakT = 0;
      let contactFrames = 0;
      let sumFzInContact = 0;
      let maxSumFz = 0;
      for (let fi = 0; fi < n; fi++) {
        const f = ch.at(fi) ?? [];
        let sumFz = 0;
        let framePeak = 0;
        for (const p of f) {
          const m = Math.hypot(Number(p[0]), Number(p[1]), Number(p[2]));
          sumFz += Number(p[2]);
          if (m > framePeak) framePeak = m;
        }
        if (framePeak >= CONTACT_THR_N) {
          contactFrames++;
          sumFzInContact += sumFz;
        }
        if (sumFz > maxSumFz) maxSumFz = sumFz;
        if (framePeak > peak) {
          peak = framePeak;
          peakT = ch.timestamps[fi] ?? 0;
        }
      }
      return {
        label: ch.label,
        peak,
        peakT,
        contactPct: n ? (100 * contactFrames) / n : 0,
        meanSumFz: contactFrames ? sumFzInContact / contactFrames : 0,
        maxSumFz,
      };
    });
  }, [channels]);

  if (!rows.length) return null;
  return (
    <div className="max-w-4xl mx-auto w-full pt-6">
      <div className="bg-[var(--surface-1)]/60 rounded-lg p-4 border border-white/10">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-slate-400 uppercase tracking-wide">
            Tactile Sensors, current episode
          </p>
          <DriftViewToggle compact />
        </div>
        <table className="w-full text-sm text-slate-300">
          <thead>
            <tr className="text-[11px] text-slate-500 text-left">
              <th className="py-1 pr-3 font-normal">channel</th>
              <th className="py-1 pr-3 font-normal">peak |F|</th>
              <th className="py-1 pr-3 font-normal">@ time</th>
              <th className="py-1 pr-3 font-normal">contact %</th>
              <th className="py-1 pr-3 font-normal">mean ΣFz (contact)</th>
              <th className="py-1 pr-3 font-normal">max ΣFz</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {rows.map((r) => (
              <tr key={r.label} className="border-t border-slate-800">
                <td className="py-1.5 pr-3">{r.label}</td>
                <td className="py-1.5 pr-3">{r.peak.toFixed(2)} N</td>
                <td className="py-1.5 pr-3">{r.peakT.toFixed(2)} s</td>
                <td className="py-1.5 pr-3">{r.contactPct.toFixed(1)}%</td>
                <td className="py-1.5 pr-3">{r.meanSumFz.toFixed(2)} N</td>
                <td className="py-1.5 pr-3">{r.maxSumFz.toFixed(2)} N</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- cross-episode tactile aggregate (folder datasets, opt-in) -------------

export function TactileAggregate({
  repoId,
  folders,
}: {
  repoId: string;
  folders: string[];
}) {
  const [rows, setRows] = useState<FolderTactileRow[] | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const run = async () => {
    setProgress(`0 / ${folders.length}`);
    try {
      const out = await computeFolderTactileAggregate(
        repoId,
        folders,
        (done, total, folder) =>
          setProgress(`${done} / ${total} ${folder.split("/").pop() ?? ""}`),
      );
      setRows(out);
    } catch (e) {
      setProgress(`failed: ${String(e)}`);
      return;
    }
    setProgress(null);
  };

  return (
    <div className="max-w-4xl mx-auto w-full pt-4">
      <div className="bg-[var(--surface-1)]/60 rounded-lg p-4 border border-white/10">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <p className="text-xs text-slate-400 uppercase tracking-wide">
            Tactile Sensors, all {folders.length} episodes
          </p>
          {rows === null && progress === null && (
            <button
              onClick={() => void run()}
              className="text-xs px-3 py-1.5 rounded-md border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 transition-colors"
            >
              Compute (downloads each episode&apos;s data)
            </button>
          )}
          {progress !== null && (
            <p className="text-xs text-slate-400 tabular">{progress}</p>
          )}
        </div>
        {rows && rows.length > 0 && (
          <table className="w-full text-sm text-slate-300 mt-2">
            <thead>
              <tr className="text-[11px] text-slate-500 text-left">
                <th className="py-1 pr-3 font-normal">channel</th>
                <th className="py-1 pr-3 font-normal">peak |F|</th>
                <th className="py-1 pr-3 font-normal">peak episode</th>
                <th className="py-1 pr-3 font-normal">@ time</th>
                <th className="py-1 pr-3 font-normal">mean contact %</th>
                <th className="py-1 pr-3 font-normal">max ΣFz</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {rows.map((r) => (
                <tr key={r.channel} className="border-t border-slate-800">
                  <td className="py-1.5 pr-3">{r.channel}</td>
                  <td className="py-1.5 pr-3">{r.peak.toFixed(2)} N</td>
                  <td className="py-1.5 pr-3 text-xs">
                    {r.peakFolder.split("/").pop()}
                  </td>
                  <td className="py-1.5 pr-3">{r.peakT.toFixed(2)} s</td>
                  <td className="py-1.5 pr-3">
                    {r.meanContactPct.toFixed(1)}%
                  </td>
                  <td className="py-1.5 pr-3">{r.maxSumFz.toFixed(2)} N</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rows && rows.length === 0 && (
          <p className="text-xs text-slate-500 mt-2">
            no tactile channels found across episodes
          </p>
        )}
      </div>
    </div>
  );
}

// ---- main panel -------------------------------------------------------------

export default function TactilePanel({
  sensorFrames,
  fps,
  compact = false,
  repoId,
  root,
  gripper = null,
}: {
  sensorFrames: SensorFramesMap;
  fps: number;
  compact?: boolean;
  gripper?: GripperSeries | null;
  /** org/dataset, enables the raw high-frequency stream loader. */
  repoId?: string;
  /** ?root= episode folder for per-episode-folder datasets. */
  root?: string | null;
}) {
  const { currentTime } = useTime();
  const [maxLen, setMaxLen] = useState(14);
  const [forceMax, setForceMax] = useState(5.0);
  const corrected = useDriftCorrectedView();

  const channels = useMemo(
    () => channelsFrom(sensorFrames, gripper, corrected),
    [sensorFrames, gripper, corrected],
  );
  if (channels.length === 0) return null;

  // Aspect-ratio-driven (not fixed px) so the 3D views scale with container
  // width and browser zoom exactly like the video panels do.
  // Viewport-height budget (global one-screen layout): the sensor row takes
  // at most ~22vh so videos + sensors + charts fit without scrolling, at any
  // monitor size or zoom. FitCamera reframes the pad for whatever shape the
  // canvas ends up with.
  const viewStyle: React.CSSProperties = {
    aspectRatio: "16 / 10",
    minHeight: 140,
    maxHeight: "22vh",
    width: "100%",
  };
  return (
    <div className="mb-6 panel p-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-[10px] uppercase tracking-wide text-slate-500">
          Tactile Sensors
        </p>
        <div className="flex items-center gap-4 text-[11px] text-slate-400">
          <DriftViewToggle />
          <label className="flex items-center gap-2">
            arrow {maxLen.toFixed(0)} mm
            <input
              type="range"
              min={4}
              max={30}
              step={1}
              value={maxLen}
              onChange={(e) => setMaxLen(Number(e.target.value))}
            />
          </label>
          <label className="flex items-center gap-2">
            red at {forceMax.toFixed(1)} N
            <input
              type="range"
              min={0.5}
              max={15}
              step={0.5}
              value={forceMax}
              onChange={(e) => setForceMax(Number(e.target.value))}
            />
          </label>
        </div>
      </div>
      <div
        className="mt-3 grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${Math.min(channels.length, 2)}, minmax(0, 1fr))`,
        }}
      >
        {channels.map((ch) => {
          const fi = frameIndexFor(ch.timestamps, currentTime, fps);
          return (
            <div key={ch.label} className="rounded bg-[#0b0e15]">
              <p className="px-2 pt-1.5 text-[11px] text-slate-400">
                {ch.label}
              </p>
              <div style={viewStyle}>
                <Canvas
                  camera={{ position: [0, 11, 34], up: [0, 1, 0], fov: 38 }}
                >
                  <color attach="background" args={["#0b0e15"]} />
                  <FitCamera
                    points={resolveTaxelLayout(ch.nPoints)?.points ?? []}
                  />
                  <ChannelScene
                    channel={ch}
                    frameIdx={fi}
                    maxLen={maxLen}
                    forceMax={forceMax}
                  />
                  <OrbitControls makeDefault enableDamping={false} />
                </Canvas>
              </div>
            </div>
          );
        })}
      </div>
      {!compact && <ContactTimeline channels={channels} />}
      {!compact && repoId && <RawStreamPanel repoId={repoId} root={root} />}
    </div>
  );
}

// ---- dashboard-layout pieces (single-viewport episode page) -----------------

/** Labels of all tactile channels (fingers) in a SensorFramesMap, in order. */
export function tactileChannelLabels(sensorFrames: SensorFramesMap): string[] {
  return channelsFrom(sensorFrames).map((c) => c.label);
}

/** One finger's 3D force view, filling its container (grid-tile friendly). */
export function TactileFingerView({
  sensorFrames,
  fps,
  fingerIndex,
  maxLen = 14,
  forceMax = 5.0,
  gripper = null,
}: {
  sensorFrames: SensorFramesMap;
  fps: number;
  fingerIndex: number;
  maxLen?: number;
  forceMax?: number;
  gripper?: GripperSeries | null;
}) {
  const { currentTime } = useTime();
  const corrected = useDriftCorrectedView();
  const channels = useMemo(
    () => channelsFrom(sensorFrames, gripper, corrected),
    [sensorFrames, gripper, corrected],
  );
  const ch = channels[fingerIndex];
  if (!ch) return null;
  const fi = frameIndexFor(ch.timestamps, currentTime, fps);
  return (
    <div className="panel p-2 h-full min-h-0 flex flex-col">
      <div className="px-1 pb-1 shrink-0 flex items-center justify-between gap-1">
        <p className="text-[11px] text-slate-400 truncate">{ch.label}</p>
        <DriftViewToggle compact />
      </div>
      <div className="flex-1 min-h-0 rounded bg-[#0b0e15]">
        <Canvas camera={{ position: [0, 11, 34], up: [0, 1, 0], fov: 38 }}>
          <color attach="background" args={["#0b0e15"]} />
          <FitCamera points={resolveTaxelLayout(ch.nPoints)?.points ?? []} />
          <ChannelScene
            channel={ch}
            frameIdx={fi}
            maxLen={maxLen}
            forceMax={forceMax}
          />
          <OrbitControls makeDefault enableDamping={false} />
        </Canvas>
      </div>
    </div>
  );
}

/** Contact-force timeline as a standalone height-filling tile. */
export function TactileSummary({
  sensorFrames,
  gripper = null,
}: {
  sensorFrames: SensorFramesMap;
  gripper?: GripperSeries | null;
}) {
  const corrected = useDriftCorrectedView();
  const channels = useMemo(
    () => channelsFrom(sensorFrames, gripper, corrected),
    [sensorFrames, gripper, corrected],
  );
  if (channels.length === 0) return null;
  return (
    <div className="panel p-2 h-full min-h-0 flex flex-col">
      <div className="px-1 pb-1 shrink-0 flex items-center justify-between gap-1">
        <p className="text-[10px] uppercase tracking-wide text-slate-500">
          Contact force
        </p>
        <DriftViewToggle compact />
      </div>
      <div className="flex-1 min-h-0">
        <ContactTimeline channels={channels} fill />
      </div>
    </div>
  );
}
