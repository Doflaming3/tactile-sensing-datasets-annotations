"""Classify the differences between consecutive Hub saves of an episode's annotations.

Purpose: determine whether the episode 0-5 save pairs contain human timeline
edits, or only detector-version evolution (place backfill @ 00:09 UTC, compact
labels @ 00:16, contact debounce @ 01:17 — Space commits 52b4b11 / bd55a13 /
da167ee on 2026-08-27).

Usage:
    python scripts/extract_deltas.py
"""

import json
import re
from pathlib import Path

HIST = Path(__file__).resolve().parent.parent / "data" / "annotation-history"

PAIRS = {
    0: ("f99ffe5a", "5e0d63c2"),   # 23:49 -> 00:24 UTC
    1: ("ab67afdc", "60638d51"),   # 00:26 -> 01:23 UTC
    2: ("d38cb40f", "64794f91"),   # 00:29 -> 01:21 UTC
    45: ("1332842b", "f6a3b89a"),  # double-save 19 s apart (control pair)
}

AUTO_RE = re.compile(
    r"^\[auto:(?P<conf>\w+)\] (?P<label>\w+)(?: (?P<finger>f\d))?(?: (?P<span>[\d.]+)s)?$"
)


def load(ep: int, rev: str) -> list[dict]:
    path = HIST / f"episode_{ep:06d}_{rev}.json"
    return json.load(open(path, encoding="utf-8"))["atoms"]


def key(atom: dict) -> tuple:
    """Identity of an atom ignoring confidence/span, for move/modify matching."""
    m = AUTO_RE.match(atom["content"])
    if m:
        return ("event", m.group("label"), m.group("finger"))
    return (atom["style"], atom["content"], None)


def exact(atom: dict) -> tuple:
    return (atom["role"], atom["style"], atom["content"], round(atom["timestamp"], 6))


def classify(ep: int, rev_a: str, rev_b: str) -> None:
    a, b = load(ep, rev_a), load(ep, rev_b)
    a_exact = {exact(x): x for x in a}
    b_exact = {exact(x): x for x in b}

    unchanged = [x for x in b if exact(x) in a_exact]
    b_rest = [x for x in b if exact(x) not in a_exact]
    a_rest = [x for x in a if exact(x) not in b_exact]

    # Pair leftovers by identity key with nearest timestamp (<= 0.5 s) to
    # separate moved/modified atoms from true adds/deletes.
    moved, modified = [], []
    for xb in list(b_rest):
        candidates = [
            xa for xa in a_rest
            if key(xa) == key(xb) and abs(xa["timestamp"] - xb["timestamp"]) <= 0.5
        ]
        if not candidates:
            continue
        xa = min(candidates, key=lambda x: abs(x["timestamp"] - xb["timestamp"]))
        a_rest.remove(xa)
        b_rest.remove(xb)
        if xa["content"] == xb["content"]:
            moved.append((xa, xb))
        else:
            modified.append((xa, xb))

    print(f"\n=== episode {ep}: {rev_a} ({len(a)} atoms) -> {rev_b} ({len(b)} atoms)")
    print(f"  unchanged: {len(unchanged)}  moved: {len(moved)}  modified: {len(modified)}"
          f"  added: {len(b_rest)}  deleted: {len(a_rest)}")
    for xa, xb in moved:
        print(f"  MOVED    {xa['content']}: {xa['timestamp']:.3f} -> {xb['timestamp']:.3f}")
    for xa, xb in modified:
        print(f"  MODIFIED {xa['timestamp']:8.3f}  {xa['content']!r} -> {xb['content']!r}")
    for x in sorted(b_rest, key=lambda x: x["timestamp"]):
        print(f"  ADDED    {x['timestamp']:8.3f}  {x['content']}")
    for x in sorted(a_rest, key=lambda x: x["timestamp"]):
        print(f"  DELETED  {x['timestamp']:8.3f}  {x['content']}")


if __name__ == "__main__":
    for ep, (rev_a, rev_b) in PAIRS.items():
        classify(ep, rev_a, rev_b)
