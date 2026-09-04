// Save annotations straight to the dataset repo on the Hugging Face Hub.
//
// Commits `annotations/episode_{N:06d}.json` (atoms + review metadata) as the
// SIGNED-IN USER via the Hub commit API. Authorization is enforced by the Hub
// itself: only accounts with write access to the dataset repo can commit —
// visitors get a 403 and their edits stay local. Requires the OAuth
// `write-repos` scope (Space README) or a pasted user token with write access.

import type { LanguageAtom } from "@/types/language.types";
import { getAuthToken } from "./auth";
import { getDatasetPathPrefix } from "./versionUtils";
import { hubResolveUrl, parseRepoRef } from "./repoRef";

const HUB = "https://huggingface.co";

export function annotationsPathFor(episodeId: number): string {
  return `${getDatasetPathPrefix()}annotations/episode_${String(episodeId).padStart(6, "0")}.json`;
}

/** Fetch previously committed annotations for an episode from the Hub.
 * Returns null when the file does not exist (episode never saved). */
export async function fetchAnnotationsFromHub(
  repoId: string,
  episodeId: number,
): Promise<SavedAnnotations | null> {
  const path = annotationsPathFor(episodeId);
  const token = getAuthToken();
  const res = await fetch(hubResolveUrl(`${HUB}/datasets`, repoId, path), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: "no-store",
  });
  if (!res.ok) return null;
  try {
    return (await res.json()) as SavedAnnotations;
  } catch {
    return null;
  }
}

export interface SavedAnnotations {
  schema_version: 1;
  episode_index: number;
  saved_at: string;
  saved_by?: string;
  atoms: LanguageAtom[];
}

/** Commit the episode's annotations JSON to the dataset repo. Throws with a
 * readable message on auth/permission failures. Returns the repo path. */
/** A pinned reference is read-only: commits land on a branch, and writing
 * one numbering's annotations into another would corrupt the dataset. */
function writableRepoId(repoId: string): string {
  const ref = parseRepoRef(repoId);
  if (ref.pinned) {
    throw new Error(
      `This view is pinned to revision ${ref.revision}; saving to the Hub is ` +
        "disabled. Open the dataset without @revision to save.",
    );
  }
  return ref.repoId;
}

export async function commitAnnotationsToHub(
  repoId: string,
  episodeId: number,
  atoms: LanguageAtom[],
): Promise<string> {
  const writeRepo = writableRepoId(repoId);
  const token = getAuthToken();
  if (!token) {
    throw new Error("Not signed in — use the sign-in button first.");
  }
  const path = annotationsPathFor(episodeId);
  const payload: SavedAnnotations = {
    schema_version: 1,
    episode_index: episodeId,
    saved_at: new Date().toISOString(),
    atoms,
  };
  const content = btoa(
    String.fromCharCode(
      ...new TextEncoder().encode(JSON.stringify(payload, null, 1)),
    ),
  );
  const ndjson =
    JSON.stringify({
      key: "header",
      value: {
        summary: `annotations: episode ${episodeId} (${atoms.length} atoms)`,
      },
    }) +
    "\n" +
    JSON.stringify({
      key: "file",
      value: { path, content, encoding: "base64" },
    });
  const res = await fetch(`${HUB}/api/datasets/${writeRepo}/commit/main`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-ndjson",
    },
    body: ndjson,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "The Hub rejected the write (no write permission on this dataset, " +
          "or the sign-in token lacks the write scope — sign out and back in).",
      );
    }
    throw new Error(`Hub commit failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return path;
}

// ---- manual per-episode review status ---------------------------------------
// One aggregated file so the sidebar needs a single fetch. Distinct from the
// curation file (episode_annotations.json), which marks curation review and
// is true for every kept episode.

export interface ReviewStatus {
  episodes: Record<string, { reviewed_at: string }>;
}

export function reviewStatusPath(): string {
  return `${getDatasetPathPrefix()}annotations/review_status.json`;
}

export async function fetchReviewStatus(repoId: string): Promise<ReviewStatus> {
  const token = getAuthToken();
  try {
    const res = await fetch(
      hubResolveUrl(`${HUB}/datasets`, repoId, reviewStatusPath()),
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      },
    );
    if (!res.ok) return { episodes: {} };
    const j = (await res.json()) as ReviewStatus;
    return j?.episodes ? j : { episodes: {} };
  } catch {
    return { episodes: {} };
  }
}

/** Toggle the manual reviewed mark for an episode and commit the updated
 * status file to the dataset repo. Returns the new status. */
export async function setEpisodeReviewed(
  repoId: string,
  episodeId: number,
  reviewed: boolean,
): Promise<ReviewStatus> {
  const writeRepo = writableRepoId(repoId);
  const token = getAuthToken();
  if (!token) {
    throw new Error("Not signed in — use the sign-in button first.");
  }
  const status = await fetchReviewStatus(repoId);
  const key = String(episodeId);
  if (reviewed) {
    status.episodes[key] = { reviewed_at: new Date().toISOString() };
  } else {
    delete status.episodes[key];
  }
  const path = reviewStatusPath();
  const content = btoa(
    String.fromCharCode(
      ...new TextEncoder().encode(JSON.stringify(status, null, 1)),
    ),
  );
  const ndjson =
    JSON.stringify({
      key: "header",
      value: {
        summary: `review: episode ${episodeId} ${reviewed ? "reviewed" : "unreviewed"}`,
      },
    }) +
    "\n" +
    JSON.stringify({
      key: "file",
      value: { path, content, encoding: "base64" },
    });
  const res = await fetch(`${HUB}/api/datasets/${writeRepo}/commit/main`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-ndjson",
    },
    body: ndjson,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Review commit failed: ${res.status} ${body.slice(0, 150)}`,
    );
  }
  return status;
}

/** Load previously saved annotations for an episode from the dataset repo.
 * Returns null when none exist (404) or on parse failure. */
export async function fetchSavedAnnotations(
  repoId: string,
  episodeId: number,
): Promise<SavedAnnotations | null> {
  const token = getAuthToken();
  try {
    const res = await fetch(
      hubResolveUrl(`${HUB}/datasets`, repoId, annotationsPathFor(episodeId)),
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as SavedAnnotations;
    if (!Array.isArray(data.atoms)) return null;
    return data;
  } catch {
    return null;
  }
}
