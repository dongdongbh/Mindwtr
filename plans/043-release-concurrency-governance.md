# Tag-scoped release workflow concurrency

## Problem

Stable, RC, and reusable platform release workflows perform externally mutating operations such as signing, store uploads, package publication, and GitHub release creation. Several concurrency groups use `github.ref`, which is the dispatching branch during manual recovery even when the requested release tag is supplied separately. Most also set `cancel-in-progress: true`, so retrying a same-tag workflow can terminate an earlier run after only some channels were mutated.

## Evidence

- `.github/workflows/release.yml` groups by `github.ref` and cancels in-progress runs.
- `.github/workflows/release-rc.yml` groups by the effective tag but still cancels in-progress runs.
- Reusable `release-*.yml` platform workflows accept a `tag` input while grouping by `github.ref`; most cancel an in-progress run.
- Tagged releases are immutable under the repository design guardrails, so partial replacement and cancellation are unsafe recovery semantics.

## Desired behavior

- Every stable, RC, and reusable platform release workflow keys concurrency to `${{ inputs.tag || github.ref_name }}`.
- A second same-tag run queues behind the first; it never cancels an externally mutating release in progress.
- Workflow-specific prefixes continue to prevent unrelated platform jobs from blocking one another.
- A governance test inventories all tag-accepting `release*.yml` workflows so newly added release workflows cannot escape the contract.

## Implementation

1. Add a governance test that discovers the expected stable, RC, and reusable platform release workflow set.
2. Assert each concurrency group contains the effective tag identity and each has `cancel-in-progress: false`.
3. Update the nine workflows to the shared identity/queue policy without changing jobs, permissions, channel gates, or release payloads.
4. Register the governance test in the repository governance suite if it is not already hosted by an included test file.

## Tests

- Run `scripts/ci/validate-release-rc-workflow.test.js`.
- Run the complete governance suite.
- Run Actionlint if installed; otherwise parse every changed YAML workflow through the existing YAML-backed governance test.

## Non-goals

- Changing release immutability, retry eligibility, store submission policy, or channel selection.
- Serializing different tags or different platform workflows together.
- Dispatching, cancelling, or otherwise mutating live GitHub Actions runs.

## Risks and rollback

Same-tag retries may wait longer, intentionally preserving the first run's atomicity across external channels. Different tags and platform-specific jobs retain separate groups. Rollback is a single workflow-only commit with no product data impact.
