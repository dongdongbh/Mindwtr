# Release confirmation notices

The stable release workflow calls `notify-release-confirmations.yml` after successful GitHub publication. GitHub publication is not proof that an update has reached a reporter: Apple review, staged rollouts, and downstream packaging proceed separately. The comment identifies the version containing a change and asks for retesting only once that version or newer is installed. It does not promise availability through every channel.

The release caller starts in preview mode (`dry_run: true`). Enable posting only after reviewing the dry-run summary and selected issues. The manual workflow defaults to preview even when the release caller enables posting.

## Selection

The notifier reads the published release body, never unreleased notes on main. It intersects local issue references with open, unlocked issues labelled `status:needs-confirmation`, excluding pull requests. Drafts, prereleases, component tags, and releases without assets are refused. Use bare issue numbers, inline GitHub links, or the explicit list for shipped changes. Reference-style Markdown links and their definitions are skipped to avoid interpreting link labels as local issue numbers; omitted issues are skipped.

An optional explicit list overrides ordinary references. An empty list disables notifications for that release:

```html
<!-- mindwtr-confirmation-issues: 1460, 1475 -->
```

Use the explicit list when notes also discuss deferred or unrelated issues. The release notes are a maintainer-approved description of shipped work, not proof of a resolved bug.

## Duplicate protection

Each comment contains a version-and-issue marker. Every existing comment page is checked for a matching marker authored by `github-actions[bot]`. Manual and automatic invocations share a concurrency group. State and label are rechecked immediately before posting. A later release only produces another notice if its notes reference the issue again.

Comment creation is not automatically retried after failure or timeout. Rerun the notifier after checking the outcome; a recorded marker suppresses a duplicate. This is best-effort deduplication, not transactional exactly-once delivery. The notifier never changes labels, closes an issue, forces mentions, or sends periodic reminders.

## Preview and retry

Run the dedicated workflow on main instead of rerunning the immutable release publisher:

```sh
gh workflow run notify-release-confirmations.yml --ref main -f release_tag=v1.3.8 -f dry_run=true
```

Review its log and job summary before using `dry_run=false`. A preview prints proposed comments and the selection counts but posts nothing. At most 50 candidates are allowed per invocation; exceeding the cap fails before posting. Narrow the explicit release-note list if necessary.

Historical backfills need deliberate review: an old release may mention an issue now awaiting a different fix. Never bulk-post a historical preview just because its selectors matched. No fixed delay or channel polling is used; a store-wide release still does not prove that a staged update reached a particular installation.

## Workflow contract

Only the notifier job receives `issues: write`; checkout disables persisted credentials. The stable publisher calls the reusable workflow directly because a release created using `GITHUB_TOKEN` does not trigger another release-event workflow. See [GitHub token event behavior](https://docs.github.com/en/actions/concepts/security/github_token).

Changes must pass `node --test scripts/ci/notify-release-confirmations.test.mjs` and actionlint for both workflows. The tests also run through the existing governance suite, which includes `scripts/ci`. No app diagnostic line is needed: the Actions log and summary record planned and posted counts without task data or credentials.
