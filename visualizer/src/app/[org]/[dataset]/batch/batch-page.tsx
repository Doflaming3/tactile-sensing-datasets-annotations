"use client";
// Batch auto-annotation page (Jingyi's PR #1 request): one dataset-level
// page that runs the detector over every episode, shows the run live, and
// keeps a triage table a reviewer can click through. A run STAGES its
// proposals into this browser's local copies (the slot the viewer edits),
// so clicking a row opens the episode with exactly what the batch would
// commit; unsaved local edits are never overwritten. Commit sends the
// staged episodes, adjustments included, plus the report in ONE Hub commit.
// Speed: `workers` episodes run at once, each on its own Web Worker thread
// (lib/batchWorkers.ts), their fetches overlapping. Stop leaves a resumable
// run: Resume does only the episodes still owed, Rerun starts the range over.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getEpisodeDataSafe } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import HfAuthButton from "@/components/hf-auth-button";
import { useAuth } from "@/context/auth-context";
import { fetchRepoText } from "@/lib/annotateEpisode";
import {
  entriesForCommit,
  flagHistogram,
  isFlaggedRow,
  remainingEpisodes,
  runBatch,
  sortTriage,
  timingAverages,
  type BatchOutput,
  type BatchReport,
  type BatchRow,
} from "@/lib/batchAnnotate";
import {
  loadStoredBatch,
  saveStoredBatch,
  type StoredBatch,
} from "@/lib/batchStore";
import {
  coreCount,
  createBrowserPool,
  defaultWorkerCount,
  poolReader,
  type EpisodePool,
} from "@/lib/batchWorkers";
import {
  activeProfileFor,
  setSessionInterpretation,
  useSessionInterpretation,
} from "@/lib/interpretationOptIn";
import {
  clearStagedMarker,
  readLocalAtoms,
  readStagedMarker,
  stageLocalAtoms,
} from "@/lib/localAtoms";
import { useRigProfile } from "@/lib/useRigProfile";
import { authHeaders, getAuthToken } from "@/utils/auth";
import { findRawSensorCsvs } from "@/utils/episodeDiscovery";
import {
  BATCH_REPORT_PATH,
  commitBatchToHub,
  fetchAnnotationsFromHub,
  fetchBranchSha,
} from "@/utils/hubCommit";
import { parseRepoRef } from "@/utils/repoRef";
import {
  buildVersionedUrl,
  getDatasetVersionAndInfo,
  setDatasetPathPrefix,
  type DatasetInfo,
} from "@/utils/versionUtils";

type SortMode = "triage" | "episode";
type Filter = "all" | "flagged" | "failed" | "changed";

/** The staged files of the last run, in memory: they are also in the
 * per-episode local copies, this only spares a re-read after a client-side
 * trip into an episode and back. */
const outputCache = new Map<string, BatchOutput>();

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function summaryLine(report: BatchReport): string {
  const s = report.summary;
  return (
    `${report.aborted ? "stopped early (Resume continues where it left off): " : ""}${s.total} episodes — ` +
    `${s.ok} ok, ${s.flagged} flagged, ${s.failed} failed, ` +
    `${s.noTactile} without tactile data; ${s.changed} would change, ` +
    `${s.staged} staged in this browser` +
    (s.localEdits
      ? `, ${s.localEdits} with unsaved local edits left alone`
      : "")
  );
}

const TAB_LINK =
  "relative px-5 py-3 text-xs font-medium tracking-wide uppercase transition-colors text-slate-400 hover:text-slate-100";
const BTN =
  "text-xs px-3 py-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const BTN_CYAN = `${BTN} border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10`;
const BTN_AMBER = `${BTN} border-amber-500/40 text-amber-300 hover:bg-amber-500/10`;
const BTN_GREEN = `${BTN} border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10`;
const BTN_DIM = `${BTN} border-white/15 text-slate-300 hover:bg-white/5`;
const INPUT =
  "w-16 rounded border border-white/10 bg-black/30 px-1.5 py-1 text-xs text-slate-200 tabular";
const CHIP = "rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-300";

export default function BatchPage({
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
  // like the viewer: the loaders read the prefix, so it is set during render
  setDatasetPathPrefix(root);
  const rootQ = root ? `?root=${encodeURIComponent(root)}` : "";
  const pinned = parseRepoRef(repoId).pinned;

  // ---- dataset ---------------------------------------------------------
  const [info, setInfo] = useState<DatasetInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setInfoError(null);
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
  const episodes = useMemo(
    () =>
      info ? Array.from({ length: info.total_episodes }, (_, i) => i) : [],
    [info],
  );

  // ---- profile (same resolution as the viewer and the single panel) ----
  const profileOverride = searchParams.get("profile");
  const { profile, source: profileSource } = useRigProfile(
    repoId,
    profileOverride,
  );
  const sessionInterp = useSessionInterpretation();
  const activeProfile = useMemo(
    () => activeProfileFor(profile, sessionInterp),
    [profile, sessionInterp],
  );

  // ---- sign-in (OAuth, or a token pasted in another tab) ---------------
  const { oauth } = useAuth();
  const [, setAuthTick] = useState(0);
  useEffect(() => {
    const bump = () => setAuthTick((t) => t + 1);
    window.addEventListener("storage", bump);
    window.addEventListener("focus", bump);
    return () => {
      window.removeEventListener("storage", bump);
      window.removeEventListener("focus", bump);
    };
  }, []);
  const signedIn = !!oauth || !!getAuthToken();

  // ---- run state -------------------------------------------------------
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [useRaw, setUseRaw] = useState(true);
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    current: number;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<BatchOutput | null>(null);
  const [stored, setStored] = useState<StoredBatch | null>(null);
  const [note, setNote] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("triage");
  const [filter, setFilter] = useState<Filter>("all");
  const [hubReport, setHubReport] = useState<BatchReport | null>(null);
  const [viewingHub, setViewingHub] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // the worker threads live as long as the page: each keeps its decoded
  // data file and metadata, so a Resume or Rerun skips the cold starts
  const poolRef = useRef<{ size: number; pool: EpisodePool } | null>(null);
  const startedAtRef = useRef(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  // threads: half the machine, at most 4 (Zheng's rule); read on the client
  // only, so the server render and the hydration agree
  const [workers, setWorkers] = useState(1);
  const [cores, setCores] = useState(2);
  useEffect(() => {
    setCores(coreCount());
    setWorkers(defaultWorkerCount());
  }, []);
  const [inFlight, setInFlight] = useState<number[]>([]);
  // rows already there when this run started (a resume): the estimate
  // counts only what this run did
  const doneAtStartRef = useRef(0);

  const selected = useMemo(() => {
    const lo = from.trim() === "" ? -Infinity : Number(from);
    const hi = to.trim() === "" ? Infinity : Number(to);
    return episodes.filter((e) => e >= lo && e <= hi);
  }, [episodes, from, to]);

  // the last run of this dataset, restored after a trip into an episode
  useEffect(() => {
    const cached = outputCache.get(repoId) ?? null;
    setOutput(cached);
    const s = loadStoredBatch(repoId);
    setStored(s);
    setRows(s ? s.report.episodes : []);
    setProgress(null);
    setViewingHub(false);
    setNote(
      s
        ? `restored: run of ${fmtTime(s.report.startedAt)}${
            s.committedAt ? `, committed ${fmtTime(s.committedAt)}` : ""
          }`
        : "",
    );
  }, [repoId]);

  // the last batch committed to the Hub (from any browser), best effort
  useEffect(() => {
    let cancelled = false;
    setHubReport(null);
    fetch(buildVersionedUrl(repoId, "v3.0", BATCH_REPORT_PATH), {
      headers: authHeaders(),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: BatchReport | null) => {
        if (!cancelled && j && j.schema === "batch-report/1") setHubReport(j);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoId, root]);

  // a running batch dies with the page: stop it cleanly on unmount, and
  // let the threads go
  useEffect(
    () => () => {
      abortRef.current?.abort();
      poolRef.current?.pool.terminate();
      poolRef.current = null;
    },
    [],
  );

  // elapsed clock while running
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(
      () => setElapsedMs(performance.now() - startedAtRef.current),
      500,
    );
    return () => window.clearInterval(id);
  }, [running]);

  const start = useCallback(
    async (mode: "fresh" | "resume" = "fresh") => {
      if (!activeProfile) {
        setNote("calibration profile still loading — try again");
        return;
      }
      // resume: the stopped run's own episode list, its rows kept
      const prior = mode === "resume" ? (stored?.report ?? null) : null;
      const runEpisodes = prior ? prior.requested : selected;
      const priorRows = prior ? prior.episodes : [];
      const priorFiles = prior ? output?.files : undefined;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setRows(priorRows);
      setOutput(null);
      setStored(null);
      setViewingHub(false);
      setNote("");
      setRunning(true);
      setInFlight([]);
      doneAtStartRef.current = priorRows.length;
      startedAtRef.current = performance.now();
      setElapsedMs(0);
      setProgress({
        done: priorRows.length,
        total: runEpisodes.length,
        current: runEpisodes[0] ?? 0,
      });
      // one thread per worker, each reading and annotating whole episodes;
      // a dead worker's episodes fall back to this thread, so the run
      // still completes (without workers everything runs here), and a
      // fresh worker takes its place while restarts remain. The pool is
      // kept between runs unless the worker count changed.
      if (poolRef.current && poolRef.current.size !== workers) {
        poolRef.current.pool.terminate();
        poolRef.current = null;
      }
      if (!poolRef.current) {
        const created = createBrowserPool(
          workers,
          (message, jobs, restartable) =>
            setNote(
              `a worker died (${message}); ${jobs} episode(s) ran on the main thread instead; ` +
                (restartable
                  ? "a fresh worker takes its place"
                  : "the run goes on with one worker fewer"),
            ),
        );
        if (created) poolRef.current = { size: workers, pool: created };
      }
      const pool = poolRef.current?.pool ?? null;
      // the dataset's version at the start of a fresh run: Commit sends it
      // as the parent, so anything committed in between is never
      // overwritten (review of PR #3, item 3); a resume keeps the original
      const baseSha = prior
        ? (prior.baseSha ?? null)
        : await fetchBranchSha(repoId).catch(() => null);
      if (!prior && !baseSha)
        setNote(
          "could not read the dataset's version: the run goes on for review, but a commit of it will be refused — rerun when the Hub answers",
        );
      const readEpisode = pool
        ? poolReader(pool, {
            profile: activeProfile,
            org,
            dataset,
            root,
            useRaw,
            thresholds: {},
          })
        : undefined;
      try {
        const out = await runBatch({
          repoId,
          episodes: runEpisodes,
          profile: activeProfile,
          profileSource,
          thresholds: {},
          useRaw,
          loaders: {
            loadEpisode: (ep) => getEpisodeDataSafe(org, dataset, ep),
            listRawFiles: () => findRawSensorCsvs(repoId, root),
            fetchText: (p) => fetchRepoText(repoId, root, p),
            fetchExisting: (ep) => fetchAnnotationsFromHub(repoId, ep),
            readLocal: (ep) => readLocalAtoms(repoId, ep),
            readStaged: (ep) => readStagedMarker(repoId, ep),
          },
          stage: (ep, atoms) => stageLocalAtoms(repoId, ep, atoms),
          concurrency: workers,
          readEpisode,
          baseSha,
          resume: prior
            ? {
                rows: priorRows,
                files: priorFiles,
                startedAt: prior.startedAt,
                baseSha: prior.baseSha ?? null,
              }
            : undefined,
          onStart: (ep) => setInFlight((prev) => [...prev, ep]),
          onProgress: (row, done, total) => {
            setRows((prev) => [...prev, row]);
            setInFlight((prev) => prev.filter((e) => e !== row.episode));
            setProgress({ done, total, current: row.episode });
          },
          signal: ctrl.signal,
        });
        setElapsedMs(performance.now() - startedAtRef.current);
        setOutput(out);
        outputCache.set(repoId, out);
        const st: StoredBatch = { report: out.report, committedAt: null };
        saveStoredBatch(repoId, st);
        setStored(st);
        setNote(summaryLine(out.report));
      } catch (e) {
        setNote(`batch failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setRunning(false);
        setInFlight([]);
        abortRef.current = null;
      }
    },
    [
      activeProfile,
      profileSource,
      useRaw,
      selected,
      repoId,
      root,
      org,
      dataset,
      workers,
      stored,
      output,
    ],
  );

  // a stopped run can be continued while its episode list is still owed
  const remaining = useMemo(
    () => (stored?.report ? remainingEpisodes(stored.report) : []),
    [stored],
  );
  const resumable =
    !running && !viewingHub && !!stored?.report.aborted && remaining.length > 0;

  const stagedRows = useMemo(
    () => (viewingHub ? [] : rows.filter((r) => r.staged)),
    [rows, viewingHub],
  );

  const commit = useCallback(async () => {
    const rep = stored?.report ?? output?.report;
    if (!rep) return;
    if (!rep.baseSha) {
      setNote(
        "this run has no base version (the Hub did not answer at its start) — rerun it, then commit",
      );
      return;
    }
    // the local copies carry the reviewer's adjustments (the run's own file
    // when a copy is gone), each through the save rule for the active
    // profile (review of PR #3, item 4)
    const { entries, missing } = entriesForCommit(
      rep,
      (ep) => readLocalAtoms(repoId, ep),
      output?.files,
      activeProfile,
    );
    if (entries.length === 0) {
      setNote("nothing staged to commit");
      return;
    }
    if (
      !window.confirm(
        `Commit ${entries.length} annotation file(s) plus ${BATCH_REPORT_PATH} to ${parseRepoRef(repoId).repoId} in ONE commit?`,
      )
    )
      return;
    setNote("committing to the Hub…");
    try {
      const { paths } = await commitBatchToHub(repoId, entries, rep, {
        parentCommit: rep.baseSha,
      });
      // the committed rows are no longer staged: their markers go, a second
      // Commit has nothing to send, the table reads "committed"
      const sent = new Set(entries.map((e) => e.episodeId));
      for (const ep of sent) clearStagedMarker(repoId, ep);
      const report: BatchReport = {
        ...rep,
        episodes: rep.episodes.map((r) =>
          sent.has(r.episode) ? { ...r, staged: false, committed: true } : r,
        ),
      };
      const st: StoredBatch = {
        report,
        committedAt: new Date().toISOString(),
      };
      saveStoredBatch(repoId, st);
      setStored(st);
      setRows(report.episodes);
      setNote(
        `committed ${paths.length} file(s) in one commit` +
          (missing.length
            ? `; ${missing.length} staged episode(s) had no local copy any more and were skipped: ${missing.join(", ")}`
            : ""),
      );
    } catch (e) {
      setNote(`commit failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [stored, output, repoId]);

  // ---- table -----------------------------------------------------------
  const sourceRows: BatchRow[] = useMemo(
    () => (viewingHub ? (hubReport?.episodes ?? []) : rows),
    [viewingHub, hubReport, rows],
  );
  const visible = useMemo(() => {
    const sorted =
      sortMode === "triage"
        ? sortTriage(sourceRows)
        : [...sourceRows].sort((a, b) => a.episode - b.episode);
    switch (filter) {
      case "flagged":
        return sorted.filter(isFlaggedRow);
      case "failed":
        return sorted.filter((r) => r.status !== "ok");
      case "changed":
        return sorted.filter((r) => r.changed);
      default:
        return sorted;
    }
  }, [sourceRows, sortMode, filter]);
  const counts = useMemo(
    () => ({
      total: sourceRows.length,
      ok: sourceRows.filter((r) => r.status === "ok").length,
      flagged: sourceRows.filter(isFlaggedRow).length,
      failed: sourceRows.filter((r) => r.status === "failed").length,
      noTactile: sourceRows.filter((r) => r.status === "no_tactile").length,
      changed: sourceRows.filter((r) => r.changed).length,
      staged: sourceRows.filter((r) => r.staged).length,
      localEdits: sourceRows.filter((r) => r.localEdits).length,
    }),
    [sourceRows],
  );
  const histogram = useMemo(() => flagHistogram(sourceRows), [sourceRows]);
  const timing = useMemo(() => timingAverages(sourceRows), [sourceRows]);

  const commitBlocker = running
    ? "a run is in progress"
    : viewingHub
      ? "showing the Hub's last report, not a run of this browser"
      : pinned
        ? "pinned view: read-only"
        : !signedIn
          ? "sign in to commit"
          : stagedRows.length === 0
            ? stored?.committedAt
              ? `committed ${fmtTime(stored.committedAt)}; nothing left to send`
              : "nothing staged"
            : !(stored?.report.baseSha ?? output?.report.baseSha)
              ? "no base version for this run: rerun, then commit"
              : null;

  const openEpisode = () => {
    // land on the Annotations tab, where the staged atoms are
    try {
      sessionStorage.setItem("activeTab", "annotations");
    } catch {
      /* fine */
    }
  };
  const episodeHref = (ep: number) =>
    `/${org}/${dataset}/episode_${ep}${rootQ}`;
  // the whole row opens the episode (Zheng): a hover tint and a pointer
  // say so; a click on the number itself is the link's own business
  const rowClick =
    (ep: number) => (e: React.MouseEvent<HTMLTableRowElement>) => {
      if ((e.target as HTMLElement).closest("a")) return;
      openEpisode();
      router.push(episodeHref(ep));
    };

  const doneThisRun = progress ? progress.done - doneAtStartRef.current : 0;
  const eta =
    running && progress && doneThisRun > 0
      ? ((progress.total - progress.done) * elapsedMs) / doneThisRun
      : null;

  return (
    <div className="flex flex-col h-screen max-h-screen bg-[var(--bg)] text-[var(--text-primary)]">
      {/* top bar, in the viewer's register */}
      <div className="flex items-center border-b border-white/5 bg-[var(--surface-0)] shrink-0">
        <Link
          href={`/${org}/${dataset}/episode_0${rootQ}`}
          className={TAB_LINK}
          title="Back to the episode viewer"
        >
          ← Episodes
        </Link>
        <span className="relative px-5 py-3 text-xs font-medium tracking-wide uppercase text-cyan-300">
          Batch auto-label
          <span className="pointer-events-none absolute bottom-0 left-3 right-3 h-px bg-cyan-400 shadow-[0_0_8px_rgba(56,189,248,0.55)]" />
        </span>
        <div className="ml-auto">
          <HfAuthButton variant="tab" />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-3">
        {/* dataset + profile */}
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <p className="text-base font-medium text-slate-200">{repoId}</p>
          <p className="text-[10px] uppercase tracking-wide text-slate-500 tabular">
            {info
              ? `${info.total_episodes} episodes · ${info.fps} fps · ${info.codebase_version}`
              : (infoError ?? "loading dataset…")}
          </p>
          <p className="text-[11px] text-slate-400">
            {activeProfile
              ? `profile ${activeProfile.id} (${profileSource ?? "?"}) · ` +
                `${activeProfile.verified ? "verified" : "unverified: interpretation atoms are not saved"} · ` +
                `${activeProfile.interpretation ? "interpretation on" : "base mode"}` +
                ` · thresholds: profile defaults`
              : "profile loading…"}
            {activeProfile && !activeProfile.interpretation && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => setSessionInterpretation(true)}
                  className="text-sky-300 underline"
                  title="Interpretation layer for this session only; a reload returns to base mode"
                >
                  enable interpretation for this session
                </button>
              </>
            )}
          </p>
          {pinned && (
            <p className="text-[11px] text-amber-300">
              pinned view: read-only, commit disabled
            </p>
          )}
        </div>

        {/* controls */}
        <div className="panel-raised p-3 flex flex-wrap items-center gap-3 text-xs text-slate-300">
          <label className="flex items-center gap-1.5 text-slate-400">
            from
            <input
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="0"
              className={INPUT}
              disabled={running}
            />
          </label>
          <label className="flex items-center gap-1.5 text-slate-400">
            to
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={String(episodes[episodes.length - 1] ?? "")}
              className={INPUT}
              disabled={running}
            />
          </label>
          <label
            className="flex items-center gap-1.5 text-slate-400"
            title="Prefer the raw sidecar stream; the 30 Hz table is the fallback and is reported as such"
          >
            <input
              type="checkbox"
              checked={useRaw}
              onChange={(e) => setUseRaw(e.target.checked)}
              disabled={running}
            />
            use raw sidecar stream
          </label>
          <label
            className="flex items-center gap-1.5 text-slate-400"
            title={`Episodes handled at once, each on its own thread (Web Worker) for parsing and detection, their downloads overlapping. This machine reports ${cores} cores; the default is half of them, at most 4.`}
          >
            workers
            <input
              type="number"
              min={1}
              max={16}
              value={workers}
              onChange={(e) =>
                setWorkers(
                  Math.max(
                    1,
                    Math.min(16, Math.floor(Number(e.target.value)) || 1),
                  ),
                )
              }
              className={INPUT}
              disabled={running}
            />
            <span className="text-slate-600">of {cores} cores</span>
          </label>
          {!running ? (
            <>
              {resumable && (
                <button
                  type="button"
                  onClick={() => void start("resume")}
                  disabled={!activeProfile}
                  className={BTN_CYAN}
                  title={`Continue the stopped run: only the ${remaining.length} episode(s) it still owes, the rows so far kept`}
                >
                  Resume ({remaining.length} left)
                </button>
              )}
              <button
                type="button"
                onClick={() => void start("fresh")}
                disabled={selected.length === 0 || !activeProfile}
                className={resumable ? BTN_DIM : BTN_CYAN}
                title="Dry run: nothing goes to the Hub. Proposals are staged into this browser's local copies for review."
              >
                {resumable ? "Rerun" : "Run on"} {selected.length} episode(s)
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className={BTN_AMBER}
            >
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={() => void commit()}
            disabled={!!commitBlocker}
            className={BTN_GREEN}
            title={
              commitBlocker ??
              "One Hub commit: every staged episode file (with your adjustments) plus the batch report"
            }
          >
            Commit {stagedRows.length} staged episode(s)
          </button>
          {commitBlocker && !running && (
            <span className="text-[11px] text-slate-500">{commitBlocker}</span>
          )}
        </div>

        {/* progress */}
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
              {running ? ` — ${workers} worker(s)` : ""}
              {` — ${fmtDuration(elapsedMs)} elapsed`}
              {eta !== null ? ` — about ${fmtDuration(eta)} left` : ""}
              {running ? " — leaving this page stops the run" : ""}
            </div>
          </div>
        )}

        {note && <div className="text-[11px] text-slate-400">{note}</div>}

        {timing && (
          <div className="text-[11px] text-slate-500 tabular">
            per episode, average: load {Math.round(timing.load)} ms · raw
            sidecars {Math.round(timing.raw)} ms · Hub file{" "}
            {Math.round(timing.hub)} ms · detect {Math.round(timing.annotate)}{" "}
            ms (the three reads overlap)
          </div>
        )}

        {/* summary */}
        {sourceRows.length > 0 && (
          <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
            {(
              [
                ["episodes", counts.total, "text-slate-200"],
                ["ok", counts.ok, "text-slate-200"],
                ["flagged", counts.flagged, "text-amber-200"],
                ["failed", counts.failed, "text-red-300"],
                ["no tactile", counts.noTactile, "text-slate-400"],
                ["would change", counts.changed, "text-slate-200"],
                ["staged here", counts.staged, "text-cyan-300"],
                ["local edits kept", counts.localEdits, "text-amber-200"],
              ] as Array<[string, number, string]>
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

        {histogram.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
            <span className="mr-1">flags:</span>
            {histogram.map((h) => (
              <span key={h.kind} className={CHIP}>
                {h.kind} ×{h.count}
              </span>
            ))}
          </div>
        )}

        {/* table */}
        {sourceRows.length > 0 && (
          <div className="panel flex flex-col min-h-0 flex-1">
            <div className="flex flex-wrap items-center gap-3 px-3 py-2 border-b border-white/5 text-[11px] text-slate-400">
              <span>sort</span>
              {(["triage", "episode"] as SortMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setSortMode(m)}
                  className={
                    sortMode === m ? "text-cyan-300" : "hover:text-slate-200"
                  }
                >
                  {m}
                </button>
              ))}
              <span className="ml-3">show</span>
              {(["all", "flagged", "failed", "changed"] as Filter[]).map(
                (f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={
                      filter === f ? "text-cyan-300" : "hover:text-slate-200"
                    }
                  >
                    {f}
                  </button>
                ),
              )}
              <span className="ml-auto tabular">
                {visible.length} of {sourceRows.length}
                {viewingHub ? " — the Hub's last committed report" : ""}
              </span>
            </div>
            <div className="min-h-0 overflow-auto">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-[var(--surface-0)] text-slate-500">
                  <tr>
                    <th className="text-left font-normal px-3 py-1.5">
                      episode
                    </th>
                    <th className="text-left font-normal pr-3">status</th>
                    <th className="text-left font-normal pr-3">source</th>
                    <th className="text-right font-normal pr-3">events</th>
                    <th className="text-left font-normal pr-3">flags</th>
                    <th className="text-right font-normal pr-3">atoms</th>
                    <th className="text-left font-normal pr-3">change</th>
                    <th className="text-left font-normal pr-3">review copy</th>
                    <th className="text-right font-normal pr-3">ms</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr
                      key={r.episode}
                      onClick={rowClick(r.episode)}
                      title="Open this episode on the Annotations tab"
                      className={`border-t border-white/5 cursor-pointer transition-colors hover:bg-cyan-500/10 ${
                        r.status === "failed"
                          ? "text-red-300"
                          : isFlaggedRow(r)
                            ? "text-amber-200"
                            : "text-slate-300"
                      }`}
                    >
                      <td className="px-3 py-1 tabular">
                        <Link
                          href={episodeHref(r.episode)}
                          onClick={openEpisode}
                          className="underline decoration-white/30 hover:text-cyan-300"
                          title="Open this episode on the Annotations tab"
                        >
                          {r.episode}
                        </Link>
                      </td>
                      <td className="pr-3">
                        {r.status === "no_tactile" ? "no tactile" : r.status}
                      </td>
                      <td className="pr-3">
                        {r.source ?? "—"}
                        {r.rawFallback ? " (raw missing)" : ""}
                      </td>
                      <td className="pr-3 text-right tabular">{r.events}</td>
                      <td className="pr-3">
                        {r.error ? (
                          <span className="text-red-300">{r.error}</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {r.flags.map((f) => (
                              <span key={f} className={CHIP}>
                                {f}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="pr-3 text-right tabular">{r.atoms}</td>
                      <td className="pr-3">{r.changed ? "yes" : "same"}</td>
                      <td className="pr-3">
                        {r.committed ? (
                          <span className="text-emerald-300">committed</span>
                        ) : r.staged ? (
                          <span className="text-cyan-300">staged</span>
                        ) : r.localEdits ? (
                          <span className="text-amber-200">
                            local edits kept
                          </span>
                        ) : r.changed ? (
                          "not staged"
                        ) : (
                          "—"
                        )}
                      </td>
                      <td
                        className="pr-3 text-right tabular text-slate-500"
                        title={
                          r.timing
                            ? `load ${Math.round(r.timing.load)} · raw ${Math.round(r.timing.raw)} · hub ${Math.round(r.timing.hub)} · detect ${Math.round(r.timing.annotate)} ms`
                            : undefined
                        }
                      >
                        {Math.round(r.ms)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* the Hub's last committed batch */}
        {hubReport && (
          <div className="text-[11px] text-slate-500">
            Last batch committed to the Hub: {fmtTime(hubReport.startedAt)} ·{" "}
            {hubReport.summary.total} episodes · {hubReport.summary.flagged}{" "}
            flagged · {hubReport.summary.failed} failed ·{" "}
            {hubReport.detectorVersion}
            {" · "}
            <button
              type="button"
              onClick={() => setViewingHub((v) => !v)}
              className="text-sky-300 underline"
            >
              {viewingHub
                ? "back to this browser's run"
                : "show its triage list"}
            </button>
          </div>
        )}

        {sourceRows.length === 0 && !running && info && (
          <p className="text-[11px] text-slate-500">
            No run yet. A run is dry: it reads every selected episode, runs the
            detector, merges with the annotation file on the Hub (human atoms
            kept, auto atoms replaced) and stages the result in this browser.
            Open flagged episodes from the table, adjust, then commit everything
            in one go.
          </p>
        )}
      </div>
    </div>
  );
}
