# Show every task in mobile Daily Review

## Problem and evidence

The mobile Daily Review reports the full bucket count but passes only the first eight tasks to its virtualized `FlatList` for Today, Inbox, Waiting For, and Focus. Tasks after the eighth have no recovery path inside the review, so the displayed count and the work a user can actually review disagree.

## Desired behavior

Each active task bucket must pass every eligible task to the existing virtualized list. Every Waiting For row must also retain its per-task follow-up action.

## Implementation

1. Add a regression test with nine eligible tasks for each affected review step.
2. Remove the presentation-only eight-task slices at the four list call sites.
3. Build Waiting For footer content for the complete waiting bucket.
4. Keep the existing `FlatList` batching and windowing settings unchanged.

## Verification

- Run the focused mobile Daily Review component suite.
- Run the mobile package test suite, root typecheck, and localization parity check.

## Non-goals

- Change review eligibility, ordering, or focus limits.
- Change the separate five-event calendar preview.
- Replace the existing virtualized list.

## Risks and rollback

Passing larger arrays can increase list bookkeeping, but rendering remains virtualized and bounded by the existing window. Reverting this commit restores the old cap if device evidence reveals a regression.
