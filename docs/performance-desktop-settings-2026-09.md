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

Commands are in [Performance baselines](performance-baselines.md). Local artifacts:
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

## Still open

First-open **General Settings** still has a separate, variable lazy-loading delay:
the control medians were 443/451/156 ms and candidate medians 454/441/150 ms at the
three fixture sizes. This change does not fix that initial route/page waterfall.
Investigate co-loading the small default page with Settings before changing the
app-level navigation behavior, which already has prior latency fixes.

These are production desktop React UI measurements, **not native Tauri startup,
WebKit/WebView2 measurements, keyring access, SQLite durability, or macOS/Windows
end-to-end timings**. Native Settings I/O and rendering remain separate checks.
