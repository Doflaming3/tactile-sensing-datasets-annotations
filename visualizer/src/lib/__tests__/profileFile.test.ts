import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ANNOTATOR_PROFILE_SCHEMA,
  profileFromFile,
  resolveProfile,
  SOTAC_PROFILE,
  TEMPLATE_PROFILE,
  templateProfileFile,
} from "../rigProfile";

describe("dataset-side profile files", () => {
  test("the shipped template equals the code's template (no drift)", () => {
    const shipped = JSON.parse(
      readFileSync(
        join(process.cwd(), "public", "annotator_profile.template.json"),
        "utf-8",
      ),
    );
    expect(shipped).toEqual(JSON.parse(JSON.stringify(templateProfileFile())));
  });

  test("the template parses back into an UNVERIFIED profile with sotac's numbers", () => {
    const p = profileFromFile(
      JSON.parse(JSON.stringify(templateProfileFile())),
    );
    expect(p).not.toBeNull();
    expect(p!.verified).toBe(false);
    expect(p!.calibration.weakAttemptMaxN).toBe(
      SOTAC_PROFILE.calibration.weakAttemptMaxN,
    );
    expect(p!.calibration.screenReference).toBeNull();
  });

  test("a broken file is rejected, not half-applied", () => {
    expect(
      profileFromFile({ schema: ANNOTATOR_PROFILE_SCHEMA, id: "x" }),
    ).toBeNull();
    const bad = JSON.parse(JSON.stringify(templateProfileFile()));
    bad.calibration.handLossN = "one newton";
    expect(profileFromFile(bad)).toBeNull();
    expect(profileFromFile(null)).toBeNull();
  });

  test("resolution order: dataset file > override > registry > template", () => {
    const file = profileFromFile({
      ...templateProfileFile(),
      id: "their-rig",
      verified: true,
    });
    expect(resolveProfile("someone/x", SOTAC_PROFILE.id, file).source).toBe(
      "dataset-file",
    );
    expect(resolveProfile("someone/x", SOTAC_PROFILE.id, null).source).toBe(
      "override",
    );
    expect(resolveProfile("Jingyi-Z/sotac", null, null).source).toBe(
      "registry",
    );
    const t = resolveProfile("someone/x", null, null);
    expect(t.source).toBe("template");
    expect(t.profile).toBe(TEMPLATE_PROFILE);
    expect(t.profile.verified).toBe(false);
  });
});
