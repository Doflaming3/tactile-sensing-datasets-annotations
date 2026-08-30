"use client";

// RGBD viewer for company-format episodes — ALL cameras side by side.
// The RGBD color stream is MJPEG-in-MKV and depth is FFV1 gray16le; neither
// is browser-decodable, so frames are extracted server-side
// (/api/videoframe, ffmpeg) at the current playhead: color as JPEG, depth as
// raw 16-bit that we normalize (frozen per-camera range) and render through
// a Turbo LUT. Each camera throttles independently (~1.6 updates/s during
// playback; a debounce would starve during playback ticks).

import { useEffect, useMemo, useRef, useState } from "react";
import { useTime } from "@/context/time-context";
import { listRepoFiles } from "@/utils/episodeDiscovery";
import { buildVersionedUrl } from "@/utils/versionUtils";
import { authHeaders } from "@/utils/auth";

const DEPTH_W = 1280;
const DEPTH_H = 720;
// Containers are stamped 30 fps regardless of the real (dropped) frame rate,
// so playhead time must be mapped via the calibrated_timestamp_ns CSVs to a
// frame index, then sought at index/CONTAINER_FPS.
const CONTAINER_FPS = 30;

async function fetchTsColumn(url: string): Promise<number[] | null> {
  try {
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return null;
    const lines = (await res.text()).split(/\r?\n/).filter(Boolean);
    const hdr = lines[0].replace(/^﻿/, "").split(",");
    const i = hdr.indexOf("calibrated_timestamp_ns");
    if (i < 0) return null;
    return lines.slice(1).map((l) => Number(l.split(",")[i]));
  } catch {
    return null;
  }
}

function nearestIdx(ts: number[], target: number): number {
  let lo = 0,
    hi = ts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(ts[lo - 1] - target) < Math.abs(ts[lo] - target)) {
    return lo - 1;
  }
  return lo;
}

// Google Turbo colormap (Mikhailov 2019 polynomial), 256-entry LUT.
const TURBO_LUT: Uint8Array = (() => {
  const lut = new Uint8Array(256 * 3);
  const R = [
    0.13572138, 4.6153926, -42.66032258, 132.13108234, -152.94239396,
    59.28637943,
  ];
  const G = [
    0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604,
  ];
  const B = [
    0.1066733, 12.64194608, -60.58204836, 110.36276771, -89.90310912,
    27.34824973,
  ];
  const poly = (c: number[], x: number) =>
    c[0] + x * (c[1] + x * (c[2] + x * (c[3] + x * (c[4] + x * c[5]))));
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    lut[i * 3] = Math.round(255 * Math.min(1, Math.max(0, poly(R, x))));
    lut[i * 3 + 1] = Math.round(255 * Math.min(1, Math.max(0, poly(G, x))));
    lut[i * 3 + 2] = Math.round(255 * Math.min(1, Math.max(0, poly(B, x))));
  }
  return lut;
})();

// ---- one camera: color + depth, self-throttled -----------------------------

function RgbdCamView({
  repoId,
  cleanRoot,
  cam,
  anchor,
}: {
  repoId: string;
  cleanRoot: string;
  cam: string;
  anchor: number;
}) {
  const { currentTime } = useTime();
  const [colorUrl, setColorUrl] = useState<string | null>(null);
  const [status, setStatus] = useState("loading…");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRunRef = useRef(0);
  const inFlightRef = useRef(false);
  const rangeRef = useRef<[number, number] | null>(null);
  const mapsRef = useRef<{ color: number[]; depth: number[] } | null>(null);

  // per-camera timestamp maps
  useEffect(() => {
    mapsRef.current = null;
    rangeRef.current = null;
    let cancelled = false;
    (async () => {
      const rel = (r: string) => buildVersionedUrl(repoId, "v3.0", r);
      const [colorTs, depthTs] = await Promise.all([
        fetchTsColumn(rel(`videos/${cam}/timestamp.csv`)),
        fetchTsColumn(rel(`videos/${cam}/depth/timestamp.csv`)),
      ]);
      if (!cancelled && colorTs?.length && depthTs?.length) {
        mapsRef.current = { color: colorTs, depth: depthTs };
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cam, cleanRoot, repoId]);

  useEffect(() => {
    const run = () => {
      lastRunRef.current = Date.now();
      const maps = mapsRef.current;
      if (!maps) {
        setStatus("loading timestamp maps…");
        return;
      }
      const target = anchor + currentTime * 1e9;
      const tColor = (nearestIdx(maps.color, target) / CONTAINER_FPS).toFixed(
        3,
      );
      const tDepth = (nearestIdx(maps.depth, target) / CONTAINER_FPS).toFixed(
        3,
      );
      const base = `/api/videoframe?repo=${encodeURIComponent(repoId)}`;
      setColorUrl(
        `${base}&t=${tColor}&kind=color&path=${encodeURIComponent(`${cleanRoot}/videos/${cam}/color/data.mkv`)}`,
      );
      inFlightRef.current = true;
      setStatus("extracting…");
      fetch(
        `${base}&t=${tDepth}&kind=depth&w=${DEPTH_W}&h=${DEPTH_H}&path=${encodeURIComponent(`${cleanRoot}/videos/${cam}/depth/data.mkv`)}`,
      )
        .then(async (res) => {
          if (!res.ok)
            throw new Error(`HTTP ${res.status}: ${await res.text()}`);
          const buf = await res.arrayBuffer();
          const d = new Uint16Array(buf);
          const canvas = canvasRef.current;
          if (!canvas || d.length < DEPTH_W * DEPTH_H) return;
          if (!rangeRef.current) {
            const valid: number[] = [];
            for (let i = 0; i < d.length; i += 149) {
              if (d[i] > 0) valid.push(d[i]);
            }
            valid.sort((a, b) => a - b);
            rangeRef.current = [
              valid[Math.floor(valid.length * 0.02)] ?? 0,
              valid[Math.floor(valid.length * 0.98)] ?? 65535,
            ];
          }
          const [lo, hi] = rangeRef.current;
          const span = Math.max(1, hi - lo);
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          const img = ctx.createImageData(DEPTH_W, DEPTH_H);
          const px = img.data;
          for (let i = 0; i < DEPTH_W * DEPTH_H; i++) {
            const v = d[i];
            if (v === 0) {
              px[i * 4 + 3] = 255;
              continue;
            }
            let n = ((v - lo) / span) * 255;
            n = n < 0 ? 0 : n > 255 ? 255 : n;
            const li = (n | 0) * 3;
            px[i * 4] = TURBO_LUT[li];
            px[i * 4 + 1] = TURBO_LUT[li + 1];
            px[i * 4 + 2] = TURBO_LUT[li + 2];
            px[i * 4 + 3] = 255;
          }
          ctx.putImageData(img, 0, 0);
          setStatus(`${lo}–${hi} mm`);
        })
        .catch((e) => setStatus(`failed: ${String(e).slice(0, 90)}`))
        .finally(() => {
          inFlightRef.current = false;
        });
    };
    const since = Date.now() - lastRunRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!inFlightRef.current && since > 600) {
      run();
    } else {
      timerRef.current = setTimeout(run, Math.max(120, 600 - since));
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [anchor, cam, cleanRoot, repoId, currentTime]);

  return (
    <div className="rounded bg-[#0b0e15] p-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-slate-400">{cam}</p>
        <p className="text-[10px] text-slate-500">{status}</p>
      </div>
      <div className="mt-1 space-y-2">
        {colorUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={colorUrl} alt={`${cam} color`} className="w-full rounded" />
        )}
        <canvas
          ref={canvasRef}
          width={DEPTH_W}
          height={DEPTH_H}
          className="w-full rounded bg-black"
        />
      </div>
    </div>
  );
}

// ---- exported single-stream view (dashboard img tiles) ----------------------

/** One RGBD stream (color OR depth) for a dashboard tile. */
export function RgbdStreamView({
  repoId,
  root,
  cam,
  kind,
  anchor,
}: {
  repoId: string;
  root?: string | null;
  cam: string;
  kind: "color" | "depth";
  anchor: number;
}) {
  const { currentTime } = useTime();
  const cleanRoot = (root ?? "").replace(/^\/+|\/+$/g, "");
  const [colorUrl, setColorUrl] = useState<string | null>(null);
  const [status, setStatus] = useState("loading…");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRunRef = useRef(0);
  const inFlightRef = useRef(false);
  const rangeRef = useRef<[number, number] | null>(null);
  const mapRef = useRef<number[] | null>(null);

  useEffect(() => {
    mapRef.current = null;
    rangeRef.current = null;
    let cancelled = false;
    (async () => {
      const rel =
        kind === "depth"
          ? `videos/${cam}/depth/timestamp.csv`
          : `videos/${cam}/timestamp.csv`;
      const ts = await fetchTsColumn(buildVersionedUrl(repoId, "v3.0", rel));
      if (!cancelled && ts?.length) mapRef.current = ts;
    })();
    return () => {
      cancelled = true;
    };
  }, [cam, kind, repoId, cleanRoot]);

  useEffect(() => {
    const run = () => {
      lastRunRef.current = Date.now();
      const map = mapRef.current;
      if (!map) {
        setStatus("loading timestamps…");
        return;
      }
      const target = anchor + currentTime * 1e9;
      const t = (nearestIdx(map, target) / CONTAINER_FPS).toFixed(3);
      const base = `/api/videoframe?repo=${encodeURIComponent(repoId)}`;
      if (kind === "color") {
        setColorUrl(
          `${base}&t=${t}&kind=color&path=${encodeURIComponent(`${cleanRoot}/videos/${cam}/color/data.mkv`)}`,
        );
        setStatus("");
        return;
      }
      inFlightRef.current = true;
      setStatus("extracting…");
      fetch(
        `${base}&t=${t}&kind=depth&w=${DEPTH_W}&h=${DEPTH_H}&path=${encodeURIComponent(`${cleanRoot}/videos/${cam}/depth/data.mkv`)}`,
      )
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const d = new Uint16Array(await res.arrayBuffer());
          const canvas = canvasRef.current;
          if (!canvas || d.length < DEPTH_W * DEPTH_H) return;
          if (!rangeRef.current) {
            const valid: number[] = [];
            for (let i = 0; i < d.length; i += 149)
              if (d[i] > 0) valid.push(d[i]);
            valid.sort((a, b) => a - b);
            rangeRef.current = [
              valid[Math.floor(valid.length * 0.02)] ?? 0,
              valid[Math.floor(valid.length * 0.98)] ?? 65535,
            ];
          }
          const [lo, hi] = rangeRef.current;
          const span = Math.max(1, hi - lo);
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          const img = ctx.createImageData(DEPTH_W, DEPTH_H);
          const px = img.data;
          for (let i = 0; i < DEPTH_W * DEPTH_H; i++) {
            const v = d[i];
            if (v === 0) {
              px[i * 4 + 3] = 255;
              continue;
            }
            let n = ((v - lo) / span) * 255;
            n = n < 0 ? 0 : n > 255 ? 255 : n;
            const li = (n | 0) * 3;
            px[i * 4] = TURBO_LUT[li];
            px[i * 4 + 1] = TURBO_LUT[li + 1];
            px[i * 4 + 2] = TURBO_LUT[li + 2];
            px[i * 4 + 3] = 255;
          }
          ctx.putImageData(img, 0, 0);
          setStatus(`${lo}–${hi} mm`);
        })
        .catch((e) => setStatus(`failed: ${String(e).slice(0, 60)}`))
        .finally(() => {
          inFlightRef.current = false;
        });
    };
    const since = Date.now() - lastRunRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!inFlightRef.current && since > 600) run();
    else timerRef.current = setTimeout(run, Math.max(120, 600 - since));
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [anchor, cam, kind, cleanRoot, repoId, currentTime]);

  return (
    <div className="h-full min-h-0 flex flex-col rounded bg-[#0b0e15] p-1">
      <div className="flex items-center justify-between shrink-0 px-1">
        <p className="text-[11px] text-slate-400 truncate">
          {cam} · {kind}
        </p>
        <p className="text-[10px] text-slate-500 truncate">{status}</p>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center">
        {kind === "color" ? (
          colorUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={colorUrl}
              alt={`${cam} color`}
              className="max-h-full max-w-full object-contain rounded"
            />
          )
        ) : (
          <canvas
            ref={canvasRef}
            width={DEPTH_W}
            height={DEPTH_H}
            className="max-h-full max-w-full object-contain rounded bg-black"
          />
        )}
      </div>
    </div>
  );
}

/** Discover RGBD cameras + the epoch anchor for a company-format episode. */
export function useRgbdCams(repoId: string, root?: string | null) {
  const [cams, setCams] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const cleanRoot = (root ?? "").replace(/^\/+|\/+$/g, "");
  useEffect(() => {
    setCams([]);
    setAnchor(null);
    if (!cleanRoot) return;
    let cancelled = false;
    (async () => {
      const files = await listRepoFiles(repoId).catch(() => [] as string[]);
      const esc = cleanRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const found = new Set<string>();
      for (const f of files) {
        const m = f.match(new RegExp(`^${esc}/videos/(RGBD_[^/]+)/`));
        if (m) found.add(m[1]);
      }
      const wristTs = await fetchTsColumn(
        buildVersionedUrl(
          repoId,
          "v3.0",
          "videos/observation.images.wrist/timestamp.csv",
        ),
      );
      if (cancelled) return;
      setCams([...found].sort());
      if (wristTs?.length) setAnchor(wristTs[0]);
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, cleanRoot]);
  return { cams, anchor };
}

// ---- panel ------------------------------------------------------------------

export default function RgbdPanel({
  repoId,
  root,
}: {
  repoId: string;
  root?: string | null;
}) {
  const [open, setOpen] = useState(true);
  const [cams, setCams] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);

  const cleanRoot = useMemo(
    () => (root ?? "").replace(/^\/+|\/+$/g, ""),
    [root],
  );

  useEffect(() => {
    setCams([]);
    setAnchor(null);
    if (!cleanRoot) return;
    let cancelled = false;
    (async () => {
      const files = await listRepoFiles(repoId).catch(() => [] as string[]);
      const esc = cleanRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const found = new Set<string>();
      for (const f of files) {
        const m = f.match(new RegExp(`^${esc}/videos/(RGBD_[^/]+)/`));
        if (m) found.add(m[1]);
      }
      const wristTs = await fetchTsColumn(
        buildVersionedUrl(
          repoId,
          "v3.0",
          "videos/observation.images.wrist/timestamp.csv",
        ),
      );
      if (cancelled) return;
      setCams([...found].sort());
      if (wristTs?.length) setAnchor(wristTs[0]);
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, cleanRoot]);

  if (!cleanRoot || cams.length === 0) return null;

  return (
    <div className="mb-6 panel p-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[10px] uppercase tracking-wide text-slate-500 hover:text-slate-300 transition-colors"
      >
        {open ? "▾" : "▸"} RGBD — color + depth, all cameras (server-decoded;
        first load per episode downloads the streams once)
      </button>
      {open && anchor !== null && (
        <div
          className="mt-3 grid gap-3"
          style={{
            gridTemplateColumns: `repeat(${Math.min(cams.length, 3)}, minmax(0, 1fr))`,
          }}
        >
          {cams.map((c) => (
            <RgbdCamView
              key={`${cleanRoot}/${c}`}
              repoId={repoId}
              cleanRoot={cleanRoot}
              cam={c}
              anchor={anchor}
            />
          ))}
        </div>
      )}
    </div>
  );
}
