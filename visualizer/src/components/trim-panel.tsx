"use client";
// Trim panel (Jingyi's trim ask, cycle 3): the episode's proposed cut
// points from the arm's motion envelope (lib/trimDetect.ts), drawn on a
// bar the reviewer can drag, with seek buttons to watch the frames at each
// cut. The decision is kept per episode in this browser (lib/trimStore.ts);
// the trim page lists every episode's and hands them to the executor.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTime } from "@/context/time-context";
import { armSeriesFrom } from "@/lib/annotateEpisode";
import {
  commandSeriesFrom,
  DEFAULT_TRIM_PARAMS,
  proposeTrim,
  type TrimProposal,
} from "@/lib/trimDetect";
import {
  decisionFromProposal,
  readTrim,
  writeTrim,
  type TrimDecision,
} from "@/lib/trimStore";

const BTN =
  "text-[11px] px-2 py-0.5 rounded border border-white/10 text-slate-300 hover:bg-white/5 disabled:opacity-40";
const CHIP = "rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-300";

export default function TrimPanel({
  repoId,
  episodeId,
  fps,
  rows,
  totalFrames,
}: {
  repoId: string;
  episodeId: number;
  fps: number;
  /** the chart rows: joints and timestamp per frame */
  rows: Record<string, number>[] | undefined;
  /** frames in the episode (the rows can be sampled on long episodes) */
  totalFrames?: number;
}) {
  const { currentTime, seek, duration } = useTime();
  const proposal: TrimProposal | null = useMemo(
    () =>
      proposeTrim(
        armSeriesFrom(rows),
        commandSeriesFrom(rows),
        fps,
        DEFAULT_TRIM_PARAMS,
        { totalFrames },
      ),
    [rows, fps, totalFrames],
  );
  const [decision, setDecision] = useState<TrimDecision | null>(null);
  const [open, setOpen] = useState(true);
  const barRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<"start" | "end" | null>(null);

  // the stored decision, or the rule's proposal (stored, so the trim page
  // sees the same numbers)
  useEffect(() => {
    const stored = readTrim(repoId, episodeId);
    if (stored) {
      setDecision(stored);
      return;
    }
    if (proposal) {
      const d = decisionFromProposal(proposal);
      writeTrim(repoId, episodeId, d);
      setDecision(d);
    } else {
      setDecision(null);
    }
  }, [repoId, episodeId, proposal]);

  const save = useCallback(
    (patch: Partial<TrimDecision>, source?: TrimDecision["source"]) => {
      setDecision((prev) => {
        if (!prev) return prev;
        const next: TrimDecision = {
          ...prev,
          ...patch,
          source: source ?? prev.source,
          savedAt: new Date().toISOString(),
        };
        writeTrim(repoId, episodeId, next);
        return next;
      });
    },
    [repoId, episodeId],
  );

  const n = decision?.nFrames ?? proposal?.nFrames ?? 0;
  const frameAt = useCallback(
    (clientX: number): number => {
      const el = barRef.current;
      if (!el || n === 0) return 0;
      const r = el.getBoundingClientRect();
      const x = Math.min(Math.max(clientX - r.left, 0), r.width);
      return Math.round((x / r.width) * (n - 1));
    },
    [n],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const which = dragRef.current;
      if (!which || !decision) return;
      const f = frameAt(e.clientX);
      if (which === "start")
        save({ startFrame: Math.min(f, decision.endFrame - 1) }, "adjusted");
      else save({ endFrame: Math.max(f, decision.startFrame + 1) }, "adjusted");
    },
    [decision, frameAt, save],
  );
  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  if (!rows || rows.length === 0) return null;
  if (!proposal || !decision) {
    return (
      <div className="panel p-2 text-[11px] text-slate-500">
        Trim: no joint signals in this episode&apos;s rows.
      </div>
    );
  }

  const pct = (f: number) => (n > 1 ? (100 * f) / (n - 1) : 0);
  const startS = decision.startFrame / fps;
  const endS = (decision.endFrame + 1) / fps;
  const cutBefore = startS;
  const cutAfter = Math.max(0, n / fps - endS);
  const playheadPct = duration > 0 ? (100 * currentTime) / duration : 0;

  return (
    <div className="panel p-2 text-[11px] text-slate-300 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-xs text-cyan-300"
          title="Cut points for the dataset trim: proposed from the arm's motion envelope, adjustable here; the Trim tab lists every episode"
        >
          {open ? "▾" : "▸"} Trim
        </button>
        <span className="tabular">
          keep {startS.toFixed(2)} s – {endS.toFixed(2)} s (frames{" "}
          {decision.startFrame}–{decision.endFrame} of {n}) · cut{" "}
          {cutBefore.toFixed(2)} s before, {cutAfter.toFixed(2)} s after
        </span>
        <span
          className={
            decision.reviewed
              ? "text-emerald-300"
              : decision.source === "adjusted"
                ? "text-amber-200"
                : "text-slate-500"
          }
        >
          {decision.reviewed
            ? "reviewed"
            : decision.source === "adjusted"
              ? "adjusted, not reviewed"
              : "rule, not reviewed"}
        </span>
        {decision.flags.map((f) => (
          <span key={f} className={CHIP}>
            {f}
          </span>
        ))}
      </div>

      {open && (
        <>
          {/* the bar: full recording; kept window in cyan; drag the handles */}
          <div
            ref={barRef}
            className="relative h-6 w-full rounded bg-white/5 select-none touch-none"
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onClick={(e) => {
              if (dragRef.current) return;
              seek(frameAt(e.clientX) / fps);
            }}
            title="Click to seek; drag the handles to move the cuts"
          >
            <div
              className="absolute top-0 bottom-0 bg-cyan-500/25"
              style={{
                left: `${pct(decision.startFrame)}%`,
                width: `${pct(decision.endFrame) - pct(decision.startFrame)}%`,
              }}
            />
            {proposal.onsetFrame !== null && (
              <div
                className="absolute top-0 bottom-0 w-px bg-slate-400/60"
                style={{ left: `${pct(proposal.onsetFrame)}%` }}
                title={`commanded arm motion starts at frame ${proposal.onsetFrame}`}
              />
            )}
            {proposal.motionEndFrame !== null && (
              <div
                className="absolute top-0 bottom-0 w-px bg-slate-400/60"
                style={{ left: `${pct(proposal.motionEndFrame)}%` }}
                title={`measured arm motion ends at frame ${proposal.motionEndFrame}`}
              />
            )}
            <div
              className="absolute top-0 bottom-0 w-px bg-white/70 pointer-events-none"
              style={{ left: `${playheadPct}%` }}
            />
            {(["start", "end"] as const).map((which) => (
              <div
                key={which}
                role="slider"
                aria-label={`${which} cut`}
                aria-valuenow={
                  which === "start" ? decision.startFrame : decision.endFrame
                }
                className="absolute top-0 bottom-0 w-2 -ml-1 cursor-ew-resize rounded bg-cyan-300 hover:bg-cyan-200"
                style={{
                  left: `${pct(which === "start" ? decision.startFrame : decision.endFrame)}%`,
                }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  dragRef.current = which;
                  (e.currentTarget as HTMLElement).setPointerCapture?.(
                    e.pointerId,
                  );
                }}
                onPointerUp={endDrag}
                onClick={(e) => e.stopPropagation()}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-slate-400">
              start
              <input
                type="number"
                step={1 / fps}
                min={0}
                max={endS}
                value={startS.toFixed(3)}
                onChange={(e) => {
                  const f = Math.round(Number(e.target.value) * fps);
                  if (Number.isFinite(f))
                    save(
                      {
                        startFrame: Math.max(
                          0,
                          Math.min(f, decision.endFrame - 1),
                        ),
                      },
                      "adjusted",
                    );
                }}
                className="w-20 rounded border border-white/10 bg-black/30 px-1 py-0.5 text-slate-200 tabular"
              />
            </label>
            <label className="flex items-center gap-1 text-slate-400">
              end
              <input
                type="number"
                step={1 / fps}
                min={startS}
                max={n / fps}
                value={endS.toFixed(3)}
                onChange={(e) => {
                  const f = Math.round(Number(e.target.value) * fps) - 1;
                  if (Number.isFinite(f))
                    save(
                      {
                        endFrame: Math.min(
                          n - 1,
                          Math.max(f, decision.startFrame + 1),
                        ),
                      },
                      "adjusted",
                    );
                }}
                className="w-20 rounded border border-white/10 bg-black/30 px-1 py-0.5 text-slate-200 tabular"
              />
            </label>
            <button
              type="button"
              className={BTN}
              onClick={() => seek(startS)}
              title="Seek to the first kept frame"
            >
              ▶ start
            </button>
            <button
              type="button"
              className={BTN}
              onClick={() => seek(Math.max(0, endS - 1 / fps))}
              title="Seek to the last kept frame"
            >
              ▶ end
            </button>
            <button
              type="button"
              className={BTN}
              disabled={decision.source === "rule" && !decision.reviewed}
              onClick={() => {
                const d = decisionFromProposal(proposal);
                writeTrim(repoId, episodeId, d);
                setDecision(d);
              }}
              title="Back to the rule's proposal"
            >
              reset to rule
            </button>
            <label className="flex items-center gap-1 text-slate-400">
              <input
                type="checkbox"
                checked={decision.reviewed}
                onChange={(e) => save({ reviewed: e.target.checked })}
              />
              reviewed
            </label>
            <span className="text-slate-600">
              rule: commanded arm motion from frame {proposal.onsetFrame ?? "—"}
              , measured motion to frame {proposal.motionEndFrame ?? "—"};
              margins {DEFAULT_TRIM_PARAMS.leadS} s /{" "}
              {DEFAULT_TRIM_PARAMS.tailS} s
            </span>
          </div>
        </>
      )}
    </div>
  );
}
