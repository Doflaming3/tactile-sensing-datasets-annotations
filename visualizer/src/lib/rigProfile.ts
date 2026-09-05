/**
 * Rig / dataset calibration profiles (Jingyi's PR #1 precondition for the
 * interpretation layer, cycle 5, 2026-09-04).
 *
 * The annotator's rules are physics, but many of its NUMBERS were measured
 * on one rig — Paxini DP-S2015-Elite fingertips on an SO-101 gripper, the
 * sotac objects, Zheng's video verdicts. Forces in newtons, jaw travel in
 * the gripper's units, arm speed in its units, stage durations for one
 * task family, and a 971-window screen reference corpus. Applying them
 * silently to another dataset produces confident nonsense, so:
 *
 *  - every rig-calibrated number lives here, grouped per rule, with its
 *    provenance (the census or verdict that set it) in the audit
 *    `analysis/portability.md`;
 *  - the detector and the series builders REQUIRE a profile — there is no
 *    default anywhere; the app refuses to run the interpretation layer on
 *    a dataset that matches no profile (`profileForDataset`), and the
 *    display's corrected view falls back to raw;
 *  - a dataset recorded on a known rig but under another name can be
 *    opened with an explicit `?profile=<id>` override — explicit, never
 *    implicit.
 *
 * What is NOT here: seconds-based debounces and windows (contact exit
 * 0.3 s, brief contact 0.03 s, release windows, slide window, retry
 * confirm) and quanta-based floors (single-taxel floor, stuck-taxel
 * count) — those are structure and physics, tied to the measured sensor
 * quantum, and stay in eventDetection.ts.
 */
import { DEFAULT_THRESHOLDS, type DetectionThresholds } from "./eventDetection";
import type { ScreenReference } from "./signalScreen";
import { resolveTaxelLayout, type TaxelLayout } from "./taxel-layouts";

export interface RigCalibration {
  /** signal-level thresholds (N, hf units …) — the user-tunable set */
  thresholds: DetectionThresholds;
  // ---- forces (N)
  /** pre-grasp bout peaking below this is weak_contact, not an attempt */
  weakAttemptMaxN: number;
  /** brief touches are reported from this far below the weak line */
  briefReportMarginN: number;
  /** "hand quiet" after a drop: total force below this */
  handLossN: number;
  /** idle margin of the baseline tracker and of the residual gate */
  quietMarginN: number;
  /** a finger carries this much before its CoP is trusted for slides */
  slideLoadMinN: number;
  // ---- jaw travel (gripper units)
  /** jaw at or below this = pads meet, nothing between them (air_grasp) */
  airClosePos: number;
  /** re-open after a loss that counts as a retry */
  jawRetryRiseU: number;
  /** close below the own hold width that reads as squeeze-through */
  squeezeThroughBelowU: number;
  /** close-and-reopen travel of an air miss */
  airMissTravelU: number;
  /** net opening around a force exit that makes it a release */
  releaseTravelMinU: number;
  /** jaw closing right at the exit vetoes release (squeeze-out) */
  releaseClosingVetoU: number;
  /** jaw net-open over the slide window (loosening) */
  slideJawOpenMinU: number;
  /** a prior close this deep marks a squeeze rebound, not a slide */
  slideSqueezeVetoU: number;
  /** chained attempt spans merge when the jaw never re-opened this much */
  attemptMergeReopenU: number;
  /** re-close from the running max that the residual gate reads as a grab */
  jawRecloseU: number;
  /** jaw close that counts as a re-grip squeeze for the transport anchor */
  squeezeMinTravelU: number;
  // ---- arm (joint units per second)
  /** summed joint speed above which the arm is moving (transport anchor) */
  armMoveEpsUps: number;
  // ---- geometry (mm, from the taxel layout)
  /** CoP travel along the finger that makes a sustained slide */
  slideMinMm: number;
  // ---- task timing (s)
  /** corpus p90 stage durations: approach, grasp, transport, place_release */
  hesitationP90S: number[];
  /** transports shorter than this raise the wrong-location card */
  shortTransportMinS: number;
  // ---- artifact screen
  /** per-rig reference corpus, attached by the resolvers from
   * `RigProfile.screenReferencePath`; null = screen off */
  screenReference: ScreenReference | null;
}

export interface RigProfile {
  id: string;
  label: string;
  sensor: string;
  gripper: string;
  /** dataset ids (org/name, revision stripped) this profile is valid for */
  datasets: RegExp[];
  /** false = the numbers were not verified on this rig (the shipped
   * template, or a dataset file that says so): every result carries
   * `profile_unverified` and the app reminds the user */
  verified: boolean;
  /** Where the artifact screen's reference corpus is loaded from when
   * `calibration.screenReference` is null: an app path (leading `/`,
   * served from `public/`) for registry profiles, a repo-relative path
   * for dataset-side profiles. The resolvers attach the corpus
   * (useRigProfile in the app, scripts/lib/profile-node.ts offline); the
   * profile object never embeds it, so the corpus stays out of the
   * bundle (Jingyi's review: "move the corpus out of src and load it
   * from the per dataset profile"). */
  screenReferencePath?: string | null;
  /** Taxel layouts this profile supplies, keyed by taxel count and
   * consulted before the built-in tables (taxel-layouts.ts): points in
   * mm, finger long axis = +Y, one entry per sensor model the dataset
   * carries. Jingyi's review: "the per dataset profile should be able to
   * supply a layout the same way it supplies thresholds". Without a
   * layout for a count the detector says `no_layout`. */
  layouts?: Record<number, TaxelLayout>;
  calibration: RigCalibration;
}

/** sotac's reference corpus, served by the app from public/ (built by
 * scripts/build-screen-reference.ts). */
export const SOTAC_SCREEN_REFERENCE_PATH =
  "/screen-reference/sotac-paxini-so101.json";

export const SOTAC_PROFILE: RigProfile = {
  id: "sotac-paxini-so101",
  label: "sotac: Paxini DP-S2015-Elite fingertips on SO-101",
  sensor: "Paxini DP-S2015-Elite, 2 x 52 taxels, 0.2 N quantum",
  gripper: "SO-101 jaw, position units, opening = increasing",
  datasets: [/^Jingyi-Z\/sotac(_raw)?$/],
  verified: true,
  screenReferencePath: SOTAC_SCREEN_REFERENCE_PATH,
  calibration: {
    thresholds: DEFAULT_THRESHOLDS,
    weakAttemptMaxN: 2.3,
    briefReportMarginN: 0.3,
    handLossN: 1.0,
    quietMarginN: 1.0,
    slideLoadMinN: 1.0,
    airClosePos: 2.0,
    jawRetryRiseU: 5.0,
    squeezeThroughBelowU: 8.0,
    airMissTravelU: 8.0,
    releaseTravelMinU: 2.0,
    releaseClosingVetoU: -1.0,
    slideJawOpenMinU: 1.0,
    slideSqueezeVetoU: -5.0,
    attemptMergeReopenU: 5.0,
    jawRecloseU: 5.0,
    squeezeMinTravelU: 8,
    armMoveEpsUps: 12,
    slideMinMm: 2.0,
    hesitationP90S: [6.32, 2.2, 4.56, 1.26],
    shortTransportMinS: 1.0,
    screenReference: null, // attached by the resolvers from the path above
  },
};

export const RIG_PROFILES: RigProfile[] = [SOTAC_PROFILE];

export function profileById(id: string | null | undefined): RigProfile | null {
  if (!id) return null;
  return RIG_PROFILES.find((p) => p.id === id) ?? null;
}

/** The profile a dataset reference resolves to: an explicit `override`
 * (the `?profile=` search param) wins, else the registry by dataset id
 * with any `@revision` stripped; null = refuse to run the interpretation
 * layer. */
export function profileForDataset(
  ref: string | null | undefined,
  override?: string | null,
): RigProfile | null {
  const explicit = profileById(override);
  if (explicit) return explicit;
  if (!ref) return null;
  const repoId = ref.split("@")[0];
  return (
    RIG_PROFILES.find((p) => p.datasets.some((re) => re.test(repoId))) ?? null
  );
}

/** One-line reason shown when no profile matches. */
export function noProfileMessage(ref: string): string {
  return (
    `No calibration profile for ${ref.split("@")[0]}. The annotator's rig ` +
    "constants (forces, jaw travel, arm speed, stage durations, screen " +
    "reference) were calibrated on " +
    RIG_PROFILES.map((p) => `${p.id} (${p.label})`).join("; ") +
    ". Add a profile in rigProfiles, or open the dataset with " +
    "?profile=<id> if it was recorded on a known rig."
  );
}

// ---------------------------------------------------------------- dataset-side profiles
//
// Zheng's ruling (2026-09-04): someone with a different dataset must know
// where to put a profile, and must be able to start from OUR numbers. So:
//  - a dataset carries `meta/annotator_profile.json` (ANNOTATOR_PROFILE_PATH),
//    the JSON form below, read before the registry;
//  - the app ships a TEMPLATE = the sotac numbers with `verified: false`;
//    when a dataset has neither a file nor a registry match, the template is
//    used and the user is reminded, in the panel and in every result
//    (`profile_unverified` flag), that these numbers come from another rig
//    and how to calibrate them (README "Using the annotator on another
//    dataset"; the census scripts under scripts/calibration/).
// Note for Jingyi's review: her precondition asked for a hard refusal; the
// template-plus-reminder is Zheng's deliberate choice so the tool is usable
// on day one, with the unverified state impossible to miss.

/** where a dataset declares its own profile (repo-relative) */
export const ANNOTATOR_PROFILE_PATH = "meta/annotator_profile.json";
export const ANNOTATOR_PROFILE_SCHEMA = "annotator-profile/1";

/** JSON form of a profile as stored in a dataset (the screen reference is
 * a separate repo-relative file, optional; without it the artifact screen
 * is off). `provenance` says per field where a number came from. */
export interface AnnotatorProfileFile {
  schema: typeof ANNOTATOR_PROFILE_SCHEMA;
  id: string;
  label: string;
  sensor: string;
  gripper: string;
  verified: boolean;
  calibration: Omit<RigCalibration, "screenReference">;
  screenReferencePath?: string | null;
  /** taxel layouts keyed by taxel count (as JSON keys): `{ "52": { model,
   * points: [[x, y, z], ...] } }`, mm, finger long axis = +Y */
  layouts?: Record<
    string,
    { model?: string; points: [number, number, number][] }
  >;
  provenance?: Record<string, string>;
  notes?: string;
}

const NUMERIC_FIELDS: Array<
  keyof Omit<
    RigCalibration,
    "screenReference" | "thresholds" | "hesitationP90S"
  >
> = [
  "weakAttemptMaxN",
  "briefReportMarginN",
  "handLossN",
  "quietMarginN",
  "slideLoadMinN",
  "airClosePos",
  "jawRetryRiseU",
  "squeezeThroughBelowU",
  "airMissTravelU",
  "releaseTravelMinU",
  "releaseClosingVetoU",
  "slideJawOpenMinU",
  "slideSqueezeVetoU",
  "attemptMergeReopenU",
  "jawRecloseU",
  "squeezeMinTravelU",
  "armMoveEpsUps",
  "slideMinMm",
  "shortTransportMinS",
];

/** Layouts from the file form: every key must be a positive integer equal
 * to its point count, every point a finite [x, y, z]. Returns null for
 * "none given", undefined for "malformed" (the caller rejects the file). */
function parseLayouts(
  raw: unknown,
  model: string,
): Record<number, TaxelLayout> | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<number, TaxelLayout> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(key);
    if (!Number.isInteger(n) || n <= 0) return undefined;
    const l = val as { model?: unknown; points?: unknown };
    if (!l || !Array.isArray(l.points) || l.points.length !== n)
      return undefined;
    const points: [number, number, number][] = [];
    for (const pt of l.points as unknown[]) {
      if (
        !Array.isArray(pt) ||
        pt.length !== 3 ||
        !pt.every((v) => typeof v === "number" && Number.isFinite(v))
      )
        return undefined;
      points.push([pt[0], pt[1], pt[2]] as [number, number, number]);
    }
    out[n] = { model: typeof l.model === "string" ? l.model : model, points };
  }
  return Object.keys(out).length ? out : null;
}

/** The taxel layout for a taxel count: the profile's own first, then the
 * built-in tables. null = no geometry (the detector flags `no_layout`,
 * the tiles cannot draw the pad). */
export function layoutFor(
  profile: RigProfile | null | undefined,
  nTaxels: number,
): TaxelLayout | null {
  return profile?.layouts?.[nTaxels] ?? resolveTaxelLayout(nTaxels);
}

/** Parse a dataset's profile file; null when it is not a valid profile
 * (the caller then falls back). Unknown fields are ignored; every known
 * numeric field must be a finite number. */
export function profileFromFile(
  json: unknown,
  screenReference: ScreenReference | null = null,
): RigProfile | null {
  if (!json || typeof json !== "object") return null;
  const f = json as Partial<AnnotatorProfileFile>;
  if (f.schema !== ANNOTATOR_PROFILE_SCHEMA || !f.id || !f.calibration)
    return null;
  const c = f.calibration as Record<string, unknown>;
  for (const k of NUMERIC_FIELDS) {
    if (typeof c[k] !== "number" || !Number.isFinite(c[k] as number))
      return null;
  }
  const p90 = c.hesitationP90S;
  if (
    !Array.isArray(p90) ||
    p90.length !== 4 ||
    !p90.every((v) => typeof v === "number")
  )
    return null;
  const th = {
    ...DEFAULT_THRESHOLDS,
    ...((c.thresholds as Partial<DetectionThresholds>) ?? {}),
  };
  const layouts = parseLayouts(f.layouts, String(f.sensor ?? f.id));
  if (layouts === undefined) return null; // malformed layout: whole file rejected
  return {
    id: String(f.id),
    label: String(f.label ?? f.id),
    sensor: String(f.sensor ?? "unknown sensor"),
    gripper: String(f.gripper ?? "unknown gripper"),
    datasets: [],
    verified: f.verified === true,
    screenReferencePath: f.screenReferencePath ?? null,
    layouts: layouts ?? undefined,
    calibration: {
      ...(c as unknown as RigCalibration),
      thresholds: th,
      hesitationP90S: p90 as number[],
      screenReference,
    },
  };
}

/** The shipped template: the sotac numbers, marked unverified. */
export const TEMPLATE_PROFILE: RigProfile = {
  ...SOTAC_PROFILE,
  id: "template-from-sotac",
  label: "TEMPLATE — sotac numbers, NOT verified on this rig",
  datasets: [],
  verified: false,
  screenReferencePath: null,
  calibration: { ...SOTAC_PROFILE.calibration, screenReference: null },
};

/** The profile with a loaded reference corpus attached (a new object; the
 * input is not mutated). */
export function withScreenReference(
  profile: RigProfile,
  screenReference: ScreenReference | null,
): RigProfile {
  return {
    ...profile,
    calibration: { ...profile.calibration, screenReference },
  };
}

/** The template as the JSON a user copies into their dataset. Generated
 * from the same object the code uses; a test keeps the shipped file in
 * sync. */
export function templateProfileFile(): AnnotatorProfileFile {
  const { screenReference: _sr, ...calibration } = SOTAC_PROFILE.calibration;
  void _sr;
  const verdict =
    "copied from sotac (video-verdict calibration) — verify on this rig";
  const measured = "copied from sotac (measured) — re-measure on this rig";
  return {
    schema: ANNOTATOR_PROFILE_SCHEMA,
    id: "my-rig",
    label: "EDIT ME: sensor + gripper + task family",
    sensor: "EDIT ME (e.g. Paxini DP-S2015-Elite, 2 x 52 taxels)",
    gripper: "EDIT ME (e.g. SO-101 jaw, position units, opening = increasing)",
    verified: false,
    calibration,
    screenReferencePath: null,
    layouts: {},
    provenance: {
      thresholds: measured,
      weakAttemptMaxN: verdict,
      briefReportMarginN: verdict,
      handLossN: verdict,
      quietMarginN: measured,
      slideLoadMinN: measured,
      airClosePos: verdict,
      jawRetryRiseU: measured,
      squeezeThroughBelowU: verdict,
      airMissTravelU: measured,
      releaseTravelMinU: measured,
      releaseClosingVetoU: verdict,
      slideJawOpenMinU: measured,
      slideSqueezeVetoU: verdict,
      attemptMergeReopenU: verdict,
      jawRecloseU: measured,
      squeezeMinTravelU: measured,
      armMoveEpsUps: measured,
      slideMinMm: verdict,
      hesitationP90S:
        "copied from sotac (task-family census) — re-derive from this dataset",
      layouts:
        'empty = the built-in taxel tables (Paxini models, by taxel count); add your sensor here when no table matches: { "<taxel count>": { model, points: [[x, y, z], ...] } } in mm, finger long axis = +Y',
      shortTransportMinS: measured,
    },
    notes:
      "Copy this file to <dataset>/meta/annotator_profile.json, edit the header, " +
      "set verified: true only after the numbers were checked on this rig " +
      "(protocol: analysis/portability.md, scripts/calibration/). Until then every " +
      "result carries profile_unverified.",
  };
}

export type ProfileSource =
  | "dataset-file"
  | "override"
  | "registry"
  | "template";

/** Resolution order: the dataset's own file, an explicit ?profile= override,
 * the registry by dataset id, then the template (unverified). */
export function resolveProfile(
  ref: string | null | undefined,
  override: string | null | undefined,
  datasetFile: RigProfile | null,
): { profile: RigProfile; source: ProfileSource } {
  if (datasetFile) return { profile: datasetFile, source: "dataset-file" };
  const explicit = profileById(override);
  if (explicit) return { profile: explicit, source: "override" };
  const known = profileForDataset(ref);
  if (known) return { profile: known, source: "registry" };
  return { profile: TEMPLATE_PROFILE, source: "template" };
}

/** The reminder shown whenever the template is in use. */
export function templateReminder(ref: string): string {
  return (
    `${ref.split("@")[0]} has no calibration profile, so the annotator is running ` +
    "with the TEMPLATE: numbers measured on sotac's rig (Paxini fingertips on an " +
    "SO-101). Forces, jaw units, arm speed and stage durations may not apply here; " +
    "every result is flagged profile_unverified. To calibrate: copy the template to " +
    `${ANNOTATOR_PROFILE_PATH} in the dataset, edit it, and set verified after checking ` +
    "the numbers (README: Using the annotator on another dataset)."
  );
}
