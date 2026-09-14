// Parsing for the session-long high-rate raw sidecar CSVs.
//
// File format (spec from the recorder):
//   header: t_epoch_ns,e0_x,e0_y,e0_z,...,e11_x,e11_y,e11_z   (37 columns)
//   one row per poll, ~0.3-1.2 kHz; t_epoch_ns = time.time_ns() at read.
//   Values are per-element 3-axis readings in RELATIVE COUNTS (int) — no
//   unit, no SI calibration, no offset removal.
// Baseline file: element,x,y,z — 12 rows of float means at session start.
//
// The sidecar spans the whole recording session; the viewer selects the rows
// belonging to one episode by epoch-ns timestamp window. Epoch ns exceeds
// 2^53, so Number() loses ~200 ns — irrelevant at the ms alignment level.

export const SIDECAR_ELEMENTS = 12;

export interface SidecarBaseline {
  /** [element][axis], SIDECAR_ELEMENTS x 3 */
  values: number[][];
}

export function parseBaselineCsv(text: string): SidecarBaseline | null {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const values: number[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 4) continue;
    const el = Number(cols[0]);
    if (!Number.isFinite(el)) continue;
    values[el] = [Number(cols[1]), Number(cols[2]), Number(cols[3])];
  }
  return values.length ? { values } : null;
}

export interface SidecarWindow {
  /** episode-relative seconds (epoch ns minus tZeroNs) */
  t: Float64Array;
  /** mean over elements of |reading - baseline| (vector magnitude, counts) */
  mean: Float64Array;
  /** max over elements of |reading - baseline| (counts) */
  peak: Float64Array;
  /** measured sample rate inside the window (Hz) */
  hz: number;
}

/**
 * Extract the rows of a raw sidecar CSV that fall inside [loNs, hiNs] and
 * reduce each row to mean/peak per-element deviation from the baseline.
 * Rows are timestamp-ordered, so parsing stops early past hiNs.
 *
 * @param tZeroNs epoch ns that maps to t=0 (the episode clock origin)
 */
export function parseSidecarWindow(
  text: string,
  loNs: number,
  hiNs: number,
  tZeroNs: number,
  baseline: SidecarBaseline | null,
): SidecarWindow | null {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return null;
  const header = lines[0].replace(/^﻿/, "").split(",");
  if (header[0] !== "t_epoch_ns") return null;
  // column index of e{i}_x for each element actually present in the header
  const elCols: number[] = [];
  for (let i = 0; i < SIDECAR_ELEMENTS; i++) {
    const c = header.indexOf(`e${i}_x`);
    if (c >= 0 && header[c + 1] === `e${i}_y` && header[c + 2] === `e${i}_z`) {
      elCols.push(c);
    }
  }
  if (!elCols.length) return null;
  const t: number[] = [];
  const mean: number[] = [];
  const peak: number[] = [];
  for (let r = 1; r < lines.length; r++) {
    const line = lines[r];
    if (!line) continue;
    const comma = line.indexOf(",");
    if (comma <= 0) continue;
    const ts = Number(line.slice(0, comma));
    if (!Number.isFinite(ts)) continue;
    if (ts < loNs) continue;
    if (ts > hiNs) break; // rows are time-ordered
    const cols = line.split(",");
    let sum = 0;
    let mx = 0;
    let counted = 0;
    for (let e = 0; e < elCols.length; e++) {
      const c = elCols[e];
      const b = baseline?.values[e];
      const dx = Number(cols[c]) - (b ? b[0] : 0);
      const dy = Number(cols[c + 1]) - (b ? b[1] : 0);
      const dz = Number(cols[c + 2]) - (b ? b[2] : 0);
      const m = Math.hypot(dx, dy, dz);
      if (Number.isFinite(m)) {
        sum += m;
        if (m > mx) mx = m;
        counted++;
      }
    }
    if (!counted) continue;
    t.push((ts - tZeroNs) / 1e9);
    mean.push(sum / counted);
    peak.push(mx);
  }
  const n = t.length;
  if (n < 2) return null;
  const dur = t[n - 1] - t[0];
  return {
    t: Float64Array.from(t),
    mean: Float64Array.from(mean),
    peak: Float64Array.from(peak),
    hz: dur > 0 ? (n - 1) / dur : 0,
  };
}

/** First and last epoch-ns timestamps of a per-episode sensor CSV (the 91 Hz
 * calibrated stream) — the episode's absolute time window, used to slice the
 * session-long sidecar. */
export function csvEpochRange(
  text: string,
  column = "calibrated_timestamp_ns",
): { first: number; last: number } | null {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 3) return null;
  const header = lines[0].replace(/^﻿/, "").split(",");
  const iTs = header.indexOf(column);
  if (iTs < 0) return null;
  const first = Number(lines[1].split(",")[iTs]);
  const last = Number(lines[lines.length - 1].split(",")[iTs]);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) {
    return null;
  }
  return { first, last };
}
