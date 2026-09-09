# Desktop settings navigation: September 9, 2026

## Measured change

Settings section changes now use a React transition: the current page remains
visible while a previously unopened page's code loads. The page region reports
`aria-busy` during that wait. Search destination and highlight state commit together,
so the reveal attempt starts after the requested destination is ready. Resource
loading remains visit-gated and hook ownership is unchanged, preserving drafts.

This does not eagerly load every settings page, change save behavior, add help to
main pages, or alter the app-level Settings navigation path.

## Evidence

The production-browser runner used Chromium 145.0.7632.6 on Linux 7.1.11, Intel
i7-8700 / 12 logical CPUs, device alias `lab-linux`. Each build had one unmeasured
warm-up and 30 fresh browser contexts per fixture (0, 1,000, 10,000 mixed-status
synthetic tasks). External requests were blocked; no personal profile or database
was opened. The host was not a dedicated lab machine. No builds or tests ran during
the timed batches.

Median first-open Integrations automation latency:

| Fixture | Control | Transition | Reduction |
| --- | ---: | ---: | ---: |
| 0 tasks | 412.0 ms | 157.6 ms | 61.7% |
| 1,000 tasks | 411.7 ms | 154.8 ms | 62.4% |
| 10,000 tasks | 406.0 ms | 151.9 ms | 62.6% |

Both batches had 90/90 valid samples. All three comparisons passed the existing
median regression checks across startup, canonical loading, navigation, capture,
persistence, scrolling and settings. At 1k/10k the virtual list remained bounded
and changed its visible window after scrolling. These end-to-end measurements
include automation overhead; the reduction is not an app-only CPU measurement.
Thirty samples do not establish a reliable p95 gate.

Separate diagnostic runs retained 18 CPU profiles (three repetitions, two fixture
sizes, three navigation stages). Slow Settings/Integrations profiles contained
roughly 270–350 ms of idle samples; the settings search index accounted for only a
small amount of sampled work. That evidence led to testing the lazy-page reveal
path, not broad memoization. React documents both its
[Suspense reveal timing and transitions that preserve visible content](https://react.dev/reference/react/Suspense#preventing-already-revealed-content-from-hiding).
The successful transition experiment supports that diagnosis; sampling does not
attribute native I/O or prove all idle time has a single cause.

## Regression coverage

- A component regression first failed because the current General page became
  hidden during a suspended Integrations load. It passes with the transition,
  verifies `aria-busy`, and confirms the destination replaces General after loading.
- Existing Settings tests continue to cover visit-gated resource activation,
  integration state retention, initial destinations, AI activation and onboarding.
- The production-browser UI check holds the real Integrations chunk request,
  verifies that Appearance remains visible while pending, releases it, and verifies
  Calendar appears with `aria-busy=false`. All four combinations of 800/1280 px and
  light/dark passed, along with existing search, keyboard navigation, highlight,
  no-overflow and no-main-page-help checks. Screenshots were retained and inspected.
- Release diagnostics reuse the page layout-effect line with
  `v1.3.0/settings-page-transition`; this proves a committed settings destination,
  not completion of its asynchronous configuration reads.
- Full desktop suite: 257 files / 2,726 tests passed. Desktop typecheck, scoped
  ESLint, the design detector, two diagnostic-field checks, and all 49 performance
  tooling tests passed. The production build succeeded with existing bundle-size
  and mixed-import warnings. Review was local, not an independent agent review.

## Reproduction and retained artifacts

Commands are in [Performance baselines](baselines.md). Local artifacts:
`/home/dd/.cache/mindwtr-performance-tmp/capture-window-experiment/`.

- `desktop-control`: unprofiled baseline, built artifact SHA-256
  `8074c64e1be0722e29e9e84a227a49ead377a8f2981139f1f961bb7006d253a9`.
- `desktop-transition`: unprofiled candidate, built artifact SHA-256
  `f44a2bfd49d28aadc669e23f0c6929fac357141cd020c61c6b1ea33e58c45830`.
- `desktop-cpu-control`: separate diagnostic profiles, never used as timing baselines.
- `desktop-control-dist`: the matching diagnostic build/source maps.
- `desktop-transition-ui`: narrow/wide, light/dark search and loading screenshots.

Reports contain raw samples, fixture IDs, source revision/dirty state and exact
artifact hashes. Source changes were uncommitted while measured; the artifact hash
identifies the build. Profiles and bundles remain local, not in git.

## Follow-up: first-open General Settings

A fresh baseline at `3ed9004a5` reproduced the remaining delay. Co-loading General
with the already-lazy Settings route alone did **not** reliably improve it: medians
were 440/394/148 ms versus 400/430/156 ms at 0/1k/10k tasks. The app-level Settings
navigation still bypassed the transition used by other routes. A production test
holding the real Settings route chunk failed because the current Focus screen
disappeared during that wait.

The combined change loads General with Settings and uses the existing route
transition for Settings too. Other settings pages stay lazy, resource activation
and hook ownership stay unchanged, and no data writes or user-facing controls are
added. The Settings route grows about 13 KB minified (3 KB gzip); the initial main
bundle does not grow. This follows React's documented
[lazy loading](https://react.dev/reference/react/lazy) and
[preserving visible content during suspension](https://react.dev/reference/react/Suspense#preventing-already-revealed-content-from-hiding).

First ordered A/B pass, 30 fresh contexts per fixture:

| Synthetic tasks | Control General | Combined General |
| --- | ---: | ---: |
| 0 | 400.2 ms | 137.5 ms |
| 1,000 | 429.5 ms | 149.1 ms |
| 10,000 | 156.3 ms | 146.7 ms |

All 180 samples were valid. The 0/1k median comparison gates passed. The first
10k comparison flagged Integrations at 175.0 versus 152.0 ms (23 ms slower).
Repeating 30 runs of the exact candidate, then 30 of the exact control, produced
150.6 versus 152.2 ms; that comparison passed all unchanged median gates. All 60
repeat samples were valid. The initial flagged batch remains in the evidence;
it was not reproduced, not silently discarded or fixed by weakening a threshold.
The co-load-only experiment is retained separately, not counted as a successful fix.
Across both 10k batches per build (60 observations each), General medians were
151.5/147.2 ms and Integrations medians were 152.2/164.2 ms (control/candidate).
There is no claimed median speedup at 10k or for Integrations; the strong General
median reduction is in the empty/1k fixtures. Sixty samples still do not establish
a p95 release gate.

Regression coverage includes a test that fails if General suspends after the
Settings route loads, plus production checks holding the actual route and
Integrations chunks. They assert current content remains visible, later navigation
wins over pending Settings, and search, keyboard controls and narrow/wide light/dark
layouts still work. All 257 App/Settings tests passed; desktop typecheck/build,
scoped ESLint and diagnostic-field checks passed. No independent agent review was
run. General's layout diagnostic is tagged `v1.3.0/settings-default-coload`.

Artifacts for this follow-up are under
`/home/dd/.cache/mindwtr-performance-tmp/settings-first-open/`: `control`,
`candidate` (co-load only), `transition`, matching saved bundles and route regression
screenshots. Reports retain artifact hashes and raw samples; timings include
automation overhead. The same limitations and host conditions above apply.
The saved control bundle was replayed for the final repeat without rebuilding;
its artifact hash, not that run's candidate checkout revision, identifies the code.
Control SHA-256: `f44a2bfd49d28aadc669e23f0c6929fac357141cd020c61c6b1ea33e58c45830`.
Combined SHA-256: `d5d54a07d19a4c09272ea2f1315bb538b9f37db9ec23cafb05a3287d722fff41`.

## Still open

These are production desktop React UI measurements, **not native Tauri startup,
WebKit/WebView2 measurements, keyring access, SQLite durability, or macOS/Windows
end-to-end timings**. Native Settings I/O and rendering remain separate checks.
