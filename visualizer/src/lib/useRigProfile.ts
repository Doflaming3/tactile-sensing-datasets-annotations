"use client";
// Resolve the calibration profile for a dataset in the app: fetch the
// dataset's own meta/annotator_profile.json (404 = none), then the
// resolution order in rigProfile.resolveProfile. One fetch per dataset.
import { useEffect, useState } from "react";
import { buildVersionedUrl } from "@/utils/versionUtils";
import { authHeaders } from "@/utils/auth";
import type { ScreenReference } from "./signalScreen";
import {
  ANNOTATOR_PROFILE_PATH,
  profileFromFile,
  resolveProfile,
  type ProfileSource,
  type RigProfile,
} from "./rigProfile";

const fileCache = new Map<string, Promise<RigProfile | null>>();

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
    const json = (await res.json()) as { screenReferencePath?: string | null };
    let reference: ScreenReference | null = null;
    if (json && typeof json === "object" && json.screenReferencePath) {
      const r2 = await fetch(
        buildVersionedUrl(repoId, "v3.0", json.screenReferencePath),
        {
          headers: authHeaders(),
          cache: "no-store",
        },
      );
      if (r2.ok) reference = (await r2.json()) as ScreenReference;
    }
    return profileFromFile(json, reference);
  } catch {
    return null;
  }
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
    void p.then((file) => {
      if (!alive) return;
      const r = resolveProfile(repoId, override, file);
      setState({ profile: r.profile, source: r.source, loading: false });
    });
    return () => {
      alive = false;
    };
  }, [repoId, override]);
  return state;
}
