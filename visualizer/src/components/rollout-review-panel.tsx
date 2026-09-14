"use client";

// Rollout review panel: manual outcome annotation for evaluation (rollout)
// datasets. Renders only when the dataset looks like a rollout dataset
// (repo name contains "rollout") or already carries a reviews file, so
// ordinary training datasets never see it.
//
// Per episode the reviewer picks the highest stage reached (S0..S5, fixed
// progress scores), one primary failure mode (F0..F8) and a scene label,
// then saves — the aggregated `annotations/rollout_reviews.json` is
// committed to the dataset repo as the signed-in user (same authorization
// model as the annotation save). A dataset-level summary (success rate with
// Wilson 95% CI, mean progress score, per-scene table) is computed from the
// same file.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ROLLOUT_STAGES,
  ROLLOUT_FAILURES,
  SUCCESS_STAGE_ID,
  isRolloutRepoName,
  fetchRolloutReviews,
  saveRolloutReview,
  saveRolloutReviewsBulk,
  summarizeRolloutReviews,
  emptyRolloutReviews,
  type RolloutReviews,
  type RolloutReview,
} from "@/utils/rolloutReview";
import {
  detectBowl,
  frameFeatures,
  decideStages,
  parseAutoLabelCsv,
  type FrameFeatures,
  type BowlCircle,
} from "@/lib/rolloutAutoScore";
import type { VideoInfo } from "@/types/video.types";

// ---- automatic scoring: sample the top-camera video in the browser -----------

const ANALYSIS_W = 320; // downscale width for pixel analysis
const SAMPLE_FPS = 4;
const ARM_RADIUS_REF = 50; // px at 640 reference width

function pickTopCamera(videos: VideoInfo[]): VideoInfo | null {
  if (!videos.length) return null;
  return (
    videos.find((v) => /top/i.test(v.filename) && !v.isGrayscale) ??
    videos.find((v) => !v.isGrayscale) ??
    videos[0]
  );
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("video seek timed out"));
    }, 8000);
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("video error while seeking"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = t;
  });
}

async function autoScoreEpisode(
  top: VideoInfo,
  gripper: { t: number[]; pos: number[] } | null,
  cancelled: () => boolean,
  onProgress: (done: number, total: number) => void,
): Promise<ReturnType<typeof decideStages>> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  video.muted = true;
  video.src = top.url;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("video metadata timed out")),
      15000,
    );
    video.addEventListener(
      "loadedmetadata",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    video.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("video failed to load"));
      },
      { once: true },
    );
  });
  const segStart = top.isSegmented ? (top.segmentStart ?? 0) : 0;
  const segEnd = top.isSegmented
    ? (top.segmentEnd ?? video.duration)
    : video.duration;
  const w = ANALYSIS_W;
  const h = Math.max(
    2,
    Math.round((w * video.videoHeight) / Math.max(1, video.videoWidth)),
  );
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d canvas context");
  const step = 1 / SAMPLE_FPS;
  const total = Math.max(1, Math.floor((segEnd - segStart) / step));
  const frames: FrameFeatures[] = [];
  let bowl: BowlCircle | null = null;
  const armRadius = (ARM_RADIUS_REF * w) / 640;
  for (let i = 0; i <= total; i++) {
    if (cancelled()) throw new Error("cancelled");
    await seekTo(video, Math.min(segStart + i * step, segEnd - 0.01));
    ctx.drawImage(video, 0, 0, w, h);
    let img: ImageData;
    try {
      img = ctx.getImageData(0, 0, w, h);
    } catch {
      throw new Error(
        "video pixels are not readable (CORS) — cannot auto-score",
      );
    }
    if (i === 0) bowl = detectBowl(img.data, w, h);
    frames.push(frameFeatures(img.data, w, h, i * step, armRadius));
    onProgress(i + 1, total + 1);
  }
  video.removeAttribute("src");
  video.load();
  return decideStages(frames, bowl, gripper, w);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export default function RolloutReviewPanel({
  repoId,
  episodeId,
  totalEpisodes,
  defaultOpen = true,
  videosInfo,
  gripper,
}: {
  repoId: string;
  episodeId: number;
  totalEpisodes?: number;
  defaultOpen?: boolean;
  videosInfo?: VideoInfo[];
  gripper?: { t: number[]; pos: number[] } | null;
}) {
  // null = still probing whether this dataset applies
  const [applies, setApplies] = useState<boolean | null>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [reviews, setReviews] = useState<RolloutReviews>(emptyRolloutReviews());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // editable fields for the current episode
  const [stage, setStage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string>("F0");
  const [scene, setScene] = useState("");
  const [notes, setNotes] = useState("");

  // automatic scoring
  const [autoBusy, setAutoBusy] = useState(false);
  const autoCancelRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    autoCancelRef.current = false;
    return () => {
      autoCancelRef.current = true; // episode/repo changed or unmounted
    };
  }, [repoId, episodeId]);

  // Probe: name heuristic, or an existing reviews file. Either way load it.
  useEffect(() => {
    let cancelled = false;
    setApplies(null);
    setReviews(emptyRolloutReviews());
    (async () => {
      const byName = isRolloutRepoName(repoId);
      const file = await fetchRolloutReviews(repoId);
      if (cancelled) return;
      if (file) setReviews(file);
      setApplies(byName || file !== null);
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  // Seed the form from the saved review whenever the episode (or the loaded
  // file) changes.
  useEffect(() => {
    const saved = reviews.episodes[String(episodeId)];
    if (saved) {
      setStage(saved.stage);
      setFailure(saved.failure ?? "F0");
      setScene(saved.scene ?? "");
      setNotes(saved.notes ?? "");
    } else {
      setStage(null);
      setFailure("F0");
      setScene((prev) => prev); // keep the scene between episodes — reviews run scene by scene
      setNotes("");
    }
    setMsg("");
  }, [episodeId, reviews]);

  const saved = reviews.episodes[String(episodeId)];
  const summary = useMemo(() => summarizeRolloutReviews(reviews), [reviews]);
  const failLabel = (id: string) =>
    ROLLOUT_FAILURES.find((f) => f.id === id)?.label ?? id;

  if (applies === false) return null;
  if (applies === null) return null;

  const pickStage = (id: string) => {
    setStage(id);
    // a full success has no failure mode; picking a lower stage than the
    // current failure suggests re-choosing, so only auto-set the F0 case
    if (id === SUCCESS_STAGE_ID) setFailure("F0");
    else if (failure === "F0") setFailure("F8");
  };

  const doSave = async (review: RolloutReview | null) => {
    if (busy) return;
    setBusy(true);
    setMsg(review ? "saving…" : "clearing…");
    try {
      const updated = await saveRolloutReview(repoId, episodeId, review);
      setReviews({ ...updated, episodes: { ...updated.episodes } });
      setMsg(review ? "saved to the Hub" : "cleared");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSave = () => {
    if (stage == null) {
      setMsg("pick the highest stage reached first");
      return;
    }
    const def = ROLLOUT_STAGES.find((s) => s.id === stage)!;
    void doSave({
      stage: def.id,
      score: def.score,
      failure: stage === SUCCESS_STAGE_ID ? "F0" : failure,
      scene: scene.trim() || undefined,
      notes: notes.trim() || undefined,
      reviewed_at: new Date().toISOString(),
      source: "human",
    });
  };

  const runAutoScore = async () => {
    if (autoBusy || busy) return;
    const top = videosInfo?.length ? pickTopCamera(videosInfo) : null;
    if (!top) {
      setMsg("no camera video available for auto scoring");
      return;
    }
    autoCancelRef.current = false;
    setAutoBusy(true);
    try {
      const res = await autoScoreEpisode(
        top,
        gripper ?? null,
        () => autoCancelRef.current,
        (d, n) => setMsg(`auto scoring… frame ${d}/${n}`),
      );
      setStage(res.stage);
      setFailure(res.stage === SUCCESS_STAGE_ID ? "F0" : res.suggestedFailure);
      setNotes(`[auto] ${res.evidence}`);
      setMsg(`auto suggests ${res.stage} — check the video, then save`);
    } catch (e) {
      if (!autoCancelRef.current) {
        setMsg(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setAutoBusy(false);
    }
  };

  const importCsv = async (file: File) => {
    if (busy) return;
    setBusy(true);
    try {
      const { rows, skipped } = parseAutoLabelCsv(await file.text());
      if (!rows.length) {
        setMsg(
          `no importable rows (need episode + stage columns; ${skipped} skipped)`,
        );
        return;
      }
      setMsg(`importing ${rows.length} auto labels…`);
      const res = await saveRolloutReviewsBulk(
        repoId,
        rows,
        `rollout review: import ${rows.length} auto labels from ${file.name}`,
      );
      setReviews({ ...res.reviews, episodes: { ...res.reviews.episodes } });
      setMsg(
        `imported ${res.written} auto labels` +
          (res.kept ? `, kept ${res.kept} human reviews` : "") +
          (skipped ? `, skipped ${skipped} rows` : ""),
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="panel p-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] uppercase tracking-wide text-slate-400 hover:text-slate-200 transition-colors flex items-center gap-2"
      >
        {open ? "▾" : "▸"} rollout review
        <span className="normal-case text-slate-500">
          {summary.reviewed}
          {totalEpisodes ? ` / ${totalEpisodes}` : ""} reviewed
          {summary.autoUnconfirmed ? ` (${summary.autoUnconfirmed} auto)` : ""}
          {saved
            ? ` · this episode: ${saved.stage}${saved.source === "auto" ? " (auto)" : ""}`
            : ""}
        </span>
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-3 text-[12px]">
          {/* stage picker */}
          <div>
            <p className="text-slate-400 mb-1">
              Highest stage reached (highest wins):
            </p>
            <div className="flex flex-wrap gap-1">
              {ROLLOUT_STAGES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => pickStage(s.id)}
                  title={s.label}
                  className={`px-2 py-1 rounded border text-[11px] transition-colors ${
                    stage === s.id
                      ? "border-cyan-400 bg-cyan-400/15 text-cyan-300"
                      : "border-slate-700 text-slate-300 hover:border-slate-500"
                  }`}
                >
                  {s.id} · {s.label} ({s.score})
                </button>
              ))}
            </div>
          </div>

          {/* failure + scene */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-slate-400">
              failure
              <select
                value={stage === SUCCESS_STAGE_ID ? "F0" : failure}
                disabled={stage === SUCCESS_STAGE_ID}
                onChange={(e) => setFailure(e.target.value)}
                className="bg-transparent border border-slate-700 rounded px-1.5 py-1 text-slate-200 text-[11px] disabled:opacity-50"
              >
                {ROLLOUT_FAILURES.map((f) => (
                  <option key={f.id} value={f.id} className="bg-slate-900">
                    {f.id} · {f.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-slate-400">
              scene
              <input
                value={scene}
                onChange={(e) => setScene(e.target.value)}
                placeholder="e.g. 1-6"
                className="bg-transparent border border-slate-700 rounded px-1.5 py-1 text-slate-200 text-[11px] w-20"
              />
            </label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="notes (optional)"
              className="bg-transparent border border-slate-700 rounded px-1.5 py-1 text-slate-200 text-[11px] flex-1 min-w-[10rem]"
            />
          </div>

          {/* actions */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onSave}
              disabled={busy || autoBusy}
              className="px-3 py-1 rounded border border-cyan-400 text-cyan-300 hover:bg-cyan-400/10 text-[11px] disabled:opacity-50"
            >
              {saved
                ? saved.source === "auto"
                  ? "confirm review"
                  : "update review"
                : "save review"}
            </button>
            <button
              onClick={() => void runAutoScore()}
              disabled={busy || autoBusy}
              title="Track the ball, bowl and arm in the top camera and prefill the review. Check before saving."
              className="px-3 py-1 rounded border border-slate-600 text-slate-300 hover:border-cyan-400 hover:text-cyan-300 text-[11px] disabled:opacity-50"
            >
              auto score
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || autoBusy}
              title="Import an offline scorer CSV (episode + stage columns; scene/failure/notes optional). Human reviews are kept."
              className="px-3 py-1 rounded border border-slate-600 text-slate-300 hover:border-cyan-400 hover:text-cyan-300 text-[11px] disabled:opacity-50"
            >
              import CSV
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importCsv(f);
              }}
            />
            {saved && (
              <button
                onClick={() => void doSave(null)}
                disabled={busy || autoBusy}
                className="px-3 py-1 rounded border border-slate-700 text-slate-400 hover:border-slate-500 text-[11px] disabled:opacity-50"
              >
                clear
              </button>
            )}
            {msg && <span className="text-slate-400">{msg}</span>}
          </div>

          {/* dataset summary */}
          {summary.reviewed > 0 && (
            <div className="border-t border-slate-800 pt-2 text-slate-300">
              <p>
                <span className="text-slate-400">success rate</span>{" "}
                {summary.successes}/{summary.reviewed} ={" "}
                {pct(summary.successRate)}{" "}
                <span className="text-slate-500">
                  (Wilson 95% CI {pct(summary.ci95[0])}–{pct(summary.ci95[1])})
                </span>{" "}
                · <span className="text-slate-400">mean score</span>{" "}
                {summary.meanScore.toFixed(2)}
              </p>
              {summary.failures.length > 0 && (
                <p className="text-slate-500 mt-1">
                  failures:{" "}
                  {summary.failures
                    .map((f) => `${failLabel(f.id)} ×${f.n}`)
                    .join(", ")}
                </p>
              )}
              {summary.scenes.length > 1 && (
                <table className="mt-2 tabular text-[11px]">
                  <thead>
                    <tr className="text-slate-500">
                      <th className="text-left pr-4 font-normal">scene</th>
                      <th className="text-right pr-4 font-normal">n</th>
                      <th className="text-right pr-4 font-normal">success</th>
                      <th className="text-right font-normal">mean</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.scenes.map((s) => (
                      <tr key={s.scene}>
                        <td className="pr-4">{s.scene}</td>
                        <td className="text-right pr-4">{s.n}</td>
                        <td className="text-right pr-4">
                          {s.successes}/{s.n}
                        </td>
                        <td className="text-right">{s.meanScore.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
