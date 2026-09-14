> **Superseded on the visualizer side (2026-09-14).** Jingyi's main of
> 2026-09-12 ships her own high-rate raw sidecar reader, for her recorder's
> format: one session-long CSV per robot session, header
> `t_epoch_ns,e0_x,e0_y,e0_z,…,e11_x,e11_y,e11_z` (37 columns, the 12 hall
> elements × 3 axes in relative counts, one row per poll at 0.3–1.2 kHz), a
> `baseline.csv` (12 rows `element,x,y,z`, session-start means) and a
> `session.json` with `started_epoch_ns`, under
> `board_raw/<sensor>/session_<stamp>/slotNN_raw.csv` (or
> `live_raw/<name>/session_<stamp>/raw.csv`); the viewer picks an episode's
> rows by the time window of its per-episode 91 Hz CSV. A recorder meant to
> show in her panel writes that layout. The format below stays as our record
> of what a fuller capture (resultant, array, temperatures, change bitmask)
> would carry; the validator still checks it.

# Raw tactile sidecar — format `paxini-raw/1`

Status: proposal, 2026-09-09. Written for Jingyi's request on PR #2 ("the
0x7C live sensor block recorded as a raw sidecar next to the current 91 Hz
logger stream and readable in the raw stream panel ... one row per block
change, not on a fixed poll") and for Zheng's own recorder, which logs every
readable region on the sensor's clock. One format, two writers, one reader.
The validator is `scripts/validate_raw_sidecar.py`; `--example` writes a
conforming synthetic episode for reader development.

## 1. What the current sidecar is, and what this one is

The sotac sidecar (`sensors/paxini_fingertip/episode_XXXXXX/sensor_N.csv`)
is the board's push stream copied at the logger's 90.88 Hz timer: 163
columns, force values already converted to newtons (resultant in 0.1 N
steps, array points in 0.2 N steps), and on sotac ep23 88 % of consecutive
rows repeat the previous taxel block because the sensor refreshes every
~13 ms and the logger asks every 11 ms. Its four clock columns carry one
value: `calibrated_timestamp_ns` equals `timestamp_ns` on every row,
`time_calibration_offset_ns` and `frame_status` are 0. The episode's
`alignment.json` records the epoch instant of main-table frame 0.

This format keeps what works — the folder layout under `sensors/`, epoch
nanosecond timestamps from `time.time_ns()`, `alignment.json` untouched,
one CSV per module, a header row the existing readers already parse — and
changes three things:

1. **a row is written only when a block changed** (arrival driven), so the
   time axis is the sensor's own refresh, not the logger's timer;
2. **every readable region can be logged as paired columns** of the same
   row: resultant, array, the 0x7C Hall block, per-element temperature,
   block 10000; a file carries the regions its recorder logged;
3. **values are raw device counts**, with the scales and the unit's
   identity in a `meta.json` beside the CSVs, so a file says which physical
   sensor and firmware produced it.

## 2. Placement

```
sensors/<recorder>/episode_XXXXXX/
    sensor_<k>.csv        one per module, k = 1.. in slot order
    meta.json             identity, regions, scales, refresh statistics
    alignment.json        unchanged: {"episode_start_timestamp_ns": ..., "clock": "time.time_ns (epoch)", ...}
```

`<recorder>` names the writer and therefore the axis:

| folder | writer | rows |
|---|---|---|
| `paxini_fingertip` | the existing push-stream logger (sotac today) | logger timer, duplicates, newtons — unchanged, legacy |
| `paxini_hall` | a Hall-block logger running beside that stream (Jingyi's wording) | one row per 0x7C block change; regions: `hall` only |
| `paxini_raw` | an arrival-driven recorder (Zheng's) | one row per change of any logged region; regions as logged |

A dataset may carry more than one folder for the same episode. Readers list
`sensors/*/episode_XXXXXX/*.csv` and name a stream `<recorder>/<file>`.

## 3. Rows and columns

Header row first, no comment lines (the existing parsers read line 0 as the
header). Column order is fixed. Every row is one sensor refresh.

| column | type | meaning |
|---|---|---|
| `timestamp_ns` | int | `time.time_ns()` at the read that first returned the new content |
| `calibrated_timestamp_ns` | int | equal to `timestamp_ns`; kept because the existing readers key on it |
| `seq` | int | row counter from 0, no gaps |
| `changed` | int | bitmask of the regions whose bytes differ from the previous row: 1 resultant, 2 array, 4 hall, 8 temperature, 16 block10000. Never 0 |
| `fx`, `fy`, `fz` | int | region **resultant**: as the sensor sends them (fx, fy signed, fz unsigned) |
| `p_00_fx` … `p_<N-1>_fz` | int | region **array**: N points × (fx, fy, fz), N = 25 (IP) or 52 (DP) |
| `h_00_x` … `h_11_z` | int | region **hall**: area 0x7C, 12 elements × (x, y, z), int16 counts; the three pad slots per element are not written |
| `t_00` … `t_11` | int | region **temperature**: 12 per-element counts (uint16) |
| `blk_00` … `blk_26` | int | region **block10000**: the 27 raw bytes |

A file contains complete groups only. A `paxini_hall` file has the four
leading columns and the 36 Hall columns; a `paxini_raw` file has whichever
groups its recorder logged, always in the order above. Values in `paxini_raw`
and `paxini_hall` files are raw counts; the legacy `paxini_fingertip` files
stay in newtons and have no `meta.json`, which is how a reader tells them
apart.

## 4. The change rule

For each logged region the recorder keeps the bytes of the last read. A
poll cycle reads every logged region of a module back to back (hall,
array, resultant, temperature, block 10000), each in one transaction. If
any region's bytes differ from the kept copy, one row is written with the
current values of all regions and `changed` set to the regions that
differed; the kept copies are updated. If nothing differed, nothing is
written.

Poll period: at most 4 ms per module. The sensor publishes every 12.5 to
13.0 ms (77 to 80 Hz measured on the lab's units; the manual says 83.3 Hz),
and polling faster returns byte-identical frames, so a 4 ms poll sees every
refresh and adds at most 4 ms of latency. Over the high-speed board the
passthrough sustains about 1800 reads per second per bus; five regions on
two modules at 4 ms need 2500 reads per second, so a two-module recorder
logging everything polls at 6 to 8 ms, or drops temperature to every fourth
cycle. `meta.json` states the period used.

Torn reads — a region whose bytes were read while the sensor was mid-refresh
— appear as two rows a fraction of a millisecond apart. The validator's
refresh-interval histogram makes them visible; a recorder may re-read a
region once when it sees a change to confirm it.

Rows are clipped to the episode: from the instant in `alignment.json` to the
last main-table frame plus one frame period, like the legacy files.

## 5. `meta.json`

```json
{
  "schema": "paxini-raw-meta/1",
  "recorder": { "name": "…", "version": "…", "transport": "board", "poll_period_ms": 4 },
  "clock": "time.time_ns (epoch)",
  "modules": [
    {
      "file": "sensor_1.csv",
      "slot": 10,
      "model": "DP-S2015",
      "points": 52,
      "firmware": "TOUCHSEN_G012GM_AL1.0.5_FW1.0.5_…",
      "element_ids": ["7d48858c…", "…12 entries…"],
      "regions": ["resultant", "array", "hall", "temperature"],
      "units": "counts",
      "scales": {
        "resultant_lsb_n": 0.1,
        "array_lsb_n": 0.2,
        "hall": "uncalibrated counts, absolute level wanders between runs",
        "temperature": "0.06 degC per count as a slope, no zero"
      },
      "refresh_ms": { "median": 13.0, "p5": 12.4, "p95": 13.6 },
      "rows": 1103,
      "polls": 3520
    }
  ]
}
```

`element_ids` are the per-element hardware identifiers from area 0x7C
address 10000 — the only identity of a module over the board, since the
serial number lives in an area the board does not serve. `firmware` is the
build string from area 0x7B address 6020; `FW1.0.6` units have no 0x7C, so a
file from such a unit can never carry the `hall` group.

Scales are the recorder's statement of what it measured, not a promise: the
vendor manual says 0.1 N per LSB for the resultant; the sotac sidecars show
0.2 N steps on the array points. Both are uncalibrated against a reference
instrument. Readers convert with the file's own scales; the annotator's
thresholds were calibrated in newtons on the legacy stream, and re-running
them on a `paxini_raw` file is a calibration check, not a given.

## 6. Reader rules

- Discover by folder; never assume one folder per dataset.
- Key column groups by prefix (`p_`, `h_`, `t_`, `blk_`), not by position.
- No `meta.json` → legacy newtons; `meta.json` present → counts, apply
  `scales`.
- Ignore unknown columns; a future `paxini-raw/2` may add groups.
- Time axis: `timestamp_ns` minus `alignment.json`'s
  `episode_start_timestamp_ns`.

## 7. Validation

```
python scripts/validate_raw_sidecar.py sensors/paxini_raw/episode_000000      # a folder: CSVs + meta
python scripts/validate_raw_sidecar.py some/sensor_1.csv                     # one file
python scripts/validate_raw_sidecar.py --legacy data/sotac/sensors/paxini_fingertip/episode_000023/sensor_1.csv
python scripts/validate_raw_sidecar.py --example out/episode_000000          # write a conforming synthetic episode
```

Checks: header vocabulary and group completeness, monotonic `timestamp_ns`,
`seq` without gaps, `changed` non-zero and consistent with the row-to-row
byte comparison, no consecutive duplicate rows, refresh-interval statistics
per region, `meta.json` present and consistent with the file. `--legacy`
reports the duplicate rate and spacing of an existing stream file.

## 8. Open, to be measured on the bench before this is frozen

1. Whether passthrough reads can interleave with the board's push stream, which
   decides whether a `paxini_hall` logger can run inside a stream-based
   recorder or the recorder must poll everything (`paxini_raw`).
2. The resultant and array LSB scales on the board path versus the sensor's
   own protocol (the 0.1 N versus 0.2 N question).
3. The block-10000 layout on a DP unit (decoded on IP only so far).
4. The firmware of the sotac gripper's fingertips: no `hall` group is possible
   on FW1.0.6.
