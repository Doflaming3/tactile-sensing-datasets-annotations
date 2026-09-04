"use client";

import { useState, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { postParentMessageWithParams } from "@/utils/postParentMessage";
import { hubRepoPageUrl } from "@/utils/repoRef";
import { SimpleVideosPlayer } from "@/components/simple-videos-player";
import PlaybackBar from "@/components/playback-bar";
import { TimeProvider, useTime } from "@/context/time-context";
import { FlaggedEpisodesProvider } from "@/context/flagged-episodes-context";
import {
  AnnotationsProvider,
  useAnnotations,
} from "@/context/annotations-context";
import { AnnotationsPanel } from "@/components/annotations-panel";
import { AnnotationsTimeline } from "@/components/annotations-timeline";
import AutoLabelPanel from "@/components/auto-label-panel";
import Sidebar from "@/components/side-nav";
import StatsPanel from "@/components/stats-panel";
import OverviewPanel from "@/components/overview-panel";
import Loading from "@/components/loading-component";
import HfAuthButton from "@/components/hf-auth-button";
import { hasURDFSupport } from "@/lib/so101-robot";
import {
  getAdjacentEpisodesVideoInfo,
  computeColumnMinMax,
  getEpisodeDataSafe,
  loadAllEpisodeLengthsV3,
  loadAllEpisodeFrameInfo,
  loadCrossEpisodeActionVariance,
  type EpisodeData,
  type ColumnMinMax,
  type EpisodeLengthStats,
  type EpisodeFramesData,
  type CrossEpisodeVarianceData,
} from "./fetch-data";
import {
  getDatasetVersionAndInfo,
  setDatasetPathPrefix,
  buildVersionedUrl,
} from "@/utils/versionUtils";
import {
  discoverEpisodeFolders,
  listRepoFiles,
} from "@/utils/episodeDiscovery";
import { loadFolderEpisodeLengths } from "@/utils/folderStats";
import { authHeaders } from "@/utils/auth";
import type { DatasetMetadata } from "@/utils/parquetUtils";

const URDFViewer = lazy(() => import("@/components/urdf-viewer"));
const ActionInsightsPanel = lazy(
  () => import("@/components/action-insights-panel"),
);
const FilteringPanel = lazy(() => import("@/components/filtering-panel"));
// Recharts is ~150KB gz and not above-the-fold (videos render first on the
// Episodes tab). Lazy-load it so the initial chunk can ship faster and
// videos start downloading in parallel with the chart bundle.
const DataRecharts = lazy(() => import("@/components/data-recharts"));
// Three.js canvas; only mounted when the dataset has observation.sensors.*
// taxel arrays, so non-tactile datasets pay nothing.
const TactilePanel = lazy(() => import("@/components/tactile-panel"));
const TactileStats = lazy(() =>
  import("@/components/tactile-panel").then((m) => ({
    default: m.TactileStats,
  })),
);
const RgbdPanel = lazy(() => import("@/components/rgbd-panel"));
// light, no heavy deps — safe to import statically for the dashboard tiles
import { RgbdStreamView, useRgbdCams } from "@/components/rgbd-panel";
const TactileFingerView = lazy(() =>
  import("@/components/tactile-panel").then((m) => ({
    default: m.TactileFingerView,
  })),
);
const TactileSummary = lazy(() =>
  import("@/components/tactile-panel").then((m) => ({
    default: m.TactileSummary,
  })),
);
// non-component helper: resolved lazily, cached
let tactileLabelsFn:
  | ((sf: NonNullable<EpisodeData["sensorFrames"]>) => string[])
  | null = null;
import("@/components/tactile-panel").then((m) => {
  tactileLabelsFn = m.tactileChannelLabels;
});
const TactileAggregate = lazy(() =>
  import("@/components/tactile-panel").then((m) => ({
    default: m.TactileAggregate,
  })),
);

/** Skip global playback / navigation shortcuts while typing in a field. */
function isKeyboardFocusInsideTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
    return true;
  }
  const tag = target.tagName;
  return (
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "INPUT" ||
    tag === "BUTTON" ||
    (tag === "A" && target.hasAttribute("href"))
  );
}

type ActiveTab =
  | "episodes"
  | "annotations"
  | "statistics"
  | "frames"
  | "insights"
  | "filtering"
  | "doctor"
  | "urdf";

// Subscribes to `currentTime` so its parent doesn't have to. Keeping this
// in a leaf component means the throttled time ticks (~12.5/s during
// playback) only re-render this no-op sub-tree, not the entire 700-line
// EpisodeViewerInner. Vercel rule: rerender-defer-reads.
function UrlTimeSync() {
  const { currentTime, isPlaying } = useTime();
  const searchParams = useSearchParams();
  const lastUrlSecondRef = useRef<number>(-1);

  // Only update the URL ?t= param when the integer second changes, and
  // only while paused — replacing state every frame during playback would
  // spam the browser's history.
  useEffect(() => {
    if (isPlaying) return;
    const currentSec = Math.floor(currentTime);
    if (currentTime > 0 && lastUrlSecondRef.current !== currentSec) {
      lastUrlSecondRef.current = currentSec;
      const newParams = new URLSearchParams(searchParams.toString());
      newParams.set("t", currentSec.toString());
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}?${newParams.toString()}`,
      );
      postParentMessageWithParams((params: URLSearchParams) => {
        params.set("path", window.location.pathname + window.location.search);
      });
    }
  }, [isPlaying, currentTime, searchParams]);

  return null;
}

// Hoisted to module scope. Defining inside EpisodeViewerInner created a new
// component type on every parent render — and the parent re-renders ~12.5×/s
// during playback because it consumes `currentTime` from useTime. React
// would unmount and remount every tab on every tick.
function TabButton({
  active,
  onClick,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`relative px-5 py-3 text-xs font-medium tracking-wide uppercase transition-colors ${
        active ? "text-cyan-300" : "text-slate-400 hover:text-slate-100"
      }`}
    >
      {label}
      <span
        className={`pointer-events-none absolute bottom-0 left-3 right-3 h-px transition-all ${
          active
            ? "bg-cyan-400 shadow-[0_0_8px_rgba(56,189,248,0.55)]"
            : "bg-transparent"
        }`}
      />
    </button>
  );
}

export default function EpisodeViewer({
  org,
  dataset,
  episodeId,
}: {
  org: string;
  dataset: string;
  episodeId: number;
}) {
  const [data, setData] = useState<EpisodeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  // `?root=` must be applied HERE (the component that fetches), not in the
  // inner viewer — by the time the inner tree renders, the data load has
  // already started. Render-time + idempotent, so it's set before the
  // effect below runs.
  const rootParam = useSearchParams().get("root");
  setDatasetPathPrefix(rootParam);

  // Track recently-visited datasets for the home page.
  useEffect(() => {
    try {
      const key = "recent_datasets";
      const id = `${org}/${dataset}`;
      const prev: string[] = JSON.parse(localStorage.getItem(key) ?? "[]");
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, 8);
      localStorage.setItem(key, JSON.stringify(next));
    } catch {}
  }, [org, dataset]);

  const router = useRouter();
  const [folderList, setFolderList] = useState<string[] | null>(null);
  const [companyTask, setCompanyTask] = useState<Record<string, string> | null>(
    null,
  );
  const [epAnnotation, setEpAnnotation] = useState<EpisodeAnnotation | null>(
    null,
  );

  // Folder-episode datasets: discover the per-episode folders so the
  // sidebar can list them; and when the user lands on the bare repo (root
  // info.json 404s), auto-redirect to the first folder — "type the dataset
  // name and browse" without knowing about ?root=.
  useEffect(() => {
    let cancelled = false;
    discoverEpisodeFolders(`${org}/${dataset}`)
      .then((folders) => {
        if (!cancelled) setFolderList(folders);
      })
      .catch(() => {
        if (!cancelled) setFolderList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [org, dataset]);

  useEffect(() => {
    if (!error || rootParam) return;
    if (folderList && folderList.length > 0) {
      router.replace(`./0?root=${encodeURIComponent(folderList[0])}`);
    }
  }, [error, rootParam, folderList, router]);

  useEffect(() => {
    if (Number.isNaN(episodeId)) {
      setError("Invalid episode id.");
      setData(null);
      return;
    }
    const requestId = ++requestIdRef.current;
    setError(null);
    setData(null);
    const augmentExtraCameras = async (loaded: EpisodeData) => {
      // Company-format episodes ship extra cameras (RGB_Camera0..5, RGBD_*)
      // that are NOT registered in meta/info.json features — the standard
      // video extraction misses them. Surface every playable .mp4 in the
      // episode's videos/ tree (.mkv depth streams skipped: <video> can't
      // decode them).
      if (!rootParam) return loaded;
      try {
        const cleanRoot = rootParam.replace(/^\/+|\/+$/g, "");
        const files = await listRepoFiles(`${org}/${dataset}`);
        const prefix = `${cleanRoot}/videos/`;
        const have = new Set(loaded.videosInfo.map((v) => v.filename));
        const extras = files
          .filter(
            (f) =>
              f.startsWith(prefix) &&
              f.toLowerCase().endsWith(".mp4") &&
              !f.slice(prefix.length).startsWith("observation."),
          )
          .map((f) => {
            const rel = f.slice(cleanRoot.length + 1);
            const name = rel.split("/")[1] ?? rel;
            return {
              filename: name,
              url: buildVersionedUrl(`${org}/${dataset}`, "v3.0", rel),
            };
          })
          .filter((v) => !have.has(v.filename));
        if (extras.length) {
          return { ...loaded, videosInfo: [...loaded.videosInfo, ...extras] };
        }
      } catch {
        /* extra cameras are best-effort */
      }
      return loaded;
    };

    // Company-format episodes carry a rich task.json (instruction, result,
    // failure reason). Best-effort fetch; null for normal datasets.
    setCompanyTask(null);
    if (rootParam) {
      fetch(buildVersionedUrl(`${org}/${dataset}`, "v3.0", "task.json"), {
        headers: authHeaders(),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (requestIdRef.current === requestId && j) setCompanyTask(j);
        })
        .catch(() => {});
    }

    // Curated tactile datasets ship per-episode review annotations
    // (annotations/episode_annotations.json). Best-effort; null when absent.
    setEpAnnotation(null);
    if (!rootParam) {
      fetch(
        buildVersionedUrl(
          `${org}/${dataset}`,
          "v3.0",
          "annotations/episode_annotations.json",
        ),
        { headers: authHeaders() },
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (requestIdRef.current === requestId)
            setEpAnnotation(j?.episodes?.[String(episodeId)] ?? null);
        })
        .catch(() => {});
    }

    getEpisodeDataSafe(org, dataset, episodeId)
      .then(async ({ data: loaded, error: loadError }) => {
        if (requestIdRef.current !== requestId) return;
        if (loadError) {
          setError(loadError);
          setData(null);
          return;
        }
        const augmented = loaded ? await augmentExtraCameras(loaded) : null;
        if (requestIdRef.current !== requestId) return;
        setData(augmented);
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message || "Unknown error");
        setData(null);
      });
  }, [org, dataset, episodeId, rootParam]);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)] text-red-300">
        <div className="panel-raised max-w-xl p-6 border-red-500/40">
          <h2 className="text-xl font-medium mb-3">Something went wrong</h2>
          <p className="text-sm font-mono whitespace-pre-wrap text-red-200/90">
            {error}
          </p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="relative h-screen bg-[var(--bg)]">
        <Loading />
      </div>
    );
  }

  return (
    <TimeProvider duration={data!.duration}>
      <FlaggedEpisodesProvider>
        <AnnotationsProvider>
          <EpisodeBootstrap data={data!} />
          <EpisodeViewerInner
            data={data!}
            org={org}
            dataset={dataset}
            folderList={folderList}
            companyTask={companyTask}
            epAnnotation={epAnnotation}
          />
        </AnnotationsProvider>
      </FlaggedEpisodesProvider>
    </TimeProvider>
  );
}

/** Wires the loaded episode into the AnnotationsProvider. */
function EpisodeBootstrap({ data }: { data: EpisodeData }) {
  const { setEpisode } = useAnnotations();
  useEffect(() => {
    setEpisode(
      data.episodeId,
      { repoId: data.datasetInfo.repoId },
      data.languageAtoms,
      data.frameTimestamps,
    );
  }, [
    data.episodeId,
    data.datasetInfo.repoId,
    data.languageAtoms,
    data.frameTimestamps,
    setEpisode,
  ]);
  return null;
}

type EpisodeAnnotation = {
  source_raw_episode?: number;
  task?: string;
  result?: string;
  attempts?: number;
  grasp?: string;
  distractor?: string;
  events?: string[];
  reviewed?: boolean;
};

function AnnotationBadges({ a }: { a: EpisodeAnnotation }) {
  const resultColor =
    a.result === "failure"
      ? "bg-red-500/15 text-red-300"
      : a.result === "partial"
        ? "bg-yellow-500/15 text-yellow-300"
        : "bg-emerald-500/15 text-emerald-300";
  return (
    <div className="mt-2 flex items-center gap-2 flex-wrap text-[11px]">
      {a.result && (
        <span className={`px-2 py-0.5 rounded ${resultColor}`}>{a.result}</span>
      )}
      {typeof a.attempts === "number" && a.attempts > 1 && (
        <span className="px-2 py-0.5 rounded bg-white/5 text-slate-300">
          {a.attempts} attempts
        </span>
      )}
      {a.grasp && (
        <span className="px-2 py-0.5 rounded bg-white/5 text-slate-300">
          grasp: {a.grasp}
        </span>
      )}
      {a.distractor && (
        <span className="px-2 py-0.5 rounded bg-cyan-400/10 text-cyan-300">
          distractor: {a.distractor}
        </span>
      )}
      {typeof a.source_raw_episode === "number" && (
        <span
          className="px-2 py-0.5 rounded bg-white/5 text-slate-500 tabular"
          title="episode index in the append-only raw dataset"
        >
          raw #{a.source_raw_episode}
        </span>
      )}
      {a.events && a.events.length > 0 && (
        <span className="w-full text-slate-400">{a.events.join(" · ")}</span>
      )}
    </div>
  );
}

function EpisodeViewerInner({
  data,
  org,
  dataset,
  folderList,
  companyTask,
  epAnnotation,
}: {
  data: EpisodeData;
  org?: string;
  dataset?: string;
  folderList?: string[] | null;
  companyTask?: Record<string, string> | null;
  epAnnotation?: EpisodeAnnotation | null;
}) {
  const {
    datasetInfo,
    episodeId,
    videosInfo,
    chartDataGroups,
    episodes,
    task,
  } = data;

  // ---- folder-episode mode (per-episode-folder datasets) ----------------
  // When the repo has no root dataset but a list of episode folders, the
  // sidebar and prev/next navigation operate on VIRTUAL episode indices
  // 0..n-1 that map to folders; switching episode = switching ?root=.
  const innerRootParam = useSearchParams().get("root");
  const folderMode = !!(folderList && folderList.length > 0 && innerRootParam);
  const folderIdx = folderMode
    ? Math.max(0, folderList!.indexOf(innerRootParam!))
    : -1;
  const effEpisodes = folderMode ? folderList!.map((_, i) => i) : episodes;
  const effEpisodeId = folderMode ? folderIdx : episodeId;
  const folderLabels = folderMode ? folderList! : undefined;

  const [videosReady, setVideosReady] = useState(!videosInfo.length);
  const [chartsReady, setChartsReady] = useState(false);

  // Gripper trajectory for the tactile auto-labeler (subtask anchors).
  // Chart rows carry real parquet timestamps (episode-relative) since the
  // fetch-data fix — no axis correction needed here.
  const gripperSeries = useMemo(() => {
    const rows = data.flatChartData;
    if (!rows || rows.length === 0) return null;
    const key = Object.keys(rows[0]).find(
      (k) => /gripper/i.test(k) && !/^action/i.test(k),
    );
    if (!key) return null;
    const t: number[] = [];
    const pos: number[] = [];
    for (const r of rows) {
      const ts = r["timestamp"];
      const v = r[key];
      if (typeof ts === "number" && typeof v === "number") {
        t.push(ts);
        pos.push(v);
      }
    }
    return t.length > 2 ? { t, pos } : null;
  }, [data.flatChartData]);

  // Arm joint positions (gripper excluded) for the tactile auto-labeler —
  // the transport boundary anchors to the arm starting to CARRY, judged by
  // speed plus net directional rotation, which grip force cannot see.
  const armSeries = useMemo(() => {
    const rows = data.flatChartData;
    if (!rows || rows.length === 0) return null;
    const keys = Object.keys(rows[0]).filter(
      (k) => /\.pos$/i.test(k) && !/^action/i.test(k) && !/gripper/i.test(k),
    );
    if (keys.length === 0) return null;
    const t: number[] = [];
    const joints: number[][] = [];
    for (const r of rows) {
      const ts = r["timestamp"];
      if (typeof ts !== "number") continue;
      const row = keys.map((k) =>
        typeof r[k] === "number" ? (r[k] as number) : NaN,
      );
      if (row.some((v) => Number.isNaN(v))) continue;
      t.push(ts);
      joints.push(row);
    }
    return t.length > 2 ? { t, joints } : null;
  }, [data.flatChartData]);

  const loadStartRef = useRef(performance.now());

  const router = useRouter();
  const searchParams = useSearchParams();

  // `?root=<subdir>` points the loaders at a dataset rooted in a repo
  // sub-folder (per-episode-folder tactile datasets). Set during render so
  // it is in place before ANY data-loading effect runs; idempotent.
  setDatasetPathPrefix(searchParams.get("root"));

  // Tab state & lazy stats — read sessionStorage in the initializer so the
  // correct tab renders on the very first frame (no post-mount flash).
  // Safe because EpisodeViewerInner only mounts client-side (behind a loading gate).
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => {
    if (typeof window !== "undefined") {
      const stored = sessionStorage.getItem("activeTab");
      if (
        stored &&
        [
          "episodes",
          "annotations",
          "statistics",
          "frames",
          "insights",
          "filtering",
          "urdf",
        ].includes(stored)
      ) {
        return stored as ActiveTab;
      }
    }
    return "episodes";
  });
  const isLoading = activeTab === "episodes" && (!videosReady || !chartsReady);

  useEffect(() => {
    if (!isLoading) {
      console.log(
        `[perf] Loading complete in ${(performance.now() - loadStartRef.current).toFixed(0)}ms (videos: ${videosReady ? "✓" : "…"}, charts: ${chartsReady ? "✓" : "…"})`,
      );
    }
  }, [isLoading, videosReady, chartsReady]);
  const [, setColumnMinMax] = useState<ColumnMinMax[] | null>(null);
  const [episodeLengthStats, setEpisodeLengthStats] =
    useState<EpisodeLengthStats | null>(null);
  const [folderTotalFrames, setFolderTotalFrames] = useState<number | null>(
    null,
  );
  const [statsLoading, setStatsLoading] = useState(false);
  const statsLoadedRef = useRef(false);
  const [episodeFramesData, setEpisodeFramesData] =
    useState<EpisodeFramesData | null>(null);
  const [framesLoading, setFramesLoading] = useState(false);
  const framesLoadedRef = useRef(false);
  const [framesFlaggedOnly, setFramesFlaggedOnly] = useState(() =>
    typeof window !== "undefined"
      ? sessionStorage.getItem("framesFlaggedOnly") === "true"
      : false,
  );
  const [sidebarFlaggedOnly, setSidebarFlaggedOnly] = useState(() =>
    typeof window !== "undefined"
      ? sessionStorage.getItem("sidebarFlaggedOnly") === "true"
      : false,
  );
  const [crossEpData, setCrossEpData] =
    useState<CrossEpisodeVarianceData | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const insightsLoadedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    statsLoadedRef.current = false;
    framesLoadedRef.current = false;
    insightsLoadedRef.current = false;
    setEpisodeLengthStats(null);
    setEpisodeFramesData(null);
    setCrossEpData(null);
  }, [datasetInfo.repoId]);

  // Eagerly load the URDFViewer bundle + warm the STL geometry cache while
  // the user is on the Episodes tab, so the 3D Replay tab opens faster.
  useEffect(() => {
    if (
      hasURDFSupport(datasetInfo.robot_type) &&
      datasetInfo.codebase_version >= "v3.0"
    ) {
      void import("@/components/urdf-viewer");
    }
  }, [datasetInfo.robot_type, datasetInfo.codebase_version]);

  // Persist UI state across episode navigations. One effect instead of
  // three near-identical writes — fewer commit hooks per render and the
  // intent (mirror three primitives to sessionStorage) reads as one unit.
  useEffect(() => {
    sessionStorage.setItem("activeTab", activeTab);
    sessionStorage.setItem("sidebarFlaggedOnly", String(sidebarFlaggedOnly));
    sessionStorage.setItem("framesFlaggedOnly", String(framesFlaggedOnly));
  }, [activeTab, sidebarFlaggedOnly, framesFlaggedOnly]);

  const loadStats = () => {
    if (statsLoadedRef.current) return;
    statsLoadedRef.current = true;
    setStatsLoading(true);
    setColumnMinMax(computeColumnMinMax(data.chartDataGroups));
    if (org && dataset) {
      const repoId = `${org}/${dataset}`;
      // Folder-episode datasets: every folder is a 1-episode dataset, so the
      // per-dataset loader would report a single episode. Aggregate all
      // folders' meta/info.json instead (tiny fetches).
      const statsPromise =
        folderMode && folderList
          ? loadFolderEpisodeLengths(repoId, folderList).then((r) => {
              if (r && mountedRef.current) setFolderTotalFrames(r.totalFrames);
              return r?.stats ?? null;
            })
          : getDatasetVersionAndInfo(repoId).then(({ version, info }) => {
              if (version !== "v3.0") return null;
              return loadAllEpisodeLengthsV3(repoId, version, info.fps);
            });
      statsPromise
        .then((result) => {
          if (!mountedRef.current) return;
          setEpisodeLengthStats(result);
        })
        .catch(() => {})
        .finally(() => {
          if (mountedRef.current) setStatsLoading(false);
        });
    } else {
      setStatsLoading(false);
    }
  };

  const loadFrames = () => {
    if (framesLoadedRef.current || !org || !dataset) return;
    framesLoadedRef.current = true;
    setFramesLoading(true);
    const repoId = `${org}/${dataset}`;
    getDatasetVersionAndInfo(repoId)
      .then(({ version, info }) =>
        loadAllEpisodeFrameInfo(
          repoId,
          version,
          info as unknown as DatasetMetadata,
        ),
      )
      .then((result) => {
        if (!mountedRef.current) return;
        setEpisodeFramesData(result);
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setEpisodeFramesData({ cameras: [], framesByCamera: {} });
      })
      .finally(() => {
        if (mountedRef.current) setFramesLoading(false);
      });
  };

  const loadInsights = () => {
    if (insightsLoadedRef.current || !org || !dataset) return;
    insightsLoadedRef.current = true;
    setInsightsLoading(true);
    const repoId = `${org}/${dataset}`;
    getDatasetVersionAndInfo(repoId)
      .then(({ version, info }) =>
        loadCrossEpisodeActionVariance(
          repoId,
          version,
          info as unknown as DatasetMetadata,
          info.fps,
        ),
      )
      .then((result) => {
        if (!mountedRef.current) return;
        setCrossEpData(result);
      })
      .catch((err) => console.error("[cross-ep] Failed:", err))
      .finally(() => {
        if (mountedRef.current) setInsightsLoading(false);
      });
  };

  // Re-trigger data loading for the restored tab on mount
  useEffect(() => {
    if (activeTab === "statistics") loadStats();
    if (activeTab === "frames") loadFrames();
    if (activeTab === "insights") loadInsights();
    if (activeTab === "filtering") {
      loadStats();
      loadInsights();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTabChange = (tab: ActiveTab) => {
    setActiveTab(tab);
    if (tab === "statistics") loadStats();
    if (tab === "frames") loadFrames();
    if (tab === "insights") loadInsights();
    if (tab === "filtering") {
      loadStats();
      loadInsights();
    }
  };

  // `currentTime` is intentionally NOT read here. Subscribing to it would
  // re-render this 700-line component every ~80ms during playback. The
  // <UrlTimeSync /> child handles its only consumer (the ?t= URL writer).
  // `seek` and `setIsPlaying` are stable references from useCallback /
  // useState — they don't drive renders.
  const { seek, setIsPlaying } = useTime();

  // URDFViewer episode changer and play toggle — populated by URDFViewer on mount
  const urdfChangerRef = useRef<((ep: number) => void) | undefined>(undefined);
  const urdfPlayToggleRef = useRef<(() => void) | undefined>(undefined);
  const [urdfEpisode, setUrdfEpisode] = useState(episodeId);
  useEffect(() => setUrdfEpisode(episodeId), [episodeId]);

  // Pagination state
  const pageSize = 100;
  const [currentPage, setCurrentPage] = useState(1);
  const totalPages = Math.ceil(effEpisodes.length / pageSize);
  const paginatedEpisodes = effEpisodes.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  // Preload adjacent episodes' videos via <link rel="preload"> tags
  useEffect(() => {
    if (!org || !dataset) return;
    if (folderMode) return; // adjacent = other folders; skip preloading
    const links: HTMLLinkElement[] = [];

    getAdjacentEpisodesVideoInfo(org, dataset, episodeId, 2)
      .then((adjacentVideos) => {
        for (const ep of adjacentVideos) {
          for (const v of ep.videosInfo) {
            const link = document.createElement("link");
            link.rel = "preload";
            link.as = "video";
            link.href = v.url;
            document.head.appendChild(link);
            links.push(link);
          }
        }
      })
      .catch(() => {});

    return () => {
      links.forEach((l) => l.remove());
    };
  }, [org, dataset, episodeId]);

  // Initialize based on URL time parameter — ONCE. UrlTimeSync writes ?t=
  // back into the URL while paused, and Next syncs useSearchParams with
  // history.replaceState; re-running this effect on those writes seeks the
  // player back to the stored second (e.g. snapping a slider drag back).
  const appliedUrlTimeRef = useRef(false);
  useEffect(() => {
    if (appliedUrlTimeRef.current) return;
    appliedUrlTimeRef.current = true;
    const timeParam = searchParams.get("t");
    if (timeParam) {
      const timeValue = parseFloat(timeParam);
      if (!isNaN(timeValue)) {
        seek(timeValue);
      }
    }
  }, [searchParams, seek]);

  // sync with parent window hf.co/spaces
  useEffect(() => {
    postParentMessageWithParams((params: URLSearchParams) => {
      params.set("path", window.location.pathname + window.location.search);
    });
  }, []);

  // Initialize page based on the current episode. Splitting this out from
  // the keyboard listener effect lets the listener attach exactly once.
  useEffect(() => {
    const episodeIndex = effEpisodes.indexOf(effEpisodeId);
    if (episodeIndex !== -1) {
      setCurrentPage(Math.floor(episodeIndex / pageSize) + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effEpisodes.length, effEpisodeId, pageSize]);

  // Mirror the values the keydown handler needs into a ref. Without this,
  // `useCallback` would produce a new handler whenever `activeTab` /
  // `episodeId` / `urdfEpisode` changed, and the keydown effect would
  // detach + reattach the listener each time. Now the listener attaches
  // once and reads the latest state via the ref.
  // Vercel rule: advanced-event-handler-refs.
  const goEpisode = (ep: number) => {
    if (folderMode) {
      router.push(`./0?root=${encodeURIComponent(folderList![ep])}`);
    } else {
      router.push(`./episode_${ep}`);
    }
  };

  const keyStateRef = useRef({
    activeTab,
    episodeId: effEpisodeId,
    episodes: effEpisodes,
    urdfEpisode,
    goEpisode,
  });
  keyStateRef.current = {
    activeTab,
    episodeId: effEpisodeId,
    episodes: effEpisodes,
    urdfEpisode,
    goEpisode,
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { key } = e;
      const s = keyStateRef.current;
      const inTextEntry = isKeyboardFocusInsideTextEntry(e.target);

      if (key === " ") {
        if (inTextEntry) return;
        e.preventDefault();
        if (s.activeTab === "urdf") {
          urdfPlayToggleRef.current?.();
        } else {
          setIsPlaying((prev: boolean) => !prev);
        }
      } else if (key === "ArrowDown" || key === "ArrowUp") {
        if (inTextEntry) return;
        e.preventDefault();
        if (s.activeTab === "urdf") {
          const nextEp =
            key === "ArrowDown" ? s.urdfEpisode + 1 : s.urdfEpisode - 1;
          const lowest = s.episodes[0];
          const highest = s.episodes[s.episodes.length - 1];
          if (nextEp >= lowest && nextEp <= highest) {
            setUrdfEpisode(nextEp);
            urdfChangerRef.current?.(nextEp);
          }
        } else {
          const nextEpisodeId =
            key === "ArrowDown" ? s.episodeId + 1 : s.episodeId - 1;
          const lowestEpisodeId = s.episodes[0];
          const highestEpisodeId = s.episodes[s.episodes.length - 1];
          if (
            nextEpisodeId >= lowestEpisodeId &&
            nextEpisodeId <= highestEpisodeId
          ) {
            s.goEpisode(nextEpisodeId);
          }
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // router / setIsPlaying are stable; the rest is read via keyStateRef.
  }, [router, setIsPlaying]);

  // Pagination functions
  const nextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage((prev) => prev + 1);
    }
  };

  const prevPage = () => {
    if (currentPage > 1) {
      setCurrentPage((prev) => prev - 1);
    }
  };

  // Single-viewport dashboard layout for tactile datasets. Datasets with
  // more than 2 cameras / tactile channels get pickers; the Classic button
  // switches back to the scrolling stacked layout (incl. RGBD panels).
  const [layoutPref, setLayoutPref] = useState<"dashboard" | "classic">(
    "dashboard",
  );
  // Manual per-episode review mark, shared via the Hub (review_status.json).
  const [isReviewed, setIsReviewed] = useState<boolean | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setIsReviewed(null);
    import("@/utils/hubCommit")
      .then((m) => m.fetchReviewStatus(datasetInfo.repoId))
      .then((s) => {
        if (!cancelled) setIsReviewed(String(effEpisodeId) in s.episodes);
      })
      .catch(() => {
        if (!cancelled) setIsReviewed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [datasetInfo.repoId, effEpisodeId]);
  const toggleReviewed = async () => {
    if (reviewBusy || isReviewed == null) return;
    setReviewBusy(true);
    try {
      const m = await import("@/utils/hubCommit");
      await m.setEpisodeReviewed(datasetInfo.repoId, effEpisodeId, !isReviewed);
      setIsReviewed(!isReviewed);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewBusy(false);
    }
  };
  const reviewButton = (
    <button
      onClick={() => void toggleReviewed()}
      disabled={reviewBusy || isReviewed == null}
      className={`text-[11px] px-2 py-0.5 rounded shrink-0 disabled:opacity-40 ${
        isReviewed
          ? "bg-sky-500/15 text-sky-300 hover:bg-sky-500/25"
          : "bg-white/5 text-slate-400 hover:text-slate-200"
      }`}
      title="Toggle the reviewed mark for this episode (saved to the dataset repo, visible to everyone)"
    >
      {reviewBusy ? "..." : isReviewed ? "Reviewed" : "Mark reviewed"}
    </button>
  );
  const hasTactile =
    !!data.sensorFrames && Object.keys(data.sensorFrames).length > 0;
  const dashboardMode = hasTactile && layoutPref === "dashboard";
  const tacLabels =
    hasTactile && tactileLabelsFn ? tactileLabelsFn(data.sensorFrames!) : [];
  const [dashFingers, setDashFingers] = useState<[number, number]>([0, 1]);
  // img-slot stream ids: "v:<video idx>" | "rgbd:<cam>:color" | "rgbd:<cam>:depth"
  const { cams: rgbdCams, anchor: rgbdAnchor } = useRgbdCams(
    org && dataset ? `${org}/${dataset}` : "",
    innerRootParam,
  );
  const [dashSlots, setDashSlots] = useState<[string, string]>(["v:0", "v:1"]);
  const streamOptions = useMemo(() => {
    const opts = videosInfo.map((v, i) => ({
      id: `v:${i}`,
      label: v.filename,
    }));
    for (const cam of rgbdCams) {
      opts.push({ id: `rgbd:${cam}:color`, label: `${cam} · color` });
      opts.push({ id: `rgbd:${cam}:depth`, label: `${cam} · depth` });
    }
    return opts;
  }, [videosInfo, rgbdCams]);
  const showStreamPickers = streamOptions.length >= 2;
  // ONE SimpleVideosPlayer instance drives the playback clock — rendering a
  // player per slot makes two masters fight over currentTime and playback
  // sticks near frame 0. Video slots share a single player; RGBD slots render
  // beside it.
  // MUST be memoized: the parent re-renders ~12×/s during playback (it
  // consumes currentTime), and a fresh videosInfo array identity makes
  // SimpleVideosPlayer tear down / re-attach its video listeners every tick —
  // the segmented-video load handler then snaps playback back to the segment
  // start each time, freezing replay at the first frames.
  const slotVideoInfos = useMemo(
    () =>
      dashSlots
        .filter((id) => id.startsWith("v:"))
        .map((id) => videosInfo[Number(id.slice(2))])
        .filter(Boolean),
    [dashSlots, videosInfo],
  );
  const slotRgbd = useMemo(
    () =>
      dashSlots
        .map((id) => id.match(/^rgbd:(.+):(color|depth)$/))
        .filter((m): m is RegExpMatchArray => !!m),
    [dashSlots],
  );

  const renderTab = (tab: ActiveTab, label: string, title?: string) => (
    <TabButton
      active={activeTab === tab}
      onClick={() => handleTabChange(tab)}
      label={label}
      title={title}
    />
  );

  return (
    <div className="flex flex-col h-screen max-h-screen bg-[var(--bg)] text-[var(--text-primary)]">
      <UrlTimeSync />
      {/* Top tab bar */}
      <div className="flex items-center border-b border-white/5 bg-[var(--surface-0)] shrink-0">
        {renderTab("episodes", "Episodes")}
        {renderTab(
          "annotations",
          "Annotations",
          "Edit subtask / plan / memory / interjection / VQA atoms (lerobot v3.1 schema)",
        )}
        {hasURDFSupport(datasetInfo.robot_type) &&
          datasetInfo.codebase_version >= "v3.0" &&
          renderTab("urdf", "3D Replay")}
        {renderTab("statistics", "Statistics")}
        {renderTab("filtering", "Filtering")}
        {renderTab("frames", "Frames")}
        {renderTab("insights", "Action Insights")}
        {renderTab(
          "doctor",
          "Doctor",
          "Dataset quality diagnostics (powered by lerobot-doctor)",
        )}
        <div className="ml-auto">
          <HfAuthButton variant="tab" />
        </div>
      </div>

      {/* Body: sidebar + content */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar — on Episodes and 3D Replay tabs */}
        {(activeTab === "episodes" ||
          activeTab === "annotations" ||
          activeTab === "urdf") && (
          <Sidebar
            datasetInfo={
              folderMode
                ? { ...datasetInfo, total_episodes: effEpisodes.length }
                : datasetInfo
            }
            paginatedEpisodes={paginatedEpisodes}
            episodeId={activeTab === "urdf" ? urdfEpisode : effEpisodeId}
            totalPages={totalPages}
            currentPage={currentPage}
            prevPage={prevPage}
            nextPage={nextPage}
            showFlaggedOnly={sidebarFlaggedOnly}
            onShowFlaggedOnlyChange={setSidebarFlaggedOnly}
            episodeLabels={folderLabels}
            onEpisodeSelect={
              activeTab === "urdf"
                ? (ep) => {
                    setUrdfEpisode(ep);
                    urdfChangerRef.current?.(ep);
                  }
                : folderMode
                  ? goEpisode
                  : activeTab === "annotations"
                    ? (ep) => router.push(`./episode_${ep}`)
                    : undefined
            }
          />
        )}

        {/* Main content */}
        <div
          className={`flex flex-col gap-4 p-4 flex-1 relative min-w-0 ${
            isLoading ||
            (dashboardMode && activeTab === "episodes") ||
            activeTab === "annotations"
              ? "overflow-hidden"
              : "overflow-y-auto"
          }`}
        >
          {isLoading && <Loading />}

          {activeTab === "episodes" && dashboardMode && (
            <div className="flex flex-col flex-1 min-h-0 gap-2">
              {/* slim header: repo · episode · task, one line */}
              <div className="flex items-center gap-3 shrink-0 min-w-0">
                <a
                  href={hubRepoPageUrl(datasetInfo.repoId)}
                  target="_blank"
                  className="text-sm font-medium text-slate-200 hover:text-cyan-300 transition-colors truncate shrink-0"
                >
                  {datasetInfo.repoId}
                </a>
                <span className="text-[10px] uppercase tracking-wide text-slate-500 tabular shrink-0">
                  Episode · {episodeId}
                </span>
                {task && (
                  <span
                    className="text-xs text-slate-400 truncate"
                    title={task}
                  >
                    {task.split("\n")[0]}
                  </span>
                )}
                {epAnnotation && (
                  <div className="min-w-0 truncate">
                    <AnnotationBadges a={epAnnotation} />
                  </div>
                )}
                <span className="flex-1" />
                {showStreamPickers &&
                  ([0, 1] as const).map((slot) => (
                    <select
                      key={slot}
                      className="text-[11px] bg-[var(--surface-1)] border border-white/10 rounded px-1 py-0.5 text-slate-300 max-w-[170px]"
                      value={dashSlots[slot]}
                      onChange={(e) => {
                        const v = e.target.value;
                        setDashSlots((prev) =>
                          slot === 0 ? [v, prev[1]] : [prev[0], v],
                        );
                      }}
                    >
                      {streamOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ))}
                {reviewButton}
                <button
                  onClick={() => setLayoutPref("classic")}
                  className="text-[11px] px-2 py-0.5 rounded bg-white/5 text-slate-400 hover:text-slate-200 shrink-0"
                >
                  Classic view
                </button>
              </div>

              <div
                className="grid flex-1 min-h-0 gap-3"
                style={{
                  gridTemplateColumns:
                    "minmax(0, 2fr) minmax(0, 2fr) minmax(0, 1.15fr)",
                  gridTemplateRows: "minmax(0, 4fr) minmax(0, 6fr)",
                  gridTemplateAreas: '"img img side" "joint joint side"',
                }}
              >
                <div
                  style={{ gridArea: "img" }}
                  className="min-h-0 overflow-hidden grid grid-cols-2 gap-2"
                >
                  {slotVideoInfos.length > 0 && (
                    <div
                      className={`min-h-0 overflow-hidden ${
                        slotVideoInfos.length === 2 ? "col-span-2" : ""
                      }`}
                    >
                      <SimpleVideosPlayer
                        videosInfo={slotVideoInfos}
                        onVideosReady={() => setVideosReady(true)}
                        fill
                      />
                    </div>
                  )}
                  {rgbdAnchor != null &&
                    slotRgbd.map((m, i) => (
                      <div key={i} className="min-h-0 overflow-hidden">
                        <RgbdStreamView
                          repoId={`${org}/${dataset}`}
                          root={innerRootParam}
                          cam={m[1]}
                          kind={m[2] as "color" | "depth"}
                          anchor={rgbdAnchor}
                        />
                      </div>
                    ))}
                </div>
                <div
                  style={{ gridArea: "side" }}
                  className="min-h-0 flex flex-col gap-3"
                >
                  <div className="flex-1 min-h-0 flex flex-col">
                    {tacLabels.length > 2 && (
                      <select
                        className="shrink-0 mb-1 text-[11px] bg-[var(--surface-1)] border border-white/10 rounded px-1 py-0.5 text-slate-300"
                        value={dashFingers[0]}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setDashFingers((prev) => [v, prev[1]]);
                        }}
                      >
                        {tacLabels.map((l, i) => (
                          <option key={l} value={i}>
                            {l}
                          </option>
                        ))}
                      </select>
                    )}
                    <div className="flex-1 min-h-0">
                      <Suspense fallback={null}>
                        <TactileFingerView
                          sensorFrames={data.sensorFrames!}
                          gripper={gripperSeries}
                          fps={datasetInfo.fps}
                          fingerIndex={dashFingers[0]}
                        />
                      </Suspense>
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 flex flex-col">
                    {tacLabels.length > 2 && (
                      <select
                        className="shrink-0 mb-1 text-[11px] bg-[var(--surface-1)] border border-white/10 rounded px-1 py-0.5 text-slate-300"
                        value={dashFingers[1]}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setDashFingers((prev) => [prev[0], v]);
                        }}
                      >
                        {tacLabels.map((l, i) => (
                          <option key={l} value={i}>
                            {l}
                          </option>
                        ))}
                      </select>
                    )}
                    <div className="flex-1 min-h-0">
                      <Suspense fallback={null}>
                        <TactileFingerView
                          sensorFrames={data.sensorFrames!}
                          gripper={gripperSeries}
                          fps={datasetInfo.fps}
                          fingerIndex={dashFingers[1]}
                        />
                      </Suspense>
                    </div>
                  </div>
                  <div className="flex-[0.8] min-h-0">
                    <Suspense fallback={null}>
                      <TactileSummary
                        sensorFrames={data.sensorFrames!}
                        gripper={gripperSeries}
                      />
                    </Suspense>
                  </div>
                </div>
                <div
                  style={{ gridArea: "joint" }}
                  className="min-h-0 overflow-hidden"
                >
                  <Suspense fallback={null}>
                    <DataRecharts
                      data={chartDataGroups}
                      onChartsReady={() => setChartsReady(true)}
                      defaultCombined
                      fill
                    />
                  </Suspense>
                </div>
              </div>

              <div className="shrink-0">
                <PlaybackBar />
              </div>
            </div>
          )}

          {activeTab === "episodes" && !dashboardMode && (
            <>
              <div className="flex items-center gap-4 mb-2">
                <a
                  href="https://github.com/huggingface/lerobot"
                  target="_blank"
                  className="block shrink-0 opacity-90 hover:opacity-100 transition-opacity"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="https://github.com/huggingface/lerobot/raw/main/media/readme/lerobot-logo-thumbnail.png"
                    alt="LeRobot Logo"
                    className="w-24"
                  />
                </a>

                <div className="min-w-0">
                  <a
                    href={hubRepoPageUrl(datasetInfo.repoId)}
                    target="_blank"
                    className="text-slate-200 hover:text-cyan-300 transition-colors"
                  >
                    <p className="text-base font-medium truncate">
                      {datasetInfo.repoId}
                    </p>
                  </a>
                  <p className="text-[10px] uppercase tracking-wide text-slate-500 mt-0.5 tabular">
                    Episode · {episodeId}
                  </p>
                </div>
                <span className="flex-1" />
                {reviewButton}
                {hasTactile && (
                  <button
                    onClick={() => setLayoutPref("dashboard")}
                    className="text-[11px] px-2 py-0.5 rounded bg-white/5 text-slate-400 hover:text-slate-200 shrink-0"
                  >
                    Dashboard view
                  </button>
                )}
              </div>

              {/* Company task.json card (folder-episode datasets) */}
              {companyTask && (
                <div className="mb-6 panel p-4">
                  <div className="flex items-center gap-3 flex-wrap">
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">
                      Task
                    </p>
                    {companyTask.target_result && (
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded ${
                          companyTask.target_result === "成功"
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-red-500/15 text-red-300"
                        }`}
                      >
                        {companyTask.target_result}
                      </span>
                    )}
                    {companyTask.task_number && (
                      <span className="text-[11px] text-slate-500 tabular">
                        {companyTask.task_number}
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-sm text-slate-200">
                    {companyTask.task_name}
                    {companyTask.action ? ` — ${companyTask.action}` : ""}
                  </p>
                  {companyTask.failure_reason && (
                    <p className="mt-1 text-xs text-red-300/80">
                      {companyTask.failure_reason}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-slate-500">
                    {[
                      companyTask.object,
                      companyTask.contact_part,
                      companyTask.force_level,
                      companyTask.speed,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              )}

              {/* Language Instruction (hidden when the richer task.json
                  card above already shows the instruction) */}
              {task && !companyTask && (
                <div className="mb-6 panel p-4">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">
                    Language Instruction
                  </p>
                  <div className="mt-1.5 space-y-0.5 text-sm text-slate-200">
                    {task
                      .split("\n")
                      .map((instruction: string, index: number) => (
                        <p key={index}>{instruction}</p>
                      ))}
                  </div>
                  {epAnnotation && <AnnotationBadges a={epAnnotation} />}
                </div>
              )}

              {/* Videos */}
              {videosInfo.length > 0 && (
                <SimpleVideosPlayer
                  videosInfo={videosInfo}
                  onVideosReady={() => setVideosReady(true)}
                />
              )}

              {/* RGBD color+depth (server-decoded) */}
              {org && dataset && innerRootParam && (
                <Suspense fallback={null}>
                  <RgbdPanel
                    repoId={`${org}/${dataset}`}
                    root={innerRootParam}
                  />
                </Suspense>
              )}

              {/* Tactile sensors (PXSR-style force arrows) */}
              {data.sensorFrames &&
                Object.keys(data.sensorFrames).length > 0 && (
                  <Suspense fallback={null}>
                    <TactilePanel
                      sensorFrames={data.sensorFrames}
                      fps={datasetInfo.fps}
                      gripper={gripperSeries}
                      repoId={org && dataset ? `${org}/${dataset}` : undefined}
                      root={innerRootParam}
                    />
                  </Suspense>
                )}

              {/* Graph */}
              <div className="mb-4">
                <Suspense fallback={null}>
                  <DataRecharts
                    data={chartDataGroups}
                    onChartsReady={() => setChartsReady(true)}
                  />
                </Suspense>
              </div>

              <PlaybackBar />
            </>
          )}

          {activeTab === "annotations" && (
            // Single-viewport annotation workspace: media column (videos on
            // top, tactile row below, playback pinned) + annotation column
            // with its own internal scroll. The page itself never scrolls.
            <div className="annotations-skin flex flex-1 min-h-0 gap-4">
              {/* LEFT: media column */}
              <div className="flex flex-col gap-2 min-w-0 min-h-0 flex-[5]">
                <div className="flex items-center gap-3 shrink-0">
                  <p className="text-base font-medium text-slate-200 truncate">
                    {datasetInfo.repoId}
                  </p>
                  <p className="text-[10px] uppercase tracking-wide text-slate-500 tabular">
                    Episode · {episodeId}
                  </p>
                </div>
                <div
                  className="flex-1 min-h-0 grid gap-2"
                  style={{
                    gridTemplateRows: hasTactile
                      ? "minmax(0, 3fr) minmax(0, 2fr)"
                      : "minmax(0, 1fr)",
                  }}
                >
                  <div className="min-h-0 overflow-hidden">
                    {videosInfo.length > 0 && (
                      <SimpleVideosPlayer
                        videosInfo={videosInfo}
                        onVideosReady={() => setVideosReady(true)}
                        fill
                      />
                    )}
                  </div>
                  {hasTactile && (
                    <div className="min-h-0 grid grid-cols-3 gap-2">
                      <div className="min-h-0">
                        <Suspense fallback={null}>
                          <TactileFingerView
                            sensorFrames={data.sensorFrames!}
                            gripper={gripperSeries}
                            fps={datasetInfo.fps}
                            fingerIndex={dashFingers[0]}
                          />
                        </Suspense>
                      </div>
                      <div className="min-h-0">
                        <Suspense fallback={null}>
                          <TactileFingerView
                            sensorFrames={data.sensorFrames!}
                            gripper={gripperSeries}
                            fps={datasetInfo.fps}
                            fingerIndex={dashFingers[1]}
                          />
                        </Suspense>
                      </div>
                      <div className="min-h-0">
                        <Suspense fallback={null}>
                          <TactileSummary
                            sensorFrames={data.sensorFrames!}
                            gripper={gripperSeries}
                          />
                        </Suspense>
                      </div>
                    </div>
                  )}
                </div>
                <div className="shrink-0">
                  <PlaybackBar />
                </div>
              </div>

              {/* RIGHT: annotation workflow — internal scroll */}
              <div className="flex flex-col gap-3 min-w-0 min-h-0 flex-[4] overflow-y-auto pr-1">
                <AutoLabelPanel
                  sensorFrames={data.sensorFrames}
                  gripper={gripperSeries}
                  arm={armSeries}
                  repoId={datasetInfo.repoId}
                  root={innerRootParam}
                  episodeId={effEpisodeId}
                />
                <AnnotationsTimeline duration={data.duration} />
                <AnnotationsPanel
                  cameraKeys={videosInfo.map((v) => v.filename)}
                />
                <details className="grounding-intro">
                  <summary className="section-kicker cursor-pointer">
                    Grounded VQA — how to draw
                  </summary>
                  <ul>
                    <li>
                      Draw directly on the active video to create visual
                      questions. Drag for a bounding box, click for a point. The
                      camera is detected from the video you draw on.
                    </li>
                    <li>
                      Drag on any video to add a bbox question. Click any video
                      to add a keypoint question. Confirm the popup with{" "}
                      <kbd>↵</kbd>, or cancel with <kbd>Esc</kbd>.
                    </li>
                  </ul>
                </details>
              </div>
            </div>
          )}

          {activeTab === "statistics" && (
            <>
              {folderMode && org && dataset && folderList && (
                <Suspense fallback={null}>
                  <TactileAggregate
                    repoId={`${org}/${dataset}`}
                    folders={folderList}
                  />
                </Suspense>
              )}
              {data.sensorFrames &&
                Object.keys(data.sensorFrames).length > 0 && (
                  <Suspense fallback={null}>
                    <TactileStats
                      sensorFrames={data.sensorFrames}
                      gripper={gripperSeries}
                    />
                  </Suspense>
                )}
              <StatsPanel
                datasetInfo={
                  folderMode
                    ? {
                        ...datasetInfo,
                        total_episodes: effEpisodes.length,
                        total_frames:
                          folderTotalFrames ?? datasetInfo.total_frames,
                        // Extra cameras exist on disk but aren't registered
                        // in features; resolutions verified from the files
                        // (RGB intrinsics cx≈937 -> 1920x1080; RGBD
                        // metadata.json -> 1280x720).
                        cameras: [
                          ...datasetInfo.cameras,
                          ...[
                            "RGB_Camera0",
                            "RGB_Camera1",
                            "RGB_Camera2",
                            "RGB_Camera3",
                            "RGB_Camera4",
                            "RGB_Camera5",
                          ].map((name) => ({
                            name,
                            width: 1920,
                            height: 1080,
                          })),
                          ...["RGBD_0", "RGBD_1", "RGBD_2"].map((name) => ({
                            name: `${name} (color+depth16)`,
                            width: 1280,
                            height: 720,
                          })),
                        ],
                      }
                    : datasetInfo
                }
                episodeLengthStats={episodeLengthStats}
                loading={statsLoading}
              />
            </>
          )}

          {activeTab === "frames" && (
            <OverviewPanel
              data={episodeFramesData}
              loading={framesLoading}
              flaggedOnly={framesFlaggedOnly}
              onFlaggedOnlyChange={setFramesFlaggedOnly}
            />
          )}

          {activeTab === "insights" && (
            <Suspense fallback={<Loading />}>
              <ActionInsightsPanel
                flatChartData={data.flatChartData}
                fps={datasetInfo.fps}
                crossEpisodeData={crossEpData}
                crossEpisodeLoading={insightsLoading}
              />
            </Suspense>
          )}

          {activeTab === "filtering" && (
            <Suspense fallback={<Loading />}>
              <FilteringPanel
                repoId={datasetInfo.repoId}
                crossEpisodeData={crossEpData}
                crossEpisodeLoading={insightsLoading}
                episodeLengthStats={episodeLengthStats}
                flatChartData={data.flatChartData}
                onViewFlaggedEpisodes={() => {
                  setSidebarFlaggedOnly(true);
                  handleTabChange("episodes");
                }}
              />
            </Suspense>
          )}

          {activeTab === "doctor" && (
            <div className="flex flex-col h-full">
              <div className="flex items-center justify-between px-1 pb-2 text-xs text-slate-400">
                <span>
                  Dataset quality diagnostics &mdash; powered by{" "}
                  <a
                    href="https://github.com/jashshah999/lerobot-doctor"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-slate-200"
                  >
                    lerobot-doctor
                  </a>
                </span>
                <a
                  href={`https://jashshah999-lerobot-doctor.hf.space/?dataset=${org}/${dataset}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-slate-200"
                >
                  Open in new tab
                </a>
              </div>
              <iframe
                src={`https://jashshah999-lerobot-doctor.hf.space/?dataset=${org}/${dataset}`}
                title="lerobot-doctor"
                className="flex-1 w-full rounded border border-slate-700 bg-white"
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              />
            </div>
          )}

          {activeTab === "urdf" && (
            <Suspense fallback={<Loading />}>
              <URDFViewer
                data={data}
                org={org}
                dataset={dataset}
                episodeChangerRef={urdfChangerRef}
                playToggleRef={urdfPlayToggleRef}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
