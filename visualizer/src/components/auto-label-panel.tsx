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
import { useTime } from "@/context/time-context";
import {
  buildSeriesFromSensorFrames,
  buildSeriesFromRawCsvs,
  clipSeries,
  detectEvents,
  resultToRecordedAtoms,
  DEFAULT_THRESHOLDS,
  type DetectionThresholds,
  type TactileSeries,
  type AutoLabelResult,
  spanFlag,
} from "@/lib/eventDetection";
import { templateReminder } from "@/lib/rigProfile";
import { useRigProfile } from "@/lib/useRigProfile";
import { useSearchParams } from "next/navigation";
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
  const { atoms, addAtom, addAtoms, deleteAtom, resetAtoms, setDetectorSpans } =
    useAnnotations();
  const { seek } = useTime();
  // rig calibration profile: registry by dataset id, or the explicit
  // ?profile= override; null = the interpretation layer refuses to run
  const searchParams = useSearchParams();
  const profileOverride = searchParams?.get("profile") ?? null;
  // dataset's own meta/annotator_profile.json > ?profile= > registry >
  // TEMPLATE (sotac numbers, unverified: reminded below, flagged in results)
  const { profile, source: profileSource } = useRigProfile(
    repoId,
    profileOverride,
  );
  const [reminderDismissed, setReminderDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  // Human-review queue (Zheng's verify-and-add flow): failed_attempt span
  // flags render as adjustable spans; a human watches the clip, nudges the
  // boundaries, and confirms — only then does an event atom exist. Keyed by
  // the original flag string; cleared on re-run and episode change.
  const [review, setReview] = useState<
    Record<string, { start: number; end: number; done?: "added" | "dismissed" }>
  >({});
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
    if (!profile) return null;
    return buildSeriesFromSensorFrames(
      entry.frames,
      entry.timestamps,
      layout,
      gripper,
      profile,
    );
  }, [sensorFrames, gripper, profile]);

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
      if (!profile) return null;
      const s = buildSeriesFromRawCsvs(texts, layout, gripper, { profile });
      rawSeriesRef.current = s;
      setRawState(s ? "ready" : "missing");
      return s;
    } catch {
      setRawState("missing");
      return null;
    }
  }, [repoId, episodeId, root, sensorFrames, gripper, profile]);

  const run = useCallback(
    async (th: Partial<DetectionThresholds>) => {
      if (!profile) {
        setStatus("calibration profile still loading — try again");
        return;
      }
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
        // episodeIndex keeps the signal screen from letting a corpus
        // episode's own reference windows vote for it on replays
        const result = detectEvents(series, gripper, th, arm, {
          profile,
          episodeIndex: episodeId,
        });
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
        // recording policy: panels show everything, the annotation set
        // (what gets saved) keeps only the real events
        const newAtoms = resultToRecordedAtoms(result);
        addAtoms(
          eventsOnlyRef.current
            ? newAtoms.filter((a) => a.style === "interjection")
            : newAtoms,
        );
        setLastResult(result);
        setReview({});
        setDetectorSpans(result.spans);
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
    [
      series30,
      useRaw,
      loadRaw,
      gripper,
      arm,
      atoms,
      deleteAtom,
      addAtoms,
      episodeId,
      setDetectorSpans,
      profile,
      repoId,
    ],
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
    setReview({});
    setDetectorSpans([]);
    setStatus("");
  }, [repoId, episodeId, setDetectorSpans]);

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
          disabled={running || !profile}
          title={
            profile
              ? `rig profile: ${profile.id} (${profileSource})`
              : "calibration profile loading"
          }
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
        {profileSource === "template" && !reminderDismissed && (
          <div className="rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
            <span className="font-semibold">Template calibration in use.</span>{" "}
            {templateReminder(repoId)}{" "}
            <a
              href="/annotator_profile.template.json"
              target="_blank"
              className="underline text-amber-300"
            >
              template file
            </a>
            <button
              type="button"
              onClick={() => setReminderDismissed(true)}
              className="ml-2 text-amber-400/80 underline"
            >
              got it
            </button>
          </div>
        )}
        {status && <span className="text-xs text-slate-500">{status}</span>}
      </div>

      {open && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 pt-1">
          {TUNABLE.map(([key, label, min, max, step, description]) => {
            const value =
              (thresholds[key] as number | undefined) ??
              ((profile?.calibration.thresholds ?? DEFAULT_THRESHOLDS)[
                key
              ] as number);
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

      {lastResult &&
        (() => {
          // failed_attempt spans are FLAGS (no event atom exists) until a
          // human verifies them here. Click the span to seek the video,
          // nudge the boundaries, confirm to add the atom. Verified atoms
          // carry no [auto:] prefix, so re-running auto-label keeps them.
          const spans = lastResult.spans
            .filter(
              (sp) =>
                sp.kind === "failed_attempt" || sp.kind === "short_transport",
            )
            .map((sp) => ({ flag: spanFlag(sp), span: sp }));
          if (spans.length === 0) return null;
          const nudge = (
            key: string,
            edge: "start" | "end",
            delta: number,
            s0: number,
            e0: number,
          ) =>
            setReview((r) => {
              const cur = r[key] ?? { start: s0, end: e0 };
              let { start, end } = cur;
              if (edge === "start") {
                start = Math.max(0, Math.min(start + delta, end - 0.01));
              } else {
                end = Math.max(start + 0.01, end + delta);
              }
              start = Math.round(start * 100) / 100;
              end = Math.round(end * 100) / 100;
              return { ...r, [key]: { ...cur, start, end } };
            });
          const nudgeBtns = (
            key: string,
            edge: "start" | "end",
            s0: number,
            e0: number,
          ) => (
            <span className="inline-flex items-center gap-0.5">
              <span className="text-slate-500 mr-0.5">{edge}</span>
              {[-0.1, -0.01, 0.01, 0.1].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => nudge(key, edge, d, s0, e0)}
                  className="px-1 rounded border border-slate-600/60 text-slate-300 hover:bg-slate-700/60 tabular"
                >
                  {d > 0 ? `+${d}` : d}
                </button>
              ))}
            </span>
          );
          return (
            <div className="space-y-1.5 pt-1 border-t border-slate-700/40">
              <p className="text-[11px] text-amber-400/90">
                {spans.length} span{spans.length > 1 ? "s" : ""} awaiting human
                review — click a span to seek the video there, adjust, then
                verify:
              </p>
              {spans.map(({ flag, span }) => {
                // short_transport (ep39-class wrong-location failure) is a
                // possible failed task — the card proposes a failed_attempt
                // for the human to confirm, same flow
                const label =
                  span.kind === "short_transport"
                    ? "short transport → failed?"
                    : "failed_attempt";
                // card times at the 0.1 s resolution the flag shows
                const s0 = Number(span.startS.toFixed(1));
                const e0 = Number(span.endS.toFixed(1));
                const st = review[flag]?.start ?? s0;
                const en = review[flag]?.end ?? e0;
                const done = review[flag]?.done;
                if (done) {
                  return (
                    <p key={flag} className="text-[11px] text-slate-500">
                      {label} {st.toFixed(2)}–{en.toFixed(2)} s —{" "}
                      {done === "added" ? "✓ event added" : "dismissed"}
                    </p>
                  );
                }
                return (
                  <div
                    key={flag}
                    className="flex items-center gap-2 flex-wrap text-[11px]"
                  >
                    <button
                      type="button"
                      title="Seek the video to this span"
                      onClick={() => seek(st)}
                      className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300 hover:bg-amber-500/25 tabular"
                    >
                      {label} {st.toFixed(2)}–{en.toFixed(2)} s
                    </button>
                    {nudgeBtns(flag, "start", s0, e0)}
                    {nudgeBtns(flag, "end", s0, e0)}
                    <button
                      type="button"
                      title="Verified on video — add as an event annotation"
                      onClick={() => {
                        addAtom({
                          role: "user",
                          content: `failed_attempt ${(en - st).toFixed(2)}s (verified)`,
                          style: "interjection",
                          timestamp: st,
                          camera: null,
                          tool_calls: null,
                        });
                        setReview((r) => ({
                          ...r,
                          [flag]: { start: st, end: en, done: "added" },
                        }));
                      }}
                      className="px-2 py-0.5 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white"
                    >
                      ✓ yes, add event
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setReview((r) => ({
                          ...r,
                          [flag]: { start: st, end: en, done: "dismissed" },
                        }))
                      }
                      className="text-slate-500 hover:text-slate-300 underline"
                    >
                      dismiss
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })()}
    </div>
  );
}
