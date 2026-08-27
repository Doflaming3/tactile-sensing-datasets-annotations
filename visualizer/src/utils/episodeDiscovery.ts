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
    for await (const entry of listFiles({
      repo: { type: "dataset", name: repoId },
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
