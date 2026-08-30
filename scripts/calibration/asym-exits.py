"""Group every episode by finger-exit asymmetry around the task end.
Parses analysis/exit-audit.txt (current detector output, all terminals).
Families:
  SYNC     - fingers' last releases within 0.4s (normal case)
  EARLY    - one finger's last release >=0.4s BEFORE the partner's
  LATE     - one finger's last release >=0.4s AFTER the partner's
  TAIL     - drops occurring AFTER the episode's last release (residual/phantom tails)
  ONESIDED - only one finger ever has a terminal
"""
import re
from collections import defaultdict

ROW = re.compile(
    r"^ep\s*(\d+) f(\d) (release|drop)\s+t=\s*([\d.]+) conf=(\w+)"
)

rows = defaultdict(list)
with open("analysis/exit-audit.txt", encoding="utf-8") as fh:
    for line in fh:
        m = ROW.match(line)
        if m:
            ep, fi, label, t, conf = m.groups()
            rows[int(ep)].append((float(t), int(fi), label, conf))

sync, early_late, tails, onesided = [], [], [], []

for ep in sorted(rows):
    evs = sorted(rows[ep])
    fingers = {fi for _, fi, _, _ in evs}
    if len(fingers) == 1:
        onesided.append((ep, evs))
        continue
    last_rel = {}
    for t, fi, label, conf in evs:
        if label == "release":
            last_rel[fi] = (t, conf)
    if len(last_rel) == 2:
        (t0, c0), (t1, c1) = last_rel[0], last_rel[1]
        gap = t1 - t0  # + means f1 later
        if abs(gap) >= 0.4:
            early_late.append((ep, t0, c0, t1, c1, gap))
        else:
            sync.append(ep)
    # trailing drops after the last release of the episode
    if last_rel:
        t_end = max(t for t, _ in last_rel.values())
        for t, fi, label, conf in evs:
            if label == "drop" and t > t_end + 1e-6:
                tails.append((ep, fi, t, conf, t - t_end))

print("EARLY/LATE (fingers' last releases >=0.4s apart):")
for ep, t0, c0, t1, c1, gap in early_late:
    who = "f1 later" if gap > 0 else "f0 later"
    print(
        f"  ep{ep:2d}: f0 release {t0:6.2f} ({c0}), f1 release {t1:6.2f} ({c1})  gap {abs(gap):.2f}s ({who})"
    )
print("\nTAIL drops after last release:")
for ep, fi, t, conf, dt in tails:
    print(f"  ep{ep:2d}: f{fi} drop {t:6.2f} ({conf}), {dt:.2f}s after last release")
print("\nONE-SIDED (only one finger has terminals):")
for ep, evs in onesided:
    s = " ".join(f"f{fi}:{label}@{t:.2f}" for t, fi, label, _ in evs)
    print(f"  ep{ep:2d}: {s}")
print(f"\nSYNC (last releases within 0.4s): {len(sync)} episodes: {sync}")
