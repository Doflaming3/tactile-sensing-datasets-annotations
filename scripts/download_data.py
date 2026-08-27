"""Download the pinned SoTac dataset snapshots into data/.

Revisions are pinned on purpose — see DATA.md for the policy. To move a pin,
update DATA.md (keep a dated row of the old pin) and change it here in the
same commit.

Usage:
    python -m pip install -U huggingface_hub
    python scripts/download_data.py
"""

from pathlib import Path

from huggingface_hub import snapshot_download

REPO_ROOT = Path(__file__).resolve().parent.parent

PINS = {
    "Jingyi-Z/sotac": "e0fcfeb3171d48a88a4aa0d4fd8eaf5731f7cd58",
    "Jingyi-Z/sotac_raw": "18e0dfed13e4a6f18b1a0be224d9a458b95f6bd6",
}


def main() -> None:
    for repo_id, revision in PINS.items():
        local_dir = REPO_ROOT / "data" / repo_id.split("/")[1]
        print(f"{repo_id} @ {revision[:8]} -> {local_dir}")
        snapshot_download(
            repo_id=repo_id,
            repo_type="dataset",
            revision=revision,
            local_dir=str(local_dir),
        )
    print("done — see DATA.md for what is in each snapshot")


if __name__ == "__main__":
    main()
