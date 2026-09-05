"use client";
// Resolve the calibration profile for a dataset in the app: fetch the
// dataset's own meta/annotator_profile.json (404 = none), then the
// resolution order in rigProfile.resolveProfile, then attach the artifact
// screen's reference corpus from the profile's `screenReferencePath` (an
// app path under public/ for registry profiles, a repo-relative path for
// dataset-side profiles). One fetch per dataset, one per corpus.
import { useEffect, useState } from "react";
import { buildVersionedUrl } from "@/utils/versionUtils";
import { authHeaders } from "@/utils/auth";
import type { ScreenReference } from "./signalScreen";
import {
  ANNOTATOR_PROFILE_PATH,
  profileFromFile,
  resolveProfile,
  withScreenReference,
  type ProfileSource,
  type RigProfile,
} from "./rigProfile";

const fileCache = new Map<string, Promise<RigProfile | null>>();
const referenceCache = new Map<string, Promise<ScreenReference | null>>();

async function fetchDatasetProfile(repoId: string): Promise<RigProfile | null> {
  try {
    const res = await fetch(
      buildVersionedUrl(repoId, "v3.0", ANNOTATOR_PROFILE_PATH),
      {
        headers: authHeaders(),
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    return profileFromFile(await res.json());
  } catch {
    return null;
  }
}

/** The corpus a profile names: same-origin for app paths (`/...`, served
 * from public/), the dataset repo for repo-relative paths. null when it
 * cannot be loaded — the detector then flags `no_screen_reference`. */
function fetchScreenReference(
  repoId: string,
  path: string,
): Promise<ScreenReference | null> {
  const key = path.startsWith("/") ? path : `${repoId}|${path}`;
  let p = referenceCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const res = path.startsWith("/")
          ? await fetch(path, { cache: "force-cache" })
          : await fetch(buildVersionedUrl(repoId, "v3.0", path), {
              headers: authHeaders(),
              cache: "no-store",
            });
        if (!res.ok) return null;
        return (await res.json()) as ScreenReference;
      } catch {
        return null;
      }
    })();
    referenceCache.set(key, p);
  }
  return p;
}

async function attachReference(
  repoId: string,
  profile: RigProfile,
): Promise<RigProfile> {
  if (profile.calibration.screenReference || !profile.screenReferencePath) {
    return profile;
  }
  const ref = await fetchScreenReference(repoId, profile.screenReferencePath);
  return ref ? withScreenReference(profile, ref) : profile;
}

export function useRigProfile(
  repoId: string | null | undefined,
  override: string | null | undefined,
): {
  profile: RigProfile | null;
  source: ProfileSource | null;
  loading: boolean;
} {
  const [state, setState] = useState<{
    profile: RigProfile | null;
    source: ProfileSource | null;
    loading: boolean;
  }>({ profile: null, source: null, loading: true });
  useEffect(() => {
    if (!repoId) {
      setState({ profile: null, source: null, loading: false });
      return;
    }
    let alive = true;
    let p = fileCache.get(repoId);
    if (!p) {
      p = fetchDatasetProfile(repoId);
      fileCache.set(repoId, p);
    }
    setState((s) => ({ ...s, loading: true }));
    void p
      .then((file) => {
        const r = resolveProfile(repoId, override, file);
        // the profile is published only once its corpus is attached, so a
        // run in between can never silently skip the screen
        return attachReference(repoId, r.profile).then((profile) => ({
          profile,
          source: r.source,
        }));
      })
      .then((r) => {
        if (!alive) return;
        setState({ profile: r.profile, source: r.source, loading: false });
      });
    return () => {
      alive = false;
    };
  }, [repoId, override]);
  return state;
}
