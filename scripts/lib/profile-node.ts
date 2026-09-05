// Node-side resolver step for rig profiles: attach the artifact screen's
// reference corpus from disk. The profile object never embeds the corpus
// (Jingyi's PR #1 review: "move the corpus out of src and load it from the
// per dataset profile"); the app attaches it in useRigProfile, the offline
// scripts here. App paths (leading "/") live under visualizer/public,
// dataset paths under the local mirror root.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  withScreenReference,
  type RigProfile,
} from "../../visualizer/src/lib/rigProfile";
import type { ScreenReference } from "../../visualizer/src/lib/signalScreen";

const PUBLIC_DIR = join("visualizer", "public");

/** The profile with its corpus attached; unchanged when it embeds one
 * already, names none, or the file is missing (the detector then flags
 * `no_screen_reference`, so a silent skip is impossible). */
export function loadScreenReference(
  profile: RigProfile,
  mirrorRoot?: string,
): RigProfile {
  if (profile.calibration.screenReference || !profile.screenReferencePath) {
    return profile;
  }
  const p = profile.screenReferencePath;
  const file = p.startsWith("/")
    ? join(PUBLIC_DIR, p.slice(1))
    : mirrorRoot
      ? join(mirrorRoot, p)
      : null;
  if (!file || !existsSync(file)) return profile;
  return withScreenReference(
    profile,
    JSON.parse(readFileSync(file, "utf-8")) as ScreenReference,
  );
}
