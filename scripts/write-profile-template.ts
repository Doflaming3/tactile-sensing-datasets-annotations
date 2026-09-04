// Regenerates visualizer/public/annotator_profile.template.json from the
// code's template (rigProfile.ts). A test fails when the shipped file
// drifts from the code. Run: bun scripts/write-profile-template.ts
import { writeFileSync } from "node:fs";
import { templateProfileFile } from "../visualizer/src/lib/rigProfile";
const out = "visualizer/public/annotator_profile.template.json";
writeFileSync(out, JSON.stringify(templateProfileFile(), null, 2) + "\n");
console.log(`wrote ${out}`);
