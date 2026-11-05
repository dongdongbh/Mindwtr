# Native Android reminder plan cost, 2026-10-29

Follow-up to [native Android startup and interactions](native-android-startup-2026-10-26.md) (H3c). Raw files:
`/home/dd/scratch/logs/perf-reminders-20261028-20/` (per-run folders `hot-*`, summaries `rem-bench.out` and `rem-dated20.out`).

## What changed

`planReminderAlarms` is shared by RN, iOS and Android. Two pure changes trim it:

- **T1** (`5113c9c23`): the task and project lookup maps are built only when the plan judges a held or delivered alarm.
- **T2a** (`a0bcbc324`): a task with no `dueDate`, `startTime` or `reviewAt` is skipped before the per-task work. Such a task has no
  reminder and adds to no count.

Output stays byte-identical. The frozen corpus (`reminder-plan-corpus.test.ts`, `3f20db78c` and `67d2281cf`) was recorded before either
change. It covers a 5,000-task store across midnight and both DST changes, every settings case, held alarms, the native contract plan, and
5,000-task stores with no, 20% and all tasks dated.

## Setup

- Galaxy S23 `RFCW10JBP0Y`, Benchmark build, portrait locked. Builds: `rbase` = `fc0f501f5` (parent), `rt1` = T1, `rt2` = T1 + T2a
  (measured before the rebase onto `48e5cddaf`; the planner code is unchanged by it).
- Fixtures: `bench` = core's 5k fixture (`large-5000-newest.db`, no task dated); `dated20` = the same size with 1,059 of 5,000 tasks dated.
- Hot returns after 65 s idle, one Perfetto trace each. Per fixture, two batches: builds in order ABC, then CBA, 3 returns per build per
  batch, so n = 6 per cell. 1-minute load 0.1 to 2.9 across the four batches.
- `core:remindersCycle` is the reminder plan run on core's thread after a return. "First frame" is the hot start to its first frame;
  "settled" is the last app frame before a 250 ms pause (`hot-analyze.mjs`). No run contained a tap, so first tap has no value.

## Results

Median [min to max], n = 6 per cell. All 36 traces are usable and each holds exactly one cycle.

| Fixture | Build | `remindersCycle` ms | vs rbase | First frame ms | Settled ms |
| --- | --- | ---: | ---: | ---: | ---: |
| bench | rbase | 34.3 [29.4–35.9] | | 77.5 [73–84] | 87.0 [84–96] |
| bench | rt1 | 28.1 [27.3–29.1] | −6.2 | 75.0 [69–89] | 90.5 [80–102] |
| bench | rt2 | **5.2** [4.0–5.7] | **−29.1 (−85%)** | 76.0 [65–93] | 89.5 [77–114] |
| dated20 | rbase | 67.1 [61.2–72.4] | | 70.0 [65–87] | 90.5 [74–106] |
| dated20 | rt1 | 61.2 [56.2–70.1] | −5.9 | 71.0 [65–78] | 92.5 [88–175] |
| dated20 | rt2 | **43.2** [39.5–46.7] | **−23.9 (−36%)** | 76.5 [64–83] | 92.0 [79–108] |

- The cycle ranges do not overlap between `rbase` and `rt2` on either fixture.
- First frame and settled do not change: the ranges overlap in every cell. The cycle starts 365–447 ms after the return, after the screen
  has settled (at most 175 ms), so it was never on the visible path. The gain is core-thread time freed for a tap that lands in the cycle.
- The `dated20` `rt1` settled maximum of 175 ms is one return with 4 frames instead of 2; the other five are 88–109 ms.

## Limits

One phone, n = 6 per cell, hot returns only. Store size is fixed at 5,000 tasks; the cost of a store with more dated tasks grows toward
the `dated20` row, not the `bench` row.
