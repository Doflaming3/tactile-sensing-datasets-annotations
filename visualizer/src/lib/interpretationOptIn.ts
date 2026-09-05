// Per-SESSION opt-in for the interpretation layer on a dataset whose
// profile does not opt in (Jingyi's PR B: the layer is behind a per-dataset
// opt-in; Zheng's template ruling keeps the annotator usable on day one).
// A module-level store, like the display toggle in tactile-panel.tsx: it
// survives tab switches and episode navigation within the page and resets
// on reload, so base mode is always the state a fresh visit starts in. The
// auto-label panel reads it for the detector, the tactile panels for the
// corrected display's residual gate, so both follow the same switch.
import { useSyncExternalStore } from "react";

import type { RigProfile } from "./rigProfile";

let sessionOptIn = false;
const subs = new Set<() => void>();

export function setSessionInterpretation(v: boolean): void {
  if (sessionOptIn === v) return;
  sessionOptIn = v;
  subs.forEach((cb) => cb());
}

export function useSessionInterpretation(): boolean {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => sessionOptIn,
    () => false,
  );
}

/** The profile a run should use: the dataset's own, or a copy opted in
 * for this session. */
export function activeProfileFor(
  profile: RigProfile | null,
  session: boolean,
): RigProfile | null {
  return profile && session && !profile.interpretation
    ? { ...profile, interpretation: true }
    : profile;
}
