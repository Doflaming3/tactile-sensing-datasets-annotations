"use client";

// High-frequency raw tactile stream (~91 Hz for Paxini — 3x the 30 Hz main
// data). Loads the episode's `sensors/<name>/*.csv` files on demand, parses
// them in the browser, and plots a window around the playhead: resultant Fz
// (solid), shear/normal ratio (dotted — slip indicator), and per-taxel
// peak |F| (faint). Contact transients between 30 Hz frames live here.
//
// Time alignment: each CSV carries absolute `calibrated_timestamp_ns`; the
// viewer clock is episode-relative seconds. We align by subtracting the
// stream's first timestamp — the sensors start streaming at episode start,
// so this is accurate to a few ms, which is fine for a zoom view. (Exact
// cross-stream alignment would need the video timestamp CSVs too.)

import { useEffect, useMemo, useState } from "react";
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
import { findRawSensorCsvs } from "@/utils/episodeDiscovery";
import { buildVersionedUrl } from "@/utils/versionUtils";
import { authHeaders } from "@/utils/auth";

const WINDOW_S = 1.5;
const SENSOR_COLORS = ["#38bdf8", "#a78bfa", "#34d399", "#f472b6"];

type RawStream = {
  name: string;
  hz: number;
  t: Float64Array;      // episode-relative seconds
  fz: Float64Array;     // resultant Fz (N)
  shear: Float64Array;  // |Fxy| / max(|Fz|, 0.2)
  peak: Float64Array;   // max per-taxel |F| (N)
};

function parseCsv(name: string, text: string): RawStream | null {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 3) return null;
  const header = lines[0].replace(/^﻿/, "").split(",");
  const iTs = header.indexOf("calibrated_timestamp_ns");
  const iFx = header.indexOf("fx");
  const iFy = header.indexOf("fy");
  const iFz = header.indexOf("fz");
  if (iTs < 0 || iFz < 0) return null;
  // taxel columns p_XX_fx / _fy / _fz
  const taxelTriples: [number, number, number][] = [];
  for (let c = 0; c < header.length; c++) {
    const h = header[c];
    if (/^p_\d+_fx$/.test(h)) {
      const base = h.slice(0, -3);
      const iy = header.indexOf(base + "_fy");
      const iz = header.indexOf(base + "_fz");
      if (iy >= 0 && iz >= 0) taxelTriples.push([c, iy, iz]);
    }
  }
  const n = lines.length - 1;
  const t = new Float64Array(n);
  const fz = new Float64Array(n);
  const shear = new Float64Array(n);
  const peak = new Float64Array(n);
  let t0 = NaN;
  for (let r = 0; r < n; r++) {
    const cols = lines[r + 1].split(",");
    const ts = Number(cols[iTs]);
    if (Number.isNaN(t0)) t0 = ts;
    t[r] = (ts - t0) / 1e9;
    const vfx = iFx >= 0 ? Number(cols[iFx]) : 0;
    const vfy = iFy >= 0 ? Number(cols[iFy]) : 0;
    const vfz = Number(cols[iFz]);
    fz[r] = vfz;
    shear[r] = Math.hypot(vfx, vfy) / Math.max(Math.abs(vfz), 0.2);
    let p = 0;
    for (const [ix, iy, iz] of taxelTriples) {
      const m = Math.hypot(Number(cols[ix]), Number(cols[iy]), Number(cols[iz]));
      if (m > p) p = m;
    }
    peak[r] = p;
  }
  const dur = t[n - 1] - t[0];
  return {
    name,
    hz: dur > 0 ? (n - 1) / dur : 0,
    t,
    fz,
    shear,
    peak,
  };
}

export default function RawStreamPanel({
  repoId,
  root,
}: {
  repoId: string;
  root?: string | null;
}) {
  const { currentTime } = useTime();
  const [open, setOpen] = useState(false);
  const [streams, setStreams] = useState<RawStream[] | null>(null);
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    setStreams(null);
    setStatus("");
    setOpen(false);
  }, [repoId, root]);

  useEffect(() => {
    if (!open || streams !== null) return;
    let cancelled = false;
    (async () => {
      try {
        setStatus("loading raw streams…");
        const paths = await findRawSensorCsvs(repoId, root);
        if (!paths.length) {
          if (!cancelled) setStatus("no raw sensor CSVs in this episode");
          if (!cancelled) setStreams([]);
          return;
        }
        const out: RawStream[] = [];
        for (const p of paths) {
          // buildVersionedUrl prepends the ?root= prefix already; the listing
          // paths are repo-relative, so strip the root prefix first.
          const rel = root ? p.slice(root.replace(/^\/+|\/+$/g, "").length + 1) : p;
          const url = buildVersionedUrl(repoId, "v3.0", rel);
          const res = await fetch(url, { headers: authHeaders() });
          if (!res.ok) continue;
          const text = await res.text();
          const parsed = parseCsv(
            p.split("/").pop()!.replace(/\.csv$/i, ""),
            text,
          );
          if (parsed) out.push(parsed);
          if (cancelled) return;
        }
        if (!cancelled) {
          setStreams(out);
          setStatus(
            out.length
              ? out.map((s) => `${s.name}: ${s.hz.toFixed(0)} Hz`).join(" · ")
              : "no parsable raw streams",
          );
        }
      } catch (e) {
        if (!cancelled) {
          setStreams([]);
          setStatus(`raw stream load failed: ${String(e)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, streams, repoId, root]);

  const windowData = useMemo(() => {
    if (!streams?.length) return [];
    const lo = currentTime - WINDOW_S;
    const hi = currentTime + WINDOW_S;
    // merge streams onto one array of rows keyed by time (streams have their
    // own clocks; rows stay per-stream so recharts connects lines correctly)
    const rows: Record<string, number>[] = [];
    streams.forEach((s, k) => {
      for (let i = 0; i < s.t.length; i++) {
        const tv = s.t[i];
        if (tv < lo || tv > hi) continue;
        rows.push({
          t: Number(tv.toFixed(4)),
          [`fz_${k}`]: Number(s.fz[i].toFixed(2)),
          [`shear_${k}`]: Number(s.shear[i].toFixed(3)),
          [`peak_${k}`]: Number(s.peak[i].toFixed(2)),
        });
      }
    });
    rows.sort((a, b) => a.t - b.t);
    return rows;
  }, [streams, currentTime]);

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] uppercase tracking-wide text-slate-500 hover:text-slate-300 transition-colors"
      >
        {open ? "▾" : "▸"} raw high-frequency stream
        {status && open ? (
          <span className="ml-2 normal-case text-slate-400">{status}</span>
        ) : null}
      </button>
      {open && streams && streams.length > 0 && (
        <div style={{ height: "min(18vh, 210px)", minHeight: 120 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={windowData}
              margin={{ top: 6, right: 8, bottom: 0, left: -18 }}
            >
              <XAxis
                dataKey="t"
                type="number"
                domain={[currentTime - WINDOW_S, currentTime + WINDOW_S]}
                tick={{ fontSize: 10, fill: "#64748b" }}
                tickFormatter={(v: number) => `${v.toFixed(1)}s`}
                allowDataOverflow
              />
              <YAxis tick={{ fontSize: 10, fill: "#64748b" }} width={46} />
              <Tooltip
                contentStyle={{
                  background: "#0b0e15",
                  border: "1px solid #1e293b",
                  fontSize: 11,
                }}
                labelFormatter={(v) => `t = ${Number(v).toFixed(3)} s`}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {streams.map((s, k) => (
                <Line
                  key={`fz${k}`}
                  dataKey={`fz_${k}`}
                  name={`${s.name} Fz`}
                  stroke={SENSOR_COLORS[k % SENSOR_COLORS.length]}
                  dot={false}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
              {streams.map((s, k) => (
                <Line
                  key={`sh${k}`}
                  dataKey={`shear_${k}`}
                  name={`${s.name} shear/normal`}
                  stroke={SENSOR_COLORS[k % SENSOR_COLORS.length]}
                  strokeDasharray="3 3"
                  dot={false}
                  strokeWidth={1}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
              {streams.map((s, k) => (
                <Line
                  key={`pk${k}`}
                  dataKey={`peak_${k}`}
                  name={`${s.name} peak|F|`}
                  stroke={SENSOR_COLORS[k % SENSOR_COLORS.length]}
                  strokeOpacity={0.35}
                  dot={false}
                  strokeWidth={1}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
              <ReferenceLine x={currentTime} stroke="#ef4444" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
