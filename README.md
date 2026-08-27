# Tactile Data & Models — Download Guide
# 触觉数据与模型下载指南

This repository holds **no data**. It holds the scripts and the manifest that let
anyone pull the same 26 datasets and 20 models from the Hugging Face Hub onto their
own machine, into an identical directory layout.

本仓库**不存放数据本身**，只存放脚本和清单，任何人都可以据此把相同的 26 个数据集和
20 个模型从 Hugging Face Hub 拉到自己本地，并得到完全一致的目录结构。

> All repos live under the [`Jingyi-Z`](https://huggingface.co/Jingyi-Z) namespace on
> Hugging Face. Check each repo's license on its Hub page before redistributing or
> publishing results.
> 所有仓库都在 Hugging Face 的 `Jingyi-Z` 命名空间下。二次分发或发表结果前，请先在
> 各仓库页面确认其 license。

---

## 1. Prerequisites / 环境准备

```bash
pip install -U huggingface_hub
```

This installs the `hf` CLI. Verify:

```bash
hf --version
```

**Optional but recommended / 建议但非必需** — log in to lift the anonymous rate limit
and speed up downloads. Without it you'll see a `Warning: You are sending
unauthenticated requests` message.

```bash
hf auth login
```

**Faster transfers / 加速下载**:

```bash
pip install -U hf_transfer
# then set the env var before downloading:
export HF_HUB_ENABLE_HF_TRANSFER=1     # Linux / macOS
$env:HF_HUB_ENABLE_HF_TRANSFER=1       # Windows PowerShell
```

---

## 2. Quick start / 一键下载

**Linux / macOS**

```bash
git clone <this-repo-url>
cd <this-repo>
./scripts/download_all.sh                      # -> ./data
./scripts/download_all.sh /path/to/your/data   # -> custom location
```

**Windows PowerShell**

```powershell
git clone <this-repo-url>
cd <this-repo>
.\scripts\download_all.ps1
.\scripts\download_all.ps1 -Root "D:\tactile data"
```

Both scripts read `scripts/manifest.tsv`, so the repo list lives in exactly one
place. If a download fails partway, just re-run — completed files are skipped.

两个脚本都读取 `scripts/manifest.tsv`，仓库清单只有这一份。中途失败直接重跑即可，
已完成的文件会被跳过。

---

## 3. Resulting layout / 下载后的目录结构

```
<your-root>/
├── raw/                                   26 datasets
│   ├── sotac/
│   ├── sotac_raw/
│   ├── mlxtac/
│   ├── so101_paxini_test_20260818_173340/
│   ├── ...
│   └── <each dataset in its own folder>
│       └── .cache/huggingface/            ← incremental-download metadata, do not delete
│
├── models/                                20 models
│   ├── pi0_so101/
│   ├── mlxtac_act_stackcup_tactile_token/
│   ├── ...
│   └── <each model in its own folder>
│
├── annotations/                           ← your own labels go HERE, not in raw/
└── scripts/                               ← your processing code
```

**Keep `raw/` and `models/` read-only.** Write every annotation, label file, and
intermediate product into `annotations/`, referencing raw files by relative path
(e.g. `sotac/train/sample_001.npy`). The download tool compares file hashes against
the Hub — if you edit a file in place, the next run will detect the mismatch and
**overwrite it**.

**`raw/` 和 `models/` 请当作只读。** 所有标注、标签文件和中间产物都写到 `annotations/`，
用相对路径引用原始文件。下载工具是按文件哈希跟远端比对的，如果你就地修改了某个文件，
下次运行会检测到不一致并**覆盖掉你的修改**。

---

## 4. How updates work / 更新机制

Running a script again does **not** re-download everything:

```
read <dest>/.cache/huggingface/  (local etag records)
        ↓
compare against the Hub, file by file
        ↓
├── identical → skip, no transfer
├── changed   → download just that file
└── new       → download
```

So a second run over a 1 GB dataset with three changed files transfers only those
three files, and finishes in seconds.

所以对一个 1 GB 的数据集来说，如果只有三个文件变了，第二次运行只传这三个文件，几秒结束。

**Two known limitations / 两个已知限制:**

- Files deleted upstream are **not** removed locally. Your copy only grows.
  上游删除的文件本地不会自动删，你的副本只增不减。
- The comparison uses hashes, not timestamps — one more reason not to edit `raw/`.
  比对用的是哈希不是修改时间，这也是不要改 `raw/` 的原因之一。

**Pinning a version / 锁定版本.** If you are mid-annotation and want a stable base,
add `--revision <commit-sha>` to a command so upstream changes can't shift the data
under you. Grab the SHA from the repo's *Files → History* tab on the Hub.

```bash
hf download Jingyi-Z/sotac --repo-type=dataset \
  --revision e1426b1f89e0a763738ddee390132840fdb852a1 \
  --local-dir "./data/raw/sotac"
```

---

## 5. Downloading a single repo / 只下载单个仓库

The rule is the same for every entry — **datasets need `--repo-type=dataset`,
models need nothing** (model is the CLI default):

```bash
# dataset
hf download Jingyi-Z/<name> --repo-type=dataset --local-dir "<root>/raw/<name>"

# model
hf download Jingyi-Z/<name> --local-dir "<root>/models/<name>"
```

To grab only part of a large model repo:

```bash
hf download Jingyi-Z/pi0_so101 --include "*.safetensors" "config.json" \
  --local-dir "./data/models/pi0_so101"
```

### `--local-dir` vs. the default cache / 两种模式的区别

| | default cache (no `--local-dir`) | `--local-dir` (used here) |
|---|---|---|
| Layout | `blobs/` + `snapshots/` + symlinks | original file tree |
| Readable by hand | no (hash-named blobs) | yes |
| Disk on Windows | ~2× (no symlink permission → files copied) | 1× |
| Incremental updates | yes | yes |
| Good for | repeated `load_dataset()`, multi-version | annotation, inspection, copying |

`--local-dir` is used throughout because this data is meant to be opened, labeled,
and processed by hand.

本项目全程使用 `--local-dir`，因为这些数据是要拿来人工打开、标注、处理的。

---

## 6. Inventory / 仓库清单

Groupings below are inferred from repo names. Edit the descriptions to match the
actual experiments before publishing.

下面的分组是按仓库命名推断的，正式公开前请把描述改成实际的实验内容。

### 6.1 Datasets (26) → `raw/`

**Curated sets / 整理后的数据集**

| # | Repo | Local folder |
|---|------|--------------|
| 1 | `Jingyi-Z/sotac` | `raw/sotac` |
| 2 | `Jingyi-Z/sotac_raw` | `raw/sotac_raw` |
| 3 | `Jingyi-Z/mlxtac` | `raw/mlxtac` |

**`so101_paxini_test` sessions — 2026-08-18**

| # | Repo | Local folder |
|---|------|--------------|
| 4 | `Jingyi-Z/so101_paxini_test_20260818_173340` | `raw/so101_paxini_test_20260818_173340` |
| 5 | `Jingyi-Z/so101_paxini_test_20260818_173041` | `raw/so101_paxini_test_20260818_173041` |
| 6 | `Jingyi-Z/so101_paxini_test_20260818_171519` | `raw/so101_paxini_test_20260818_171519` |
| 7 | `Jingyi-Z/so101_paxini_test_20260818_162210` | `raw/so101_paxini_test_20260818_162210` |
| 8 | `Jingyi-Z/so101_paxini_test_20260818_161242` | `raw/so101_paxini_test_20260818_161242` |
| 9 | `Jingyi-Z/so101_paxini_test_20260818_160615` | `raw/so101_paxini_test_20260818_160615` |

**Other 2026-08 sessions**

| # | Repo | Local folder |
|---|------|--------------|
| 10 | `Jingyi-Z/company_format_test_20260818_142239` | `raw/company_format_test_20260818_142239` |
| 11 | `Jingyi-Z/two_finger_pi_test_20260811_160535` | `raw/two_finger_pi_test_20260811_160535` |
| 12 | `Jingyi-Z/two_finger_test_20260807_185218` | `raw/two_finger_test_20260807_185218` |
| 13 | `Jingyi-Z/two_finger_test_20260807_184633` | `raw/two_finger_test_20260807_184633` |

**Sensor characterization + pick-place — 2026-05-13 / 05-14**

| # | Repo | Local folder |
|---|------|--------------|
| 14 | `Jingyi-Z/so101-tactile-pick-place-v1_20260514_211037` | `raw/so101-tactile-pick-place-v1_20260514_211037` |
| 15 | `Jingyi-Z/motion_noise_test_20260514_200145` | `raw/motion_noise_test_20260514_200145` |
| 16 | `Jingyi-Z/thermal_drift_test_20260514_181952` | `raw/thermal_drift_test_20260514_181952` |
| 17 | `Jingyi-Z/noise_analysis_0514_20260514_170959` | `raw/noise_analysis_0514_20260514_170959` |
| 18 | `Jingyi-Z/pick_and_place_test_0513_Yibai_20260513_181730` | `raw/pick_and_place_test_0513_Yibai_20260513_181730` |
| 19 | `Jingyi-Z/pick_and_place_test_0513_Yibai_20260513_180135` | `raw/pick_and_place_test_0513_Yibai_20260513_180135` |
| 20 | `Jingyi-Z/pick_and_place_test_0513_20260513_175247` | `raw/pick_and_place_test_0513_20260513_175247` |

**Wrist pick-place ball-bowl — training set + eval rollouts**

| # | Repo | Role | Local folder |
|---|------|------|--------------|
| 21 | `Jingyi-Z/so101-wrist-pick-place-ball-bowl-v1` | training data | `raw/so101-wrist-pick-place-ball-bowl-v1` |
| 22 | `Jingyi-Z/eval_act-so101-wrist-pick-place-ball-bowl-v1` | eval rollout | `raw/eval_act-so101-wrist-pick-place-ball-bowl-v1` |
| 23 | `Jingyi-Z/eval_act-so101-wrist-pick-place-ball-bowl-v1.1` | eval rollout | `raw/eval_act-so101-wrist-pick-place-ball-bowl-v1.1` |
| 24 | `Jingyi-Z/eval_act-so101-wrist-pick-place-ball-bowl-v1.2` | eval rollout | `raw/eval_act-so101-wrist-pick-place-ball-bowl-v1.2` |
| 25 | `Jingyi-Z/eval_act-so101-wrist-pick-place-ball-bowl-v1.3` | eval rollout | `raw/eval_act-so101-wrist-pick-place-ball-bowl-v1.3` |

**Misc**

| # | Repo | Local folder |
|---|------|--------------|
| 26 | `Jingyi-Z/so101-pickplacetest` | `raw/so101-pickplacetest` |

### 6.2 Models (20) → `models/`

**VLA base**

| # | Repo | Local folder |
|---|------|--------------|
| M1 | `Jingyi-Z/pi0_so101` | `models/pi0_so101` |

**`mlxtac` ACT ablation — 3 tasks × 3 tactile encodings**

| encoding \ task | stackcup | elastic | redball |
|---|---|---|---|
| `tactile_token` | M2 | M3 | M4 |
| `tactile_env` | M5 | M6 | M7 |
| `baseline` | M8 | M9 | M10 |

| # | Repo | Local folder |
|---|------|--------------|
| M2 | `Jingyi-Z/mlxtac_act_stackcup_tactile_token` | `models/mlxtac_act_stackcup_tactile_token` |
| M3 | `Jingyi-Z/mlxtac_act_elastic_tactile_token` | `models/mlxtac_act_elastic_tactile_token` |
| M4 | `Jingyi-Z/mlxtac_act_redball_tactile_token` | `models/mlxtac_act_redball_tactile_token` |
| M5 | `Jingyi-Z/mlxtac_act_stackcup_tactile_env` | `models/mlxtac_act_stackcup_tactile_env` |
| M6 | `Jingyi-Z/mlxtac_act_elastic_tactile_env` | `models/mlxtac_act_elastic_tactile_env` |
| M7 | `Jingyi-Z/mlxtac_act_redball_tactile_env` | `models/mlxtac_act_redball_tactile_env` |
| M8 | `Jingyi-Z/mlxtac_act_stackcup_baseline` | `models/mlxtac_act_stackcup_baseline` |
| M9 | `Jingyi-Z/mlxtac_act_elastic_baseline` | `models/mlxtac_act_elastic_baseline` |
| M10 | `Jingyi-Z/mlxtac_act_redball_baseline` | `models/mlxtac_act_redball_baseline` |

**`act-so101-tactile` fusion variants**

| # | Repo | Local folder |
|---|------|--------------|
| M11 | `Jingyi-Z/act-so101-tactile-mlp` | `models/act-so101-tactile-mlp` |
| M12 | `Jingyi-Z/act-so101-tactile-sensormod` | `models/act-so101-tactile-sensormod` |
| M13 | `Jingyi-Z/act-so101-tactile-fastverif` | `models/act-so101-tactile-fastverif` |
| M14 | `Jingyi-Z/act-so101-tactile-baseline` | `models/act-so101-tactile-baseline` |

**Wrist pick-place ball-bowl policy versions**

| # | Repo | Local folder |
|---|------|--------------|
| M15 | `Jingyi-Z/act-so101-wrist-pick-place-ball-bowl-v1` | `models/act-so101-wrist-pick-place-ball-bowl-v1` |
| M16 | `Jingyi-Z/act-so101-wrist-pick-place-ball-bowl-v1.1` | `models/act-so101-wrist-pick-place-ball-bowl-v1.1` |
| M17 | `Jingyi-Z/act-so101-wrist-pick-place-ball-bowl-v1.2` | `models/act-so101-wrist-pick-place-ball-bowl-v1.2` |
| M18 | `Jingyi-Z/act-so101-wrist-pick-place-ball-bowl-v1.3` | `models/act-so101-wrist-pick-place-ball-bowl-v1.3` |
| M19 | `Jingyi-Z/act-so101-wrist-pick-place-ball-bowl-v1.4` | `models/act-so101-wrist-pick-place-ball-bowl-v1.4` |

**Misc**

| # | Repo | Local folder |
|---|------|--------------|
| M20 | `Jingyi-Z/act_so101_pickplace` | `models/act_so101_pickplace` |

### 6.3 Provenance chain / 数据-模型对应链

```
raw/so101-wrist-pick-place-ball-bowl-v1                    (training data)
        ↓
models/act-so101-wrist-pick-place-ball-bowl-{v1 … v1.4}    (5 policy versions)
        ↓
raw/eval_act-so101-wrist-pick-place-ball-bowl-{v1 … v1.3}  (rollouts; v1.4 has none)
```

---

## 7. Why the data isn't in this repo / 为什么数据不进这个仓库

| Constraint | Limit |
|---|---|
| GitHub single file | **100 MB hard reject** |
| GitHub repo size | warning above 1 GB |
| Git LFS free tier | 1 GB storage + 1 GB/month bandwidth |

The `sotac` dataset alone is ~1 GB, and model checkpoints run larger. Committed data
also stays in git history forever — deleting it later requires rewriting history with
`git filter-repo`. Keeping data on the Hub and scripts in git is both cheaper and the
normal practice for research projects.

光 `sotac` 一个数据集就约 1 GB，模型权重更大。而且数据一旦进了 git 历史就永久留在里面，
以后删掉也不释放空间，得用 `git filter-repo` 重写历史。数据留在 Hub、脚本进 git，
既省事也是学术项目的常规做法。

---

## 8. Troubleshooting / 常见问题

**Files ended up loose in the root instead of a subfolder.**
`--local-dir` does not create a folder named after the repo — it puts the repo's
contents directly into the path you give. Pass the full path including the repo name.
`--local-dir` 不会自动建以仓库名命名的子目录，它把仓库内容直接放进你给的路径。

**Moving an already-downloaded folder.** Move the hidden `.cache/` along with it, or
the next run re-downloads everything:

```powershell
Get-ChildItem -Force | Move-Item -Destination <new-path>   # -Force includes .cache
```

**`hf: command not found`** — the CLI isn't on PATH. Reinstall with
`pip install -U huggingface_hub`, or call it as `python -m huggingface_hub.commands.huggingface_cli`.

**Rate-limited or slow** — run `hf auth login`, and enable `hf_transfer` (section 1).

**PowerShell blocks the script** — run once in that session:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

---

## 9. Adding a repo / 新增仓库

Add one line to `scripts/manifest.tsv` — **columns separated by a real tab**:

```
dataset	Jingyi-Z/new-dataset-name
model	Jingyi-Z/new-model-name
```

Both scripts pick it up automatically. Nothing else to edit.
两个脚本都会自动读到，不用改别的地方。
