"""Validate detected failed-attempt flags against her hand-recorded attempt counts.

Prerequisite (writes the report this script reads):
    bun scripts/run-detector.ts --all --compare --report analysis/attempts-check.json

Then:
    python scripts/check_attempts.py

Detected attempts = 1 + number of `failed_attempt@Xs` flags per episode,
compared against `attempts` in data/sotac/annotations/episode_annotations.json.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

rows = {r["episode"]: r for r in json.load(open(ROOT / "analysis/attempts-check.json"))}
meta = json.load(open(ROOT / "data/sotac/annotations/episode_annotations.json"))["episodes"]

agree = 0
total = 0
lines = []
for ep_str, m in sorted(meta.items(), key=lambda x: int(x[0])):
    ep = int(ep_str)
    if ep not in rows:
        continue
    flags = rows[ep]["flags"]
    n_flags = sum(
        1
        for f in flags
        if f.startswith("failed_attempt") or f.startswith("possible_attempt")
    )
    # The base 1 stands for the FINAL engagement (the successful grab on
    # success episodes, the last try on failures). On failure episodes
    # whose terminal loss is itself flagged (squeeze-through / air-miss
    # detectors), the base would double-count that same try.
    base = 0 if (m.get("result") == "failure" and n_flags > 0) else 1
    detected = base + n_flags
    hers = m.get("attempts", 1)
    total += 1
    if detected == hers:
        agree += 1
    else:
        lines.append(
            f"  ep{ep:2d}: detected {detected}, her metadata {hers}, "
            f"result={m.get('result')}, flags={flags}"
        )
print(f"attempt-count agreement: {agree}/{total}")
print("disagreements:")
print("\n".join(lines) if lines else "  none")
