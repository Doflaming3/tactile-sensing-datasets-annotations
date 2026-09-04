/**
 * Dataset references with an optional pinned Hub revision.
 *
 * `org/name` reads the repo's `main` branch (the Hub default). `org/name@rev`
 * pins every read to `rev` — a branch, a tag or a commit sha (short shas
 * resolve too) — the notation huggingface_hub itself uses. The reference
 * travels through the URL path (`/org/name@rev/episode_3`), so every link,
 * cache key and fetch in the app inherits the pin without threading a
 * revision argument through the call sites.
 *
 * Why (2026-09-03): the Hub dataset was renumbered underneath live links —
 * 100 episodes added and everything re-sorted by task — so `episode_23`
 * silently became a different recording. A pinned reference keeps a review
 * session, a demo or a written note pointing at the data it was made on.
 * Writes never go to a pinned reference: commits target a branch, and
 * saving annotations for one numbering into another would corrupt it.
 */
export interface RepoRef {
  /** `org/name`, without the revision suffix */
  repoId: string;
  /** branch, tag or commit sha; `main` when not pinned */
  revision: string;
  /** true when the reference carries an explicit `@revision` */
  pinned: boolean;
}

export function parseRepoRef(ref: string): RepoRef {
  const at = ref.indexOf("@");
  if (at < 0) return { repoId: ref, revision: "main", pinned: false };
  const repoId = ref.slice(0, at);
  const revision = ref.slice(at + 1).trim();
  return revision
    ? { repoId, revision, pinned: true }
    : { repoId, revision: "main", pinned: false };
}

/** `${base}/${repo}/resolve/${revision}/${path}` — the Hub file URL for a
 * (possibly pinned) reference. Slashes in a branch name (`refs/pr/1`) are
 * escaped the way the Hub expects. */
export function hubResolveUrl(base: string, ref: string, path: string): string {
  const { repoId, revision } = parseRepoRef(ref);
  return `${base}/${repoId}/resolve/${encodeURIComponent(revision)}/${path}`;
}

/** Short display form of a pinned revision (7 chars of a sha, full name of
 * a branch or tag). */
export function shortRevision(revision: string): string {
  return /^[0-9a-f]{12,40}$/i.test(revision) ? revision.slice(0, 7) : revision;
}

/** The Hub web page for a reference: the repo root for `main`, the tree at
 * the pinned revision otherwise. */
export function hubRepoPageUrl(ref: string): string {
  const { repoId, revision, pinned } = parseRepoRef(ref);
  const base = `https://huggingface.co/datasets/${repoId}`;
  return pinned ? `${base}/tree/${encodeURIComponent(revision)}` : base;
}
