"use client";
// Trim page (Jingyi's trim ask, cycle 3): every episode's proposed cut
// points from the arm's motion envelope, the reviewer's decisions from the
// trim panel, and the hand-off to the executor — the annotations backend's
// /api/trim, which writes the trimmed dataset (rows, episode metadata,
// video windows, sidecars, annotations) to a separate repo. The page itself
// never modifies the source dataset.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getEpisodeDataSafe } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import HfAuthButton from "@/components/hf-auth-button";
import { armSeriesFrom } from "@/lib/annotateEpisode";
import {
  commandSeriesFrom,
  DEFAULT_TRIM_PARAMS,
  proposeTrim,
} from "@/lib/trimDetect";
import {
  cutsFromDecisions,
  decisionFromProposal,
  listTrims,
  readTrim,
  writeTrim,
  type TrimDecision,
} from "@/lib/trimStore";
import { getAuthToken } from "@/utils/auth";
import { parseRepoRef } from "@/utils/repoRef";
import {
  getDatasetVersionAndInfo,
  setDatasetPathPrefix,
  type DatasetInfo,
} from "@/utils/versionUtils";

const BACKEND = process.env.NEXT_PUBLIC_ANNOTATE_BACKEND_URL ?? "";

const TAB_LINK =
  "relative px-5 py-3 text-xs font-medium tracking-wide uppercase transition-colors text-slate-400 hover:text-slate-100";
const BTN =
  "text-xs px-3 py-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const BTN_CYAN = `${BTN} border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10`;
const BTN_AMBER = `${BTN} border-amber-500/40 text-amber-300 hover:bg-amber-500/10`;
const BTN_GREEN = `${BTN} border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10`;
const BTN_DIM = `${BTN} border-white/15 text-slate-300 hover:bg-white/5`;
const INPUT =
  "rounded border border-white/10 bg-black/30 px-1.5 py-1 text-xs text-slate-200 tabular";
const CHIP = "rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-300";

interface Row {
  episode: number;
  decision: TrimDecision | null;
  error?: string;
}

/** A propose run, kept per dataset in this browser so a stopped run can be
 * resumed (the episodes still owed) or rerun, also after a trip into an
 * episode — the batch page's behaviour. */
interface TrimRun {
  requested: number[];
  done: number[];
  /** recompute rule proposals (Re-propose) or leave existing ones */
  overwrite: boolean;
  aborted: boolean;
  startedAt: string;
  finishedAt?: string;
}

function runKey(repoId: string): string {
  return `lerobot-trim-run:v1:${repoId}`;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s`;
}

function fmtS(f: number, fps: number): string {
  return (f / fps).toFixed(2);
}

export default function TrimPage({
  org,
  dataset,
}: {
  org: string;
  dataset: string;
}) {
  const repoId = `${org}/${dataset}`;
  const router = useRouter();
  const searchParams = useSearchParams();
  const root = searchParams.get("root");
  setDatasetPathPrefix(root);
  const rootQ = root ? `?root=${encodeURIComponent(root)}` : "";
  const pinned = parseRepoRef(repoId).pinned;

  const [info, setInfo] = useState<DatasetInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getDatasetVersionAndInfo(repoId)
      .then(({ info: i }) => {
        if (!cancelled) setInfo(i);
      })
      .catch((e) => {
        if (!cancelled)
          setInfoError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, root]);
  const fps = info?.fps ?? 30;
  const episodes = useMemo(
    () =>
      info ? Array.from({ length: info.total_episodes }, (_, i) => i) : [],
    [info],
  );

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const selected = useMemo(() => {
    const lo = from.trim() === "" ? -Infinity : Number(from);
    const hi = to.trim() === "" ? Infinity : Number(to);
    return episodes.filter((e) => e >= lo && e <= hi);
  }, [episodes, from, to]);

  // decisions already in this browser
  const [rows, setRows] = useState<Row[]>([]);
  const refresh = useCallback(() => {
    const m = listTrims(repoId);
    setRows(
      [...m]
        .sort((a, b) => a[0] - b[0])
        .map(([episode, decision]) => ({ episode, decision })),
    );
  }, [repoId]);
  useEffect(() => refresh(), [refresh]);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [note, setNote] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  // ---- runs: Stop leaves a resumable run, like the batch page ----------
  const [run, setRun] = useState<TrimRun | null>(null);
  const [inFlight, setInFlight] = useState<number[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef(0);
  const doneAtStartRef = useRef(0);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(runKey(repoId));
      setRun(raw ? (JSON.parse(raw) as TrimRun) : null);
    } catch {
      setRun(null);
    }
  }, [repoId]);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(
      () => setElapsedMs(performance.now() - startedAtRef.current),
      500,
    );
    return () => window.clearInterval(id);
  }, [running]);
  const saveRun = useCallback(
    (r: TrimRun) => {
      setRun(r);
      try {
        localStorage.setItem(runKey(repoId), JSON.stringify(r));
      } catch {
        /* storage unavailable */
      }
    },
    [repoId],
  );

  // propose for the selected episodes (fresh) or for what a stopped run
  // still owes (resume); a stored decision is never replaced unless
  // `overwrite`, and adjusted or reviewed ones never at all
  const propose = useCallback(
    async (mode: "fresh" | "resume", overwriteRule = false) => {
      const prior = mode === "resume" ? run : null;
      const requested = prior ? prior.requested : selected;
      const doneList = prior ? [...prior.done] : [];
      const overwrite = prior ? prior.overwrite : overwriteRule;
      const doneSet = new Set(doneList);
      const queue = requested.filter((ep) => !doneSet.has(ep));
      const record: TrimRun = {
        requested,
        done: doneList,
        overwrite,
        aborted: false,
        startedAt: prior?.startedAt ?? new Date().toISOString(),
      };
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setRunning(true);
      setNote("");
      setInFlight([]);
      doneAtStartRef.current = doneList.length;
      startedAtRef.current = performance.now();
      setElapsedMs(0);
      setProgress({ done: doneList.length, total: requested.length });
      let failed = 0;
      let kept = 0;
      let proposed = 0;
      let aborted = false;
      const worker = async () => {
        for (;;) {
          if (ctrl.signal.aborted) {
            if (queue.length) aborted = true;
            return;
          }
          const ep = queue.shift();
          if (ep === undefined) return;
          setInFlight((prev) => [...prev, ep]);
          try {
            const existing = readTrim(repoId, ep);
            if (
              existing &&
              (existing.source === "adjusted" ||
                existing.reviewed ||
                !overwrite)
            ) {
              kept++;
            } else {
              const { data, error } = await getEpisodeDataSafe(
                org,
                dataset,
                ep,
              );
              if (!data) throw new Error(error || "episode did not load");
              const p = proposeTrim(
                armSeriesFrom(data.flatChartData),
                commandSeriesFrom(data.flatChartData),
                data.datasetInfo.fps || fps,
                DEFAULT_TRIM_PARAMS,
                { totalFrames: data.frameTimestamps?.length },
              );
              if (!p) throw new Error("no joint signals");
              writeTrim(repoId, ep, decisionFromProposal(p));
              proposed++;
            }
          } catch {
            failed++;
          }
          doneList.push(ep);
          setInFlight((prev) => prev.filter((e) => e !== ep));
          setProgress({ done: doneList.length, total: requested.length });
          if (doneList.length % 5 === 0) refresh();
        }
      };
      await Promise.all([worker(), worker()]);
      refresh();
      saveRun({
        ...record,
        done: doneList,
        aborted,
        finishedAt: new Date().toISOString(),
      });
      setRunning(false);
      setInFlight([]);
      abortRef.current = null;
      setNote(
        `${aborted ? "stopped early (Resume continues where it left off): " : ""}` +
          `${doneList.length} of ${requested.length} episode(s): ${proposed} proposed, ` +
          `${kept} kept as they were (adjusted, reviewed, or already proposed), ${failed} failed`,
      );
    },
    [run, selected, repoId, org, dataset, fps, refresh, saveRun],
  );

  const remaining = useMemo(() => {
    if (!run) return [];
    const done = new Set(run.done);
    return run.requested.filter((e) => !done.has(e));
  }, [run]);
  const resumable = !running && !!run?.aborted && remaining.length > 0;
  const doneThisRun = progress ? progress.done - doneAtStartRef.current : 0;
  const eta =
    running && progress && doneThisRun > 0
      ? ((progress.total - progress.done) * elapsedMs) / doneThisRun
      : null;

  const decisions = useMemo(() => {
    const m = new Map<number, TrimDecision>();
    for (const r of rows) if (r.decision) m.set(r.episode, r.decision);
    return m;
  }, [rows]);
  const counts = useMemo(
    () => ({
      total: rows.length,
      reviewed: rows.filter((r) => r.decision?.reviewed).length,
      adjusted: rows.filter((r) => r.decision?.source === "adjusted").length,
      flagged: rows.filter((r) => (r.decision?.flags.length ?? 0) > 0).length,
      cutS: rows.reduce(
        (a, r) =>
          a +
          (r.decision
            ? (r.decision.nFrames -
                (r.decision.endFrame - r.decision.startFrame + 1)) /
              r.decision.fps
            : 0),
        0,
      ),
    }),
    [rows],
  );

  const cutsJson = useCallback(() => {
    return JSON.stringify(
      {
        schema: "trim-cuts/1",
        repoId,
        fps,
        cuts: cutsFromDecisions(decisions),
        decisions: [...decisions].map(([ep, d]) => ({ episode: ep, ...d })),
      },
      null,
      2,
    );
  }, [decisions, repoId, fps]);

  const download = useCallback(() => {
    const blob = new Blob([cutsJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${dataset}-trim-cuts.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [cutsJson, dataset]);

  // ---- executor: the annotations backend's /api/trim --------------------
  const [dst, setDst] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyNote, setApplyNote] = useState("");
  const apply = useCallback(async () => {
    if (!BACKEND || !dst.trim()) return;
    if (
      !window.confirm(
        `Write the trimmed dataset (${decisions.size} episode(s) with cuts) from ${parseRepoRef(repoId).repoId} to ${dst.trim()} through the backend at ${BACKEND}?`,
      )
    )
      return;
    setApplying(true);
    setApplyNote(
      "trimming — rows, episode metadata, video windows, sidecars, annotations…",
    );
    try {
      const res = await fetch(`${BACKEND}/api/trim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo_id: parseRepoRef(repoId).repoId,
          revision: parseRepoRef(repoId).revision ?? null,
          cuts: cutsFromDecisions(decisions),
          new_repo_id: dst.trim(),
          hf_token: getAuthToken(),
          push: true,
          commit_message: `Trim ${decisions.size} episode(s) to the arm's motion envelope`,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.detail ?? `${res.status}`);
      setApplyNote(
        `done: ${j.summary?.episodes ?? "?"} episodes, ${j.summary?.frames_before ?? "?"} → ${j.summary?.frames_after ?? "?"} frames${j.url ? ` — ${j.url}` : ` — ${j.output_dir}`}`,
      );
    } catch (e) {
      setApplyNote(
        `trim failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setApplying(false);
    }
  }, [dst, decisions, repoId]);

  const openEpisode = (ep: number) => {
    try {
      sessionStorage.setItem("activeTab", "annotations");
    } catch {
      /* fine */
    }
    router.push(`/${org}/${dataset}/episode_${ep}${rootQ}`);
  };

  return (
    <div className="flex flex-col h-screen max-h-screen bg-[var(--bg)] text-[var(--text-primary)]">
      <div className="flex items-center border-b border-white/5 bg-[var(--surface-0)] shrink-0">
        <Link
          href={`/${org}/${dataset}/episode_0${rootQ}`}
          className={TAB_LINK}
        >
          ← Episodes
        </Link>
        <span className="relative px-5 py-3 text-xs font-medium tracking-wide uppercase text-cyan-300">
          Trim
          <span className="pointer-events-none absolute bottom-0 left-3 right-3 h-px bg-cyan-400 shadow-[0_0_8px_rgba(56,189,248,0.55)]" />
        </span>
        <div className="ml-auto">
          <HfAuthButton variant="tab" />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <p className="text-base font-medium text-slate-200">{repoId}</p>
          <p className="text-[10px] uppercase tracking-wide text-slate-500 tabular">
            {info
              ? `${info.total_episodes} episodes · ${info.fps} fps · ${info.codebase_version}`
              : (infoError ?? "loading dataset…")}
          </p>
          <p className="text-[11px] text-slate-400">
            rule: keep from {DEFAULT_TRIM_PARAMS.leadS} s before the commanded
            arm first moves to {DEFAULT_TRIM_PARAMS.tailS} s after the measured
            arm last moves (her own cuts, read off sotac_raw)
          </p>
          {pinned && <p className="text-[11px] text-amber-300">pinned view</p>}
        </div>

        <div className="panel-raised p-3 flex flex-wrap items-center gap-3 text-xs text-slate-300">
          <label className="flex items-center gap-1.5 text-slate-400">
            from
            <input
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="0"
              className={`${INPUT} w-16`}
              disabled={running}
            />
          </label>
          <label className="flex items-center gap-1.5 text-slate-400">
            to
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={String(episodes[episodes.length - 1] ?? "")}
              className={`${INPUT} w-16`}
              disabled={running}
            />
          </label>
          {!running ? (
            <>
              {resumable && (
                <button
                  type="button"
                  onClick={() => void propose("resume")}
                  className={BTN_CYAN}
                  title={`Continue the stopped run: only the ${remaining.length} episode(s) it still owes`}
                >
                  Resume ({remaining.length} left)
                </button>
              )}
              <button
                type="button"
                onClick={() => void propose("fresh", false)}
                disabled={selected.length === 0}
                className={resumable ? BTN_DIM : BTN_CYAN}
                title="Propose cut points for episodes that have none yet; adjusted and reviewed ones are never touched"
              >
                {resumable ? "Rerun" : "Propose cuts for"} {selected.length}{" "}
                episode(s)
              </button>
              <button
                type="button"
                onClick={() => void propose("fresh", true)}
                disabled={selected.length === 0}
                className={BTN_AMBER}
                title="Recompute the rule's proposals; adjusted and reviewed ones are still kept"
              >
                Re-propose
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className={BTN_AMBER}
              title="Stop after the episodes in flight; Resume picks up the rest"
            >
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={download}
            disabled={decisions.size === 0}
            className={BTN}
            title="The cuts as JSON (trim-cuts/1), for backend/trim.py"
          >
            Download cuts.json
          </button>
        </div>

        {progress && (
          <div className="flex flex-col gap-1">
            <div className="h-1.5 w-full rounded bg-white/10">
              <div
                className="h-1.5 rounded bg-cyan-400/70 transition-[width]"
                style={{
                  width: `${progress.total ? (100 * progress.done) / progress.total : 0}%`,
                }}
              />
            </div>
            <div className="text-[11px] text-slate-400 tabular">
              {progress.done} / {progress.total}
              {running && inFlight.length > 0
                ? ` — in flight: ${[...inFlight].sort((a, b) => a - b).join(", ")}`
                : ""}
              {` — ${fmtDuration(elapsedMs)} elapsed`}
              {eta !== null ? ` — about ${fmtDuration(eta)} left` : ""}
              {running ? " — leaving this page stops the run" : ""}
            </div>
          </div>
        )}
        {note && <div className="text-[11px] text-slate-400">{note}</div>}

        {rows.length > 0 && (
          <div className="grid grid-cols-5 gap-2">
            {(
              [
                ["episodes with cuts", counts.total, "text-slate-200"],
                ["reviewed", counts.reviewed, "text-emerald-300"],
                ["adjusted", counts.adjusted, "text-amber-200"],
                ["flagged", counts.flagged, "text-amber-200"],
                [
                  "dead time to cut",
                  `${counts.cutS.toFixed(0)} s`,
                  "text-slate-200",
                ],
              ] as Array<[string, number | string, string]>
            ).map(([label, value, cls]) => (
              <div key={label} className="panel p-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">
                  {label}
                </div>
                <div className={`text-lg tabular ${cls}`}>{value}</div>
              </div>
            ))}
          </div>
        )}

        {rows.length > 0 && (
          <div className="panel flex flex-col min-h-0 flex-1">
            <div className="min-h-0 overflow-auto">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-[var(--surface-0)] text-slate-500">
                  <tr>
                    <th className="text-left font-normal px-3 py-1.5">
                      episode
                    </th>
                    <th className="text-right font-normal pr-3">frames</th>
                    <th className="text-left font-normal pr-3">keep (s)</th>
                    <th className="text-right font-normal pr-3">
                      cut before (s)
                    </th>
                    <th className="text-right font-normal pr-3">
                      cut after (s)
                    </th>
                    <th className="text-left font-normal pr-3">flags</th>
                    <th className="text-left font-normal pr-3">status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const d = r.decision;
                    return (
                      <tr
                        key={r.episode}
                        onClick={() => openEpisode(r.episode)}
                        title="Open this episode on the Annotations tab, where the trim panel is"
                        className={`border-t border-white/5 cursor-pointer transition-colors hover:bg-cyan-500/10 ${
                          d?.reviewed
                            ? "text-slate-300"
                            : d?.source === "adjusted"
                              ? "text-amber-200"
                              : "text-slate-400"
                        }`}
                      >
                        <td className="px-3 py-1 tabular">{r.episode}</td>
                        <td className="pr-3 text-right tabular">
                          {d?.nFrames ?? "—"}
                        </td>
                        <td className="pr-3 tabular">
                          {d
                            ? `${fmtS(d.startFrame, d.fps)} – ${fmtS(d.endFrame + 1, d.fps)}`
                            : "—"}
                        </td>
                        <td className="pr-3 text-right tabular">
                          {d ? fmtS(d.startFrame, d.fps) : "—"}
                        </td>
                        <td className="pr-3 text-right tabular">
                          {d ? fmtS(d.nFrames - d.endFrame - 1, d.fps) : "—"}
                        </td>
                        <td className="pr-3">
                          <span className="flex flex-wrap gap-1">
                            {(d?.flags ?? []).map((f) => (
                              <span key={f} className={CHIP}>
                                {f}
                              </span>
                            ))}
                          </span>
                        </td>
                        <td className="pr-3">
                          {d?.reviewed
                            ? "reviewed"
                            : d?.source === "adjusted"
                              ? "adjusted"
                              : "rule"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* the executor */}
        <div className="panel-raised p-3 flex flex-col gap-2 text-xs text-slate-300">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">
            Apply the trim
          </div>
          {BACKEND ? (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-slate-400">
                write to dataset repo
                <input
                  value={dst}
                  onChange={(e) => setDst(e.target.value)}
                  placeholder="org/name-trimmed"
                  className={`${INPUT} w-64`}
                  disabled={applying}
                />
              </label>
              <button
                type="button"
                onClick={() => void apply()}
                disabled={
                  applying ||
                  decisions.size === 0 ||
                  !dst.trim() ||
                  !getAuthToken()
                }
                className={BTN_GREEN}
                title={
                  !getAuthToken()
                    ? "sign in first: the backend pushes with your token"
                    : "Backend: rows re-based, episode metadata, video windows re-pointed, sidecars cut, annotations shifted; pushed to the new repo. The source dataset is never modified."
                }
              >
                Trim {decisions.size} episode(s) → new repo
              </button>
              {applyNote && (
                <span className="text-[11px] text-slate-400">{applyNote}</span>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-slate-500">
              The cut itself runs in the annotations backend (see the README:
              start it and set NEXT_PUBLIC_ANNOTATE_BACKEND_URL), which writes
              the trimmed dataset to a separate repo and never touches this one.
              Without it, download cuts.json and run{" "}
              <code>python backend/trim.py --cuts cuts.json</code>.
            </p>
          )}
        </div>

        {rows.length === 0 && !running && info && (
          <p className="text-[11px] text-slate-500">
            No cuts yet. Propose them for a range, open the flagged episodes
            from the table and adjust the handles in the Annotations tab, mark
            them reviewed, then apply.
          </p>
        )}
      </div>
    </div>
  );
}
