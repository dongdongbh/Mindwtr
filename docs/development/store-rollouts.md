# Stable store rollouts

Scheduled stable releases remain biweekly, usually advancing the patch component
by five (for example `1.0.0` to `1.0.5`). Intervening hotfixes use the available
patch numbers; RCs target the upcoming stable (`1.0.5-rc.1`, `1.0.5-rc.2`).
Always keep versions increasing if more hotfixes exhaust that gap.
Rollout promotion does not change the version or rebuild a package.

## Defaults

| Channel | Stable release behavior |
| --- | --- |
| iOS and macOS App Store | Apple phased release, automatic after approval |
| Google Play production | 5%, then scheduled 20% → 50% → 100% |
| Microsoft Store production | 5%, then scheduled 20% → 50% → 100% |
| Play beta/internal | Not touched by stable releases; they keep the native RC ([native Android RCs](native-android-release.md)) |
| RC TestFlight, Play testing, Microsoft Beta flight | Existing beta distribution |
| GitHub downloads and other package channels | Existing distribution, no staging |

Apple progresses automatically through 1%, 2%, 5%, 10%, 20%, 50%, and 100%
over seven days. Anyone can still update manually. Manage pause, resume, or
release-to-all in App Store Connect, independently for iOS and macOS.
See [Apple phased releases](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases)
and [Fastlane's phased_release option](https://docs.fastlane.tools/actions/deliver/#phased_release).

The **Manage Store Rollout** workflow runs daily at 15:17 UTC. For each active
Play and Microsoft production rollout, it discovers the current production
release and advances at most one exact stage: 5% → 20% → 50% → 100%. A delayed
store approval does not make one run skip multiple stages. A new stable release
remains at 5% for at least 24 hours after its GitHub release `published_at`
timestamp; scheduled jobs delivered late on release day skip both stores.
If the newest stable tag has no published GitHub Release yet, scheduled promotion
also waits. A recovering release cannot inherit the preceding release's age.
Completed, non-staged, pending, or halted releases are successful no-ops.

Monitor crash/ANR reports, launch failures, storage/migration and sync errors,
feedback, and reviews while the schedule progresses. Halt promptly for a
critical regression, especially a credible data-loss report. The scheduled
controller never resumes a halted rollout.

## Operate an existing rollout

Use GitHub Actions **Manage Store Rollout** (`rollout.yml`) from `main` for
status checks, overrides, or emergency halts. It uses the existing Store
credentials and uploads no packages. The default manual action is `status`.

- `store=play`: supply the exact production `version_code` from the release
  summary. Actions: `status`, `increase`, `halt`, `resume`, `finalize`.
  `status` is the only action that may omit the exact identifier; it then reports
  the newest production release, which is how the release preflight reads it.
- `store=msstore`: supply the exact production `submission_id` from the Windows
  release summary or Partner Center. Actions: `status`, `increase`, `halt`,
  `finalize`. Microsoft does not support resuming a halted rollout.
- `percentage` is used only by `increase`, must exceed the current percentage,
  and must be below 100. Use `finalize` to complete the rollout.
  Prefer a value the daily schedule knows: 5, 20, or 50. The scheduled run only
  advances from one of those three, so an off-schedule percentage (30%, say)
  makes every later scheduled run for that release fail, every day, until
  someone raises it to the next listed stage or finalizes it by hand. The
  failure is deliberate: the controller never guesses the next stage.

For example, after reviewing health evidence:

```sh
rtk gh workflow run rollout.yml --ref main -f store=play -f action=status -f version_code=150
rtk gh workflow run rollout.yml --ref main -f store=play -f action=increase -f version_code=150 -f percentage=20
rtk gh workflow run rollout.yml --ref main -f store=msstore -f action=increase -f submission_id=SUBMISSION_ID -f percentage=20
rtk gh workflow run rollout.yml --ref main -f store=play -f action=finalize -f version_code=150
rtk gh workflow run rollout.yml --ref main -f store=msstore -f action=finalize -f submission_id=SUBMISSION_ID
```

Replace example identifiers with live verified values. The controllers reject
stale or ambiguous targets and invalid transitions. Mutations are serialized
with publishing. Play's shared lock also covers beta/internal and version-code
lookups because every new edit can invalidate a prior edit for the same account;
see [Google's edit lifecycle](https://developers.google.com/android-publisher/edits).
If a request loses its response, inspect current
status before any retry; a failed workflow can still have changed the store.
Never rerun the build/release workflow merely to increase a rollout.

For a critical regression, prefer the manual `halt` action because its exact
target and result remain in Actions history. Halting directly in Play Console
or Partner Center is also safe: the next scheduled run reads the live halted
state and exits successfully without continuing. Play can later be resumed
manually. Microsoft cannot resume a halted rollout through these API controls;
publish a corrected submission instead.

On Microsoft, even 100% selection is not the same as finalizing: finalization
stops distribution of older packages. A halted rollout cannot be resumed or
finalized through these API controls; submit a new version to continue delivery.
See [Microsoft gradual rollouts](https://learn.microsoft.com/en-us/windows/apps/publish/gradual-package-rollout)
and the [finalization API state requirement](https://learn.microsoft.com/en-us/windows/uwp/monetize/finalize-the-package-rollout-for-an-app-submission).
On Play, halting does not remove an already installed update; see
[Play staged rollouts](https://support.google.com/googleplay/android-developer/answer/6346149).

## Corrective hotfixes

**Precondition: the previous staged production rollout must be closed first.**
Google Play refuses a new staged production release, and the Microsoft Store
refuses a new submission, while the earlier rollout is still open. A rollout
stays open for at least three scheduled days (5% → 20% → 50% → finalize), which
is shorter than the gap between some releases. There are two ways out, both in
[Operate an existing rollout](#operate-an-existing-rollout): `finalize` the open
rollout (everyone gets it) or `halt` it (already updated users keep it; Play can
resume later, Microsoft cannot). Do this on **both** stores before tagging.

The **Store Rollout Preflight** job in `release.yml` reads both stores before
any build starts and fails the release when either rollout is still open, so a
forgotten rollout costs a minute instead of an hour of builds. It runs only for
staged mode in this repository, changes nothing in either store, and names the
open Play versionCode or Microsoft submission in its failure. It reads only the
stores the run actually reaches: a dispatch that re-runs package channels alone
(Scoop/Winget, Flathub, Linux repos, AUR, Chocolatey, or a single desktop build)
is not checked, so recovering one of those never trips over the open rollout of
the release being recovered.

If the same-version Microsoft submission is already accepted, clear
`run_msstore` in a manual `release.yml` dispatch while keeping `run_windows`
enabled to rebuild download assets. This skips production and Beta flight
publication and the Microsoft preflight, preserving the accepted submission.
The flag defaults to true and tag pushes continue publishing normally. Clear
the Apple inputs too when their accepted builds need no changes; keep the tag
input pointed at the validated recovery tag.

Ordinary hotfixes are staged too. For a critical correction, choose
`rollout_mode=immediate` when dispatching `release.yml`, or disable
`phased_release` when dispatching an Apple reusable workflow directly.
Play/Windows standalone workflows accept `rollout_mode` and `rollout_percentage`.
Immediate mode disables staging and releases after the normal store review.

Tag pushes cannot carry dispatch inputs. If an emergency release must be
immediate on the initial tag-triggered run, set repository Actions variable
`RELEASE_ROLLOUT_MODE=immediate` **before** pushing that tag; restore it to
`staged` (or remove it) after the run has resolved its policy. Check the
**Validate store rollout policy** summary. An unset variable means staged.
Do not start a second publishing run while the tag-triggered run is active.
Changing inputs on a later recovery run does not alter an already-published
release; use the rollout controls for that release instead.

## Release evidence

Record each store's approval/distribution state, identifier, rollout percentage,
last health check, and next decision. A green upload job does not establish
store approval or full distribution. Close release follow-through only when
Play and Microsoft are finalized and Apple's phased release is complete,
or explicitly hand off a paused rollout with its reason.

No live store mutations are needed for the local tests. Run:

```sh
rtk python3 scripts/ci/android-play-release-plan.test.py
rtk python3 scripts/ci/google-play-edit.test.py
rtk bun test scripts/ci/msstore-rollout.test.js scripts/ci/validate-store-rollout-workflow.test.js scripts/ci/validate-release-rc-workflow.test.js
```
