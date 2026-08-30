"use client";

// Auto-label panel: one-click tactile event detection for the Annotations tab.
//
// Runs eventDetection.ts on the episode's tactile data (30 Hz sensorFrames
// always; optionally the ~91 Hz raw sidecar CSVs when the dataset ships them),
// emits v3.1 language atoms into the shared annotations context, and exposes
// the key thresholds as live controls, every change recomputes immediately so
// tuning is visual. Auto-generated atoms are tagged: events carry an
// "[auto:…]" content prefix; subtasks use the four canonical labels. Re-running
// replaces previous auto atoms and never touches human-authored ones.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAnnotations } from "@/context/annotations-context";
import {
  buildSeriesFromSensorFrames,
  buildSeriesFromRawCsvs,
  clipSeries,
  detectEvents,
  resultToAtoms,
  DEFAULT_THRESHOLDS,
  type DetectionThresholds,
  type TactileSeries,
  type AutoLabelResult,
} from "@/lib/eventDetection";
import { resolveTaxelLayout } from "@/lib/taxel-layouts";
import type { SensorFramesMap } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import type { LanguageAtom } from "@/types/language.types";
import { findRawSensorCsvs } from "@/utils/episodeDiscovery";
import { buildVersionedUrl } from "@/utils/versionUtils";
import { authHeaders } from "@/utils/auth";

const AUTO_SUBTASK_LABELS = new Set([
  "approach",
  "grasp",
  "transport",
  "place_release",
]);

/** Auto-generated tactile EVENT atoms only (slip, contact, place, ...). */
function isAutoEventAtom(a: LanguageAtom): boolean {
  return a.style === "interjection" && !!a.content?.startsWith("[auto:");
}

function isAutoAtom(a: LanguageAtom): boolean {
  if (a.style === "interjection" && a.content?.startsWith("[auto:"))
    return true;
  if (
    a.style === "subtask" &&
    a.role === "assistant" &&
    a.content != null &&
    AUTO_SUBTASK_LABELS.has(a.content)
  )
    return true;
  return false;
}

/** Threshold controls surfaced in the UI: [key, label, min, max, step, description]. */
const TUNABLE: Array<
  [keyof DetectionThresholds, string, number, number, number, string]
> = [
  [
    "contactEnterN",
    "contact enter (N)",
    0.05,
    2,
    0.05,
    "Total fingertip force above which the pad counts as touching the object. Raise it if sensor noise or light brushes create false 'contact' events; lower it to catch very gentle first touches earlier.",
  ],
  [
    "stableMinN",
    "stable min force (N)",
    0.1,
    5,
    0.1,
    "Minimum sustained grip force for the grasp to count as 'stable hold'. Raise it and weak pinches stay labeled unstable; lower it and even light grips qualify as holding.",
  ],
  [
    "hfEnter",
    "slip HF enter",
    2,
    60,
    1,
    "High-frequency vibration energy in the tactile signal that triggers a slip event (micro-vibrations from the object sliding). Lower = more sensitive slip detection but more false positives from arm motion.",
  ],
  [
    "slipShearRateNps",
    "slip shear rate (N/s)",
    1,
    30,
    1,
    "How fast the tangential (shear) force must change to count as gross slip. Lower values flag slower slides; higher values only catch abrupt slips.",
  ],
  [
    "slipDivEnter",
    "incipient divergence",
    0.1,
    0.9,
    0.05,
    "Fraction of taxels whose force vectors start pointing apart, the early signature of a slip that has not fully started. Lower = earlier (but noisier) incipient-slip warnings. These events are marked low-confidence for review.",
  ],
  [
    "rotationTauNmm",
    "rotation torque (N·mm)",
    5,
    120,
    5,
    "Net torque on the pad above which the object counts as rotating in the gripper (e.g. a cup pivoting). Raise it if normal regrasps trigger false rotation events.",
  ],
  [
    "placeDropFrac",
    "place drop fraction",
    0.05,
    0.6,
    0.05,
    "Fraction of the held force that must vanish for a 'release/placed' event. Lower = release detected at the slightest unloading; higher = only when the object is almost fully let go.",
  ],
  [
    "gripperVelEps",
    "gripper vel eps",
    0.1,
    3,
    0.1,
    "Gripper joint speed below which the gripper counts as 'not moving', used to separate intentional open/close from holding still. Raise it if servo jitter keeps the gripper from ever reading as stationary.",
  ],
];

export default function AutoLabelPanel({
  sensorFrames,
  gripper,
  arm,
  repoId,
  root,
  episodeId,
}: {
  sensorFrames: SensorFramesMap | undefined;
  /** Episode-relative gripper trajectory (from the flat chart data). */
  gripper: { t: number[]; pos: number[] } | null;
  /** Arm joint positions (gripper excluded) — transport anchor. */
  arm: { t: number[]; joints: number[][] } | null;
  repoId: string;
  root?: string | null;
  episodeId: number;
}) {
  const { atoms, addAtoms, deleteAtom, resetAtoms } = useAnnotations();
  const [open, setOpen] = useState(false);
  const [thresholds, setThresholds] = useState<Partial<DetectionThresholds>>(
    {},
  );
  const [useRaw, setUseRaw] = useState(true);
  const [running, setRunning] = useState(false);
  const [rawState, setRawState] = useState<
    "none" | "loading" | "ready" | "missing"
  >("none");
  const rawSeriesRef = useRef<TactileSeries | null>(null);
  const [lastResult, setLastResult] = useState<AutoLabelResult | null>(null);
  const [status, setStatus] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 30 Hz series from the already-loaded sensor frames (memoized).
  const series30 = useMemo(() => {
    if (!sensorFrames) return null;
    const entry = Object.values(sensorFrames).find(
      (s) => s.shape.length >= 2 && s.frames.length > 0,
    );
    if (!entry) return null;
    const nTaxels = entry.shape.length >= 3 ? entry.shape[1] : entry.shape[0];
    const layout = resolveTaxelLayout(nTaxels)?.points ?? null;
    return buildSeriesFromSensorFrames(
      entry.frames,
      entry.timestamps,
      layout,
      gripper,
    );
  }, [sensorFrames, gripper]);

  const loadRaw = useCallback(async () => {
    if (rawSeriesRef.current) return rawSeriesRef.current;
    setRawState("loading");
    try {
      const all = await findRawSensorCsvs(repoId, root);
      const epTag = `episode_${String(episodeId).padStart(6, "0")}/`;
      // Multi-episode datasets carry one folder per episode; per-episode-folder
      // datasets carry the CSVs at the root. Prefer the episode's folder, fall
      // back to unscoped paths.
      let files = all.filter((p) => p.includes(epTag)).sort();
      if (files.length === 0 && !all.some((p) => /episode_\d{6}\//.test(p))) {
        files = all.slice().sort();
      }
      if (files.length === 0) {
        setRawState("missing");
        return null;
      }
      const texts = await Promise.all(
        files.map(async (f) => {
          const rel = root
            ? f.slice(root.replace(/^\/+|\/+$/g, "").length + 1)
            : f;
          const res = await fetch(buildVersionedUrl(repoId, "v3.0", rel), {
            headers: authHeaders(),
          });
          if (!res.ok) throw new Error(`${res.status} on ${f}`);
          return res.text();
        }),
      );
      const nTaxels =
        sensorFrames && Object.values(sensorFrames)[0]?.shape.length >= 3
          ? Object.values(sensorFrames)[0].shape[1]
          : 52;
      const layout = resolveTaxelLayout(nTaxels)?.points ?? null;
      const s = buildSeriesFromRawCsvs(texts, layout, gripper);
      rawSeriesRef.current = s;
      setRawState(s ? "ready" : "missing");
      return s;
    } catch {
      setRawState("missing");
      return null;
    }
  }, [repoId, episodeId, root, sensorFrames, gripper]);

  const run = useCallback(
    async (th: Partial<DetectionThresholds>) => {
      setRunning(true);
      try {
        let series: TactileSeries | null = series30;
        let usedFallback = false;
        if (useRaw) {
          const raw = await loadRaw();
          // Sidecar CSVs record through the inter-episode reset period, so the
          // raw stream can far outlast the episode, clip to the main table's
          // time window before detecting.
          if (raw) {
            const tEnd = series30
              ? series30.t[series30.t.length - 1] + 0.1
              : raw.t[raw.t.length - 1];
            series = clipSeries(raw, tEnd);
          } else {
            // Silent fallback previously made 30 Hz artifacts (zero-frame
            // dropouts) look like raw-stream detections. Be explicit.
            usedFallback = true;
          }
        }
        if (!series) {
          setStatus("no tactile data in this episode");
          return;
        }
        const t0 = performance.now();
        const result = detectEvents(series, gripper, th, arm);
        // Diagnostics: everything needed to compare a browser run against the
        // offline reference. Read via DevTools: window.__autolabelDebug
        if (typeof window !== "undefined") {
          (window as unknown as Record<string, unknown>).__autolabelDebug = {
            rateHz: series.rateHz,
            nSamples: series.t.length,
            tRange: [series.t[0], series.t[series.t.length - 1]],
            gripper: gripper
              ? {
                  n: gripper.t.length,
                  tRange: [gripper.t[0], gripper.t[gripper.t.length - 1]],
                  posRange: [
                    Math.min(...gripper.pos),
                    Math.max(...gripper.pos),
                  ],
                }
              : null,
            thresholds: th,
            subtasks: result.subtasks,
            events: result.events.slice(0, 40),
            flags: result.flags,
          };
        }
        // replace previous auto atoms, keep human ones. In events-only mode,
        // only auto EVENT atoms are replaced; subtask segments stay untouched.
        const replaceFilter = eventsOnlyRef.current
          ? isAutoEventAtom
          : isAutoAtom;
        for (const a of atoms.filter(replaceFilter)) deleteAtom(a);
        const newAtoms = resultToAtoms(result);
        addAtoms(
          eventsOnlyRef.current
            ? newAtoms.filter((a) => a.style === "interjection")
            : newAtoms,
        );
        setLastResult(result);
        const subStr = result.subtasks
          .map(
            (s) =>
              `${s.label.slice(0, 5)} ${s.startS.toFixed(1)}-${s.endS.toFixed(1)}`,
          )
          .join(" | ");
        setStatus(
          `${usedFallback ? "RAW UNAVAILABLE, used 30 Hz table! " : ""}` +
            `${result.events.length} events (${(performance.now() - t0).toFixed(0)} ms ` +
            `@ ${series.rateHz.toFixed(0)} Hz) ${subStr}` +
            `${result.flags.length ? ` flags: ${result.flags.join(", ")}` : ""}`,
        );
      } finally {
        setRunning(false);
      }
    },
    [series30, useRaw, loadRaw, gripper, arm, atoms, deleteAtom, addAtoms],
  );

  // Re-detect only tactile events, leaving subtask segments (including
  // hand-adjusted ones) untouched.
  const [eventsOnly, setEventsOnly] = useState(false);
  const eventsOnlyRef = useRef(eventsOnly);
  eventsOnlyRef.current = eventsOnly;

  const onThreshold = useCallback(
    (key: keyof DetectionThresholds, value: number) => {
      const next = { ...thresholds, [key]: value };
      setThresholds(next);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => void run(next), 250);
    },
    [thresholds, run],
  );

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  // reset per-episode caches
  useEffect(() => {
    rawSeriesRef.current = null;
    setRawState("none");
    setLastResult(null);
    setStatus("");
  }, [repoId, episodeId]);

  if (!series30) return null;

  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-900/40 p-3 space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="section-kicker">Tactile auto-label</span>
        <label
          className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer"
          title="Re-detect tactile events (contact, slip, place, release, ...) while keeping the subtask segments exactly as they are, including ones you edited by hand."
        >
          <input
            type="checkbox"
            checked={eventsOnly}
            onChange={(e) => setEventsOnly(e.target.checked)}
          />
          events only (keep subtasks)
        </label>
        <button
          type="button"
          disabled={running}
          onClick={() => void run(thresholds)}
          className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-sky-600"
        >
          {running ? "Auto-labeling…" : "Auto-label episode"}
        </button>
        <label className="flex items-center gap-1 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={useRaw}
            onChange={(e) => setUseRaw(e.target.checked)}
          />
          use raw 91 Hz stream
          {rawState === "loading" && " (loading…)"}
          {rawState === "missing" && " (not available)"}
        </label>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-xs text-slate-400 hover:text-slate-200 underline"
        >
          {open ? "hide thresholds" : "tune thresholds"}
        </button>
        <button
          type="button"
          title="Delete session-cached annotations for ALL episodes of every dataset in this browser tab (stale labels from previous visualizer versions live there)."
          onClick={() => {
            let n = 0;
            try {
              for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k && k.startsWith("lerobot-annotations:")) {
                  localStorage.removeItem(k);
                  n++;
                }
              }
            } catch {
              /* storage unavailable */
            }
            resetAtoms();
            setStatus(
              `cleared ${n} cached episode annotation(s), click Auto-label to regenerate`,
            );
          }}
          className="text-xs text-red-400/80 hover:text-red-300 underline"
        >
          clear label cache
        </button>
        {status && <span className="text-xs text-slate-500">{status}</span>}
      </div>

      {open && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 pt-1">
          {TUNABLE.map(([key, label, min, max, step, description]) => {
            const value =
              (thresholds[key] as number | undefined) ??
              (DEFAULT_THRESHOLDS[key] as number);
            return (
              <label
                key={key}
                title={description}
                className="text-[11px] text-slate-400 space-y-0.5 cursor-help"
              >
                <span className="flex justify-between">
                  <span>{label}</span>
                  <span className="tabular text-slate-300">{value}</span>
                </span>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={value}
                  onChange={(e) => onThreshold(key, Number(e.target.value))}
                  className="w-full"
                />
              </label>
            );
          })}
        </div>
      )}

      {lastResult &&
        (() => {
          const low = lastResult.events.filter((e) => e.confidence === "low");
          if (low.length === 0) return null;
          const counts = new Map<string, number>();
          for (const e of low) {
            counts.set(e.label, (counts.get(e.label) ?? 0) + 1);
          }
          const summary = [...counts.entries()]
            .map(([label, c]) => (c > 1 ? `${label} ×${c}` : label))
            .join(", ");
          return (
            <p className="text-[11px] text-amber-400/80">
              {low.length} low-confidence event{low.length > 1 ? "s" : ""} need
              review: {summary}
              {counts.has("incipient_slip")
                ? " — per-taxel shear provenance (C6) is unresolved"
                : ""}
              .
            </p>
          );
        })()}
    </div>
  );
}
