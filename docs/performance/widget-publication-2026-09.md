# Widget publication derivation — September 12, 2026

Accepted: one changed iOS publication now selects and orders widget tasks once,
instead of six times. Family payloads remain byte-identical to the pre-change
implementation. This is a deterministic work reduction, not a measured iPhone
latency or WidgetKit rendering improvement.

## Source and scenario

Control: `43f40c2ea`, before this review loop. Candidate: the Plan 084 implementation
in this commit. Host: Linux, Bun 1.3.3, repository dependencies; generated data only.
No native widget or account was used. Native writes are mocked in publication
tests; task derivation remains real.

`widget-service.ts` previously called the complete `buildWidgetPayload` for a
50-row fingerprint, then again for the five iOS family payloads. Each repeated
Focus derivation and saved-filter selection. The existing widget-data module now
owns an invocation-local projection: selection and ordering happen once, then
each cap shapes its own rows, sections and hidden-count subtitle. The item cache
lives only within that invocation; there is no cross-publication data cache.

## Evidence

| Scenario | Before | After |
|---|---:|---:|
| Changed iOS publication: full selection passes | 6 | 1 |
| Changed iOS publication: family writes | 5 | 5 |
| Unchanged input: native writes | 0 | 0 |

The real-publication regression first failed with exactly 6 calls to the real
`resolveAreaFilterSelection`, then passed with 1. Focused widget tests passed 60/60,
including five-family output/cap/hidden-count checks, independent Shortcuts
updates, failed publication and retry, and language/day/Focus-filter invalidation.
Mobile typecheck and lint passed; lint reported only pre-existing unowned warnings.

An independent differential probe imported the old widget-data implementation
from a detached control worktree and compared it with both new single-payload
and batch-projection outputs. All 448 JSON-string comparisons passed:

- 65 and 5,000 generated mixed-status tasks; active/archived projects, deleted
  tasks, dates, contexts, tags, priorities and 10 saved filters.
- English, German, Spanish and French; light/dark system themes; unfiltered
  and work-context/title-sorted Focus selections.
- Default, zero, 3, 5, 12, 24 and 50 item-cap inputs.
- Frozen clock: `2026-09-12T16:00:00.000Z`.

Fixture SHA-256 values:

```text
65:   74152ed6be9c655ea5b01f9178819bd70794d7872d2108c6661bbd4a6484fdc2
5000: 1810f295e3f3a56eee119c4b6c2cca6029a98566cbe6952d97441e2d6ca5dd04
```

The first harness attempt loaded only the leader checkout's locale cache while
the candidate had an isolated core module. It correctly reported translated-text
differences. Loading both actual locale caches removed this harness mismatch;
no production code changed for that rerun. This comparison covers loaded locales,
not asynchronous first-load translation behavior.

The local probe and fixture generator are retained under
`.orchestrator/tasks/review-loop-20260912/widget-compatibility.ts`; the detached
control is `/home/dd/worktrees/Mindwtr/widget-control-20260912`. Run the probe with
`bun .orchestrator/tasks/review-loop-20260912/widget-compatibility.ts` from the
integrated checkout, with the control worktree/dependencies present. These are
local review artifacts, not installed app assets. Persistent regressions live in
`apps/mobile/lib/widget-data.test.ts` and `widget-service.test.ts`.

## Limits and next check

Preliminary audit host timings were reconnaissance; raw timing samples were not
retained, so they are not acceptance evidence. No new timing batch was run while
other tests/builds were active. No frame or latency threshold changed.

Android still uses its existing publication adapter. Shortcuts retains its own
snapshot and invalidation gate. The `v1.3.0/widget-batch-derivation` diagnostic
proves five successful JavaScript family writes, not an OS-rendered widget.

Next bounded check: matching iOS release builds on one authorized device with
synthetic data, identical widget families, and interleaved CPU/publication samples.
Keep WidgetKit refresh scheduling separate from JavaScript derivation timing.
