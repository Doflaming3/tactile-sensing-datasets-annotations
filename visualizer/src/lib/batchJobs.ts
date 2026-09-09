// The unit of work the batch page hands to a worker thread: one episode
// of one dataset, read and annotated end to end (parquet table, raw
// sidecars, the Hub's annotation file, the detector). Plain data only —
// it crosses a structured-clone boundary.
import type { DetectionThresholds } from "./eventDetection";
import type { RigProfile } from "./rigProfile";

export interface EpisodeJob {
  profile: RigProfile;
  org: string;
  dataset: string;
  /** `?root=` sub-folder of per-episode-folder datasets, else null */
  root: string | null;
  /** the signed-in user's Hub token: a worker has no localStorage */
  token: string | null;
  episode: number;
  /** this episode's raw sidecar paths (listed once on the main thread) */
  rawPaths: string[];
  useRaw: boolean;
  thresholds: Partial<DetectionThresholds>;
}
