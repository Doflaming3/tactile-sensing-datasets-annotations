"use client";

// Session-long high-rate raw sidecar (~0.3-1.2 kHz): per-element 3-axis
// readings in relative counts (no SI calibration). The recorder writes one
// sidecar per robot session under `board_raw/<sensor>/session_<stamp>/` (or
// `live_raw/<name>/session_<stamp>/`), NOT per episode, so this panel:
//   1. reads the episode's absolute time window from the first per-episode
//      91 Hz sensor CSV (`calibrated_timestamp_ns` — same clock),
//   2. picks the session whose `session.json` started_epoch_ns precedes it,
//   3. streams only the window's rows out of the session CSV, subtracts the
//      session-start baseline, and plots mean/peak per-element deviation
//      around the playhead.
// Contact transients far below the 30 Hz frame time live here.

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
import {
  findRawSensorCsvs,
  findRawSidecarSessions,
  type RawSidecarSession,
} from "@/utils/episodeDiscovery";
import { buildVersionedUrl } from "@/utils/versionUtils";
import { authHeaders } from "@/utils/auth";
import {
  parseBaselineCsv,
  parseSidecarWindow,
  csvEpochRange,
  type SidecarWindow,
} from "@/lib/rawSidecar";

const WINDOW_S = 1.5;
const EDGE_MARGIN_S = 2; // extra sidecar rows kept around the episode window
const MAX_POINTS = 1600; // decimation cap for the chart window
const SLOT_COLORS = ["#38bdf8", "#a78bfa", "#34d399", "#f472b6"];

type SlotStream = { name: string; win: SidecarWindow };

function toRel(repoRelPath: string, root?: string | null): string {
  return root
    ? repoRelPath.slice(root.replace(/^\/+|\/+$/g, "").length + 1)
    : repoRelPath;
}

async function fetchText(
  repoId: string,
  repoRelPath: string,
  root?: string | null,
): Promise<string | null> {
  const url = buildVersionedUrl(repoId, "v3.0", toRel(repoRelPath, root));
  const res = await fetch(url, { headers: authHeaders() });
  return res.ok ? res.text() : null;
}

/** Choose the session covering the episode: the last one started at or
 * before the episode's first timestamp (falls back to the last session). */
async function pickSession(
  sessions: RawSidecarSession[],
  episodeStartNs: number,
  repoId: string,
  root?: string | null,
): Promise<RawSidecarSession> {
  if (sessions.length === 1) return sessions[0];
  let best: RawSidecarSession | null = null;
  let bestStart = -Infinity;
  for (const s of sessions) {
    if (!s.sessionJson) continue;
    try {
      const txt = await fetchText(repoId, s.sessionJson, root);
      if (!txt) continue;
      const started = Number(
        (JSON.parse(txt) as { started_epoch_ns?: number }).started_epoch_ns,
      );
      if (
        Number.isFinite(started) &&
        started <= episodeStartNs &&
        started > bestStart
      ) {
        best = s;
        bestStart = started;
      }
    } catch {
      // unreadable metadata — skip this candidate
    }
  }
  return best ?? sessions[sessions.length - 1];
}

export default function RawSidecarPanel({
  repoId,
  root,
}: {
  repoId: string;
  root?: string | null;
}) {
  const { currentTime } = useTime();
  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState<SlotStream[] | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setSlots(null);
    setStatus("");
    setOpen(false);
  }, [repoId, root]);

  useEffect(() => {
    if (!open || slots !== null) return;
    let cancelled = false;
    (async () => {
      try {
        setStatus("loading sidecar…");
        const sessions = await findRawSidecarSessions(repoId, root);
        if (!sessions.length) {
          if (!cancelled) {
            setSlots([]);
            setStatus("no high-rate sidecar in this dataset");
          }
          return;
        }
        // Episode time window from the per-episode 91 Hz CSV (same clock).
        const epCsvs = await findRawSensorCsvs(repoId, root);
        if (!epCsvs.length) {
          if (!cancelled) {
            setSlots([]);
            setStatus(
              "sidecar found, but no per-episode sensor CSV to align it to",
            );
          }
          return;
        }
        const epText = await fetchText(repoId, epCsvs[0], root);
        const range = epText ? csvEpochRange(epText) : null;
        if (!range) {
          if (!cancelled) {
            setSlots([]);
            setStatus("could not read the episode's time window");
          }
          return;
        }
        const session = await pickSession(sessions, range.first, repoId, root);
        const lo = range.first - EDGE_MARGIN_S * 1e9;
        const hi = range.last + EDGE_MARGIN_S * 1e9;
        const out: SlotStream[] = [];
        for (const raw of session.rawFiles) {
          if (cancelled) return;
          const basePath = session.baselines[raw];
          const [rawText, baseText] = await Promise.all([
            fetchText(repoId, raw, root),
            basePath ? fetchText(repoId, basePath, root) : null,
          ]);
          if (!rawText) continue;
          const baseline = baseText ? parseBaselineCsv(baseText) : null;
          const win = parseSidecarWindow(
            rawText,
            lo,
            hi,
            range.first,
            baseline,
          );
          if (win) {
            const name =
              raw
                .split("/")
                .pop()!
                .replace(/(_)?raw\.csv$/i, "") || session.sensor;
            out.push({ name: name || session.sensor, win });
          }
        }
        if (!cancelled) {
          setSlots(out);
          setStatus(
            out.length
              ? out
                  .map((s) => `${s.name}: ${s.win.hz.toFixed(0)} Hz`)
                  .join(" · ") + " · Δcounts vs session baseline"
              : "no sidecar rows inside this episode's window",
          );
        }
      } catch (e) {
        if (!cancelled) {
          setSlots([]);
          setStatus(`sidecar load failed: ${String(e)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, slots, repoId, root]);

  const windowData = useMemo(() => {
    if (!slots?.length) return [];
    const lo = currentTime - WINDOW_S;
    const hi = currentTime + WINDOW_S;
    const rows: Record<string, number>[] = [];
    slots.forEach((s, k) => {
      const { t, mean, peak } = s.win;
      // window bounds via linear scan is fine (arrays are one episode long)
      let i0 = 0;
      while (i0 < t.length && t[i0] < lo) i0++;
      let i1 = i0;
      while (i1 < t.length && t[i1] <= hi) i1++;
      const n = i1 - i0;
      const stride = Math.max(1, Math.ceil(n / MAX_POINTS));
      for (let i = i0; i < i1; i += stride) {
        rows.push({
          t: Number(t[i].toFixed(4)),
          [`mean_${k}`]: Number(mean[i].toFixed(1)),
          [`peak_${k}`]: Number(peak[i].toFixed(1)),
        });
      }
    });
    rows.sort((a, b) => a.t - b.t);
    return rows;
  }, [slots, currentTime]);

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] uppercase tracking-wide text-slate-500 hover:text-slate-300 transition-colors"
      >
        {open ? "▾" : "▸"} high-rate raw sidecar
        {status && open ? (
          <span className="ml-2 normal-case text-slate-400">{status}</span>
        ) : null}
      </button>
      {open && slots && slots.length > 0 && (
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
              {slots.map((s, k) => (
                <Line
                  key={`mean${k}`}
                  dataKey={`mean_${k}`}
                  name={`${s.name} mean Δ`}
                  stroke={SLOT_COLORS[k % SLOT_COLORS.length]}
                  dot={false}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
              {slots.map((s, k) => (
                <Line
                  key={`peak${k}`}
                  dataKey={`peak_${k}`}
                  name={`${s.name} peak Δ`}
                  stroke={SLOT_COLORS[k % SLOT_COLORS.length]}
                  strokeOpacity={0.4}
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
