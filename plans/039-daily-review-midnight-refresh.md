# Refresh Daily Review at local midnight

## Problem and evidence

Desktop and mobile capture `today` once when Daily Review mounts. A review left open across local midnight continues classifying due dates, follow-up dates, and calendar windows against the previous day until it is closed and reopened.

## Desired behavior

Both platforms must advance their shared review date when the local day changes. Task buckets, follow-up timestamps, labels, and the two-day calendar fetch must derive from the same refreshed date object.

## Implementation

1. Add desktop and mobile regressions that keep a review open across midnight and observe the next day's due task.
2. Subscribe each review flow to its platform's existing `useLocalDayKey` hook.
3. Recreate `today` from the clock whenever that key changes.
4. Make the desktop external-calendar effect use and depend on the refreshed `today`, matching mobile behavior.

## Verification

- Run both focused Daily Review suites with fake timers.
- Run desktop and mobile package tests, root typecheck, and localization parity.

## Non-goals

- Change task eligibility or review checkpoint expiry.
- Add a second timer implementation.
- Refresh continuously for arbitrary time-of-day transitions.

## Risks and rollback

Midnight now causes one calendar refetch and one review rerender per open flow. The existing hook owns timer cleanup and resume handling. Reverting this commit restores mount-time snapshots.
