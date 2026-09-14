// Discovery + file listing for "per-episode-folder" datasets (e.g.
// summer-dong/lerobot-ball-pickplace-0813): the repo root has NO
// meta/info.json — instead every episode lives in its own sub-folder that is
// itself a complete v3 dataset (`<...>/<timestamp>/meta/info.json`), possibly
// nested under grouping layers ("任务集35/<timestamp>/..."). We list the repo
// once (cached) and treat each folder containing meta/info.json as one
// virtual episode; the viewer navigates between them via `?root=`.
//
// The cached listing is also how the raw-stream panel finds an episode's
// high-frequency sensor CSVs (`<root>/sensors/<name>/*.csv`).

import { listFiles } from "@huggingface/hub";
import { getAuthToken } from "./auth";
import { parseRepoRef } from "./repoRef";

const MARKER = "/meta/info.json";

const listingCache = new Map<string, Promise<string[]>>();

/** Every file path in the repo (repo-relative), cached per repo+auth. */
export function listRepoFiles(repoId: string): Promise<string[]> {
  const token = getAuthToken();
  const key = `${repoId}::${token ? "auth" : "anon"}`;
  const hit = listingCache.get(key);
  if (hit) return hit;
  const p = (async () => {
    const paths: string[] = [];
    const ref = parseRepoRef(repoId);
    for await (const entry of listFiles({
      repo: { type: "dataset", name: ref.repoId },
      revision: ref.revision,
      recursive: true,
      ...(token ? { accessToken: token } : {}),
    })) {
      if (entry.type === "file") paths.push(entry.path);
    }
    return paths;
  })();
  // Don't cache failures (e.g. 401 before the token was pasted).
  p.catch(() => listingCache.delete(key));
  listingCache.set(key, p);
  return p;
}

/** All episode-folder paths (repo-relative, no trailing slash), sorted.
 *  Empty when the repo is a normal root-level dataset. */
export async function discoverEpisodeFolders(
  repoId: string,
): Promise<string[]> {
  const files = await listRepoFiles(repoId);
  const folders = files
    .filter((f) => f.endsWith(MARKER) && f !== "meta/info.json")
    .map((f) => f.slice(0, -MARKER.length));
  folders.sort();
  return folders;
}

// ---- session-long high-rate raw sidecar --------------------------------------
// Layout (written by the recorder, one session per robot connect):
//   <...>/board_raw/<sensor>/session_<stamp>/slotNN_raw.csv  (+ slotNN_baseline.csv, session.json)
//   <...>/live_raw/<sensor>/session_<stamp>/raw.csv          (+ baseline.csv)
// Rows are t_epoch_ns + 36 per-element raw counts, ~0.3-1.2 kHz, spanning the
// whole session (not per episode) — the viewer windows them by timestamp.

export interface RawSidecarSession {
  /** sensor name path segment */
  sensor: string;
  /** repo-relative session directory, no trailing slash */
  dir: string;
  /** raw CSV paths inside the session dir (one per raw-capable module) */
  rawFiles: string[];
  /** matching baseline CSV for a raw file, when present */
  baselines: Record<string, string>;
  /** repo-relative session.json path, when present */
  sessionJson: string | null;
}

const SIDECAR_RE =
  /(?:^|\/)(?:board_raw|live_raw)\/([^/]+)\/(session_[^/]+)\/([^/]+)$/;

/** High-rate raw sidecar sessions under one episode root ("" = repo root),
 *  grouped by session directory, sorted by directory name (chronological —
 *  the stamp is part of the name). */
export async function findRawSidecarSessions(
  repoId: string,
  root: string | null | undefined,
): Promise<RawSidecarSession[]> {
  const files = await listRepoFiles(repoId);
  const prefix = root ? root.replace(/^\/+|\/+$/g, "") + "/" : "";
  const byDir = new Map<string, RawSidecarSession>();
  for (const f of files) {
    if (prefix && !f.startsWith(prefix)) continue;
    const m = SIDECAR_RE.exec(f);
    if (!m) continue;
    const [, sensor, , base] = m;
    const dir = f.slice(0, f.length - base.length - 1);
    let s = byDir.get(dir);
    if (!s) {
      s = { sensor, dir, rawFiles: [], baselines: {}, sessionJson: null };
      byDir.set(dir, s);
    }
    if (/^(slot\d+_)?raw\.csv$/i.test(base)) {
      s.rawFiles.push(f);
    } else if (base === "session.json") {
      s.sessionJson = f;
    }
  }
  // second pass: pair baselines with their raw files
  for (const s of byDir.values()) {
    s.rawFiles.sort();
    for (const raw of s.rawFiles) {
      const cand = raw.replace(/raw\.csv$/i, "baseline.csv");
      if (files.includes(cand)) s.baselines[raw] = cand;
    }
  }
  return [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Raw high-frequency sensor CSV paths for one episode root ("" = repo
 *  root), repo-relative. */
export async function findRawSensorCsvs(
  repoId: string,
  root: string | null | undefined,
): Promise<string[]> {
  const files = await listRepoFiles(repoId);
  const prefix = root ? root.replace(/^\/+|\/+$/g, "") + "/" : "";
  return files
    .filter(
      (f) =>
        f.startsWith(`${prefix}sensors/`) &&
        f.toLowerCase().endsWith(".csv") &&
        !f.slice(prefix.length).includes("layout"),
    )
    .sort();
}
