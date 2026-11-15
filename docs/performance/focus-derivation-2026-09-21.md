# Focus derivation: where the time went, and what was removed

Date: 2026-09-21. Branch `perf/focus-derivation`, from `main` at `627223ed6`.
Only `packages/core` changed. No screen, no storage, no sync code was touched.

## Why we looked

Opening the Focus screen runs four functions in the shared core, in this order:

1. `isTaskActionable`, used as a filter over every task in the store,
2. `buildFocusPools`,
3. `deriveFocusTaskLists`,
4. `buildFocusTaskSections`.

On a phone holding 5,000 tasks those four calls took about 203 ms (median),
measured inside the shipping app's JavaScript engine, before any drawing.
The project's goal for opening Focus is 50 ms. The same four calls took about
12.8 ms on the workstation. The gap is the engine: the phone runs Hermes, which
interprets JavaScript, while the workstation engine compiles it as it runs
(a "JIT", short for just-in-time compiler). Work a JIT makes nearly free —
small helper calls, parsing a date string, allocating an object — stays
expensive on an interpreter.

Evidence for the 203 ms: `docs/adr/0029-native-clients-host-the-typescript-core.md`
and `/home/dd/worktrees/Mindwtr/rn-baseline/experiments/rn-baseline/REPORT.md`.

## How we measured

Two engines, both on the workstation:

- **Bun**, which has a JIT. Used for CPU profiles and call counts.
- **QuickJS-ng 0.16.2**, which has no JIT. Used as a stand-in for the phone's
  Hermes. Its absolute numbers are not the phone's — it ran the old code in
  83 ms where the phone took 203 ms — but the *ratio* between old and new is
  what it is for.

Both benchmarks run the old code and the new code **alternately** in one
process (old, new, old, new, …), 20 warm-up rounds then 200–300 samples each.
Another worker was running Gradle builds on this machine throughout, and a
plain before-then-after measurement drifted by up to 2.4x between runs. The
alternating layout makes that drift fall on both sides equally.

The data is the 5,000-task generated store the performance budgets already use
(`packages/core/src/performance-large-store.test.ts`). It has no random
numbers: every field is decided by the task's position in the list.

## What was slow

A CPU profile of the old code put **55% of all time in parsing date strings and
building `Date` objects**. Counting the calls showed why:

| | calls per single derivation |
| --- | ---: |
| `safeParseDate` | 39,820 |
| distinct date strings in the whole store | 18 |

That is 755 parses of the *same* text per derivation. Three causes:

1. **Dates parsed inside a sort comparator.** `deriveFocusTaskLists` sorted the
   Today and Review Due lists with a comparator that called `safeParseDate` on
   `createdAt`, and parsed the due and start strings again, on *every one* of
   the roughly 3,900 comparisons. That alone was 24,349 of the 39,820 parses.
2. **Today's boundaries rebuilt per task.** `isTodayScheduleCandidate` built two
   `Date` objects for "start of today" and "end of today" on every task it was
   asked about — about 6,200 objects per derivation, all identical.
3. **Values looked up inside a comparator.** `sortFocusNextActions` did two
   `Map` lookups and two priority-table lookups per comparison, about 30,000
   comparisons' worth, for values that do not change during a sort.

The no-JIT engine showed a fourth cause the JIT had been hiding entirely.
`buildFocusPools` narrows four task pools, and each one goes through
`applyFilter`. With no saved filter chosen — the state the Focus screen is in
until the user picks one — `applyFilter` still ran about twenty checks against
every task, and every check passed. Under QuickJS those four passes cost 44 ms
of the derivation's 119 ms. Under Bun the same work cost under 2 ms, which is
why the first profile did not show it.

## What changed

Four edits. None of them changes what Focus returns.

1. **`deriveFocusTaskLists`: read the sort values once per task.**
   The comparator now compares three numbers that were computed once for each
   task, instead of parsing text on each comparison. This is the same fix, and
   the same helper (`sortByPrecomputedKey`), that issue #766 already applied to
   the other Focus sort. The comparison itself is unchanged and the sort is
   still stable, so the resulting order is identical.
2. **`isTodayScheduleCandidate`: accept the day's boundaries.**
   The function takes an optional third argument holding the two `Date` objects
   it used to build itself. `deriveFocusTaskLists` builds them once and passes
   them to every task. Called with two arguments it behaves exactly as before.
   It also compares timestamps as numbers rather than comparing `Date` objects,
   which is the same comparison without the conversion step.
3. **`sortFocusNextActions`: move the lookups into the key.**
   The project-deadline boost and the priority rank are now read once per task
   and stored beside the other precomputed values.
4. **`applyFilter`: skip the checks when there is nothing to check.**
   With no criteria, only one rule is left — a deleted task is never returned —
   so that rule runs on its own. `normalizeFilterCriteria` only ever writes a
   key it means, so "no keys" is exactly "no criteria". A criterion added there
   later appears as a key and takes the full path, which is the safe direction.
   Only three callers go through `applyFilter`: the Focus pools and the two
   mobile widget payload builders (`widget-data.ts`, `widget-lists.ts`). The
   filtered lists in both apps call `createTaskFilterPredicate`, which this
   patch does not change, so they are not faster.

After the change the same derivation makes 23,117 `safeParseDate` calls instead
of 39,820, and the remaining ones are one per task per pass.

## Results

Five thousand tasks, old and new alternating in one process.

| | old | new | change |
| --- | ---: | ---: | ---: |
| Bun, first derivation (median) | 12.46 ms | 5.41 ms | −56.6% |
| Bun, first derivation (fastest sample) | 9.59 ms | 3.95 ms | −58.8% |
| Bun, recompute after one edit (median) | 10.08 ms | 4.36 ms | −56.7% |
| QuickJS-ng, first derivation (median) | 83 ms | 36 ms | −56.6% |
| QuickJS-ng, recompute after one edit (median) | 84 ms | 36 ms | −57.1% |

"Recompute after one edit" rebuilds the task list with one task completed and
one task edited, then derives again. Nothing here is cached, so both columns
are real computation.

The two engines agree on about −57%. If the phone follows the same ratio, the
203 ms should land near 90 ms. **That is a prediction, not a measurement.**
The phone was owned by another worker during this work; the re-measurement
steps are in the task result.

## What is still expensive, and why we stopped

Remaining cost under the no-JIT engine, out of about 43 ms:

| | ms |
| --- | ---: |
| `sortFocusNextActions` | 18 |
| `buildFocusPools`, four passes over 4,197 tasks | 10 |
| the Today filter | 4 |
| everything else | ~11 |

`sortFocusNextActions` sorts about 2,800 tasks and its comparator already reads
only precomputed numbers. We checked whether the text comparison used to break
ties was the cost: sorting the same tasks with every `createdAt` made distinct,
so ties almost never reach the text comparison, took 2.08 ms against 2.52 ms —
a 17% difference. So the cost is the sort itself, not the tie-break.

Going further would need one of these, all of which the task ruled out:

- **Semantic change.** Sort only the rows the screen shows first. Focus renders
  the whole list, so this changes what the user sees.
- **Semantic change.** Replace the text tie-break with a plain string
  comparison. Cheaper, but it reorders non-English titles.
- **Persistent cache.** Keep the derived lists between derivations and update
  them when a task changes. This is the only remaining large win and it is a
  design change, not a tuning change.
- **Signature change.** Pass parsed dates through the pool builders so each date
  is parsed once for the whole derivation instead of once per pass. Worth about
  10 ms of the no-JIT 43 ms.

## Proof that behaviour did not change

`packages/core/src/focus-derivation-parity.test.ts` runs the old code and the
new code side by side and compares everything they return: which tasks are in
each pool and each section, the order they are in, the whole task object of
each one, the project-deadline boost map, and the set of blocked sequential
steps. The old code is a frozen copy in
`packages/core/src/__fixtures__/focus-derivation-frozen.ts`, so a later edit to
the copied functions cannot move the reference too. The copy still imports ten
live helpers (for example `safeParseDate`, `shouldShowTaskForStart` and
`sortTasksBySavedPreference`), so an edit to one of those moves both sides.
Delete the frozen copy and the comparison half of the test after one shipped
release; keep the `applyFilter` short-cut cases.

It runs over the generated 5,000-task store and a hand-written store of the
awkward cases: date-only and timed due and start values, the local day
boundary, overdue, future starts, review dates, starred tasks with and without
a manual order, sequential projects in both scopes, deferred and archived
projects, every status, tombstones, exact ties, and titles in Chinese, Russian,
Arabic, accented Latin, mixed case and numbers. It repeats all of that in three
timezones (UTC, America/New_York, Asia/Kolkata), at four reference times
including the US spring-forward morning, for every sort option the Focus screen
offers, with the priorities feature on and off. 192 cases.

We checked the test can fail: deliberately dropping the priority tie-break from
the new code made 20 of its cases fail.

## Section contract correction (2026-11-14)

The prepared change for #1557 and #1092 restores Review Due between Today
(schedule) and Next Actions, keeping Today's Focus first. This intentionally
supersedes the later #1281 decision to put Next Actions before review reminders.
The frozen section builder has the same explicit order amendment; its task derivation and the strict parity comparison
remain unchanged. Core, desktop, RN, and native-host tests pin the corrected
section order independently.

## Budget

The budget suite already had a "Focus derivation" row, but it measured only the
Next-actions sort. A new row, **Focus screen derivation**, measures all four
calls in screen order. Measured on this workstation under load: 3.39 ms at
1,000 tasks, 14.87 ms at 10,000, 102.81 ms at 50,000. Budgets are 40 ms,
200 ms and 1,200 ms — about 10x headroom, in line with the other rows.

## Limits

- Everything here is workstation CPU time. No phone, no drawing, no storage,
  no network.
- QuickJS-ng is not Hermes. It is used for ratios only.
- The generated store gives every task the same `createdAt`, which makes sort
  ties more common than in a real store. The measurement above shows that
  changes the Next-actions sort by about 17%.
- The machine was under other load throughout. That is why every comparison
  alternates old and new inside one process.

## On the phone (added by the maintainer's session, 2026-09-22)

Measured in the baseline app of ADR 0029 on the same phone (OnePlus CPH2655,
Hermes, release build, 5,000 tasks, 200 samples): unpatched build, then the same
app rebuilt with the three patched core files. Focus derivation p50 207.05 ms →
113.99 ms (p95 213.00 → 115.87). The Inbox control was unchanged (2.58 → 2.57
ms). Focus took about 45 percent less time in these recorded before and after
runs; device-state sensitivity limits how precisely that percentage
generalizes. The unpatched run cost about 116 ms for its first 30 samples and
about 207 ms afterwards, and the patched run stayed near 114 ms throughout, so
the phone runs alone do not isolate how much of the difference is the patch and
how much is the state each run happened to be in; a short Inbox operation need
not react to device state the way a long Focus computation does. The evidence
that the patch itself is the cause is the removed work (39,820 date parses down
to 23,117, four empty filter passes gone) and the interleaved workstation runs
on two engines. The dataset is the 5,000-row generated store, of which 4,398
tasks are visible (the rest are deleted or purged rows the fixture includes on
purpose). The patched cost in the first seconds after a launch was not
measured. An independent review found no behavior difference, verified the
frozen reference against `main`, and caught all seven of its own mutations with
the parity test.
