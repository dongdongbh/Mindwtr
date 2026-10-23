# Native iOS Inbox Bulk Organize (Task743)

The native Inbox supports bulk organization and separate project/area creation. The shared core prepares complete saved-state witnesses and uses guarded persistence with exact request receipts for retry and cold recovery. Creating a destination does not apply the task batch; cancelling keeps a destination already saved.

Project and area offers retain data, settings, selection and draft validation without expiring merely when the display clock crosses a minute. Retrying a rejected create refreshes the open picker. The picker also snapshots lazy rows before rendering.

## Validation at integration

- Merged core creation, organization and bulk-picker suites: 128 tests passed; core, native-host and mobile typechecks passed. Clock-boundary regressions failed before the correction; removing the authority dependency caused genuine stale-data controls to fail.
- The merge retains main's SQLite connection and store-command gates. Three new Pomodoro regressions failed before integration fixes and passed afterward: queued reads cannot enter the transaction, canonical reload releases the SQL lock while excluding sync saves, and pre-transition read tokens cannot authorize a later save. The bounded storage set has passing evidence for all 154 cases across its initial run and the corrected lock-test rerun; the mobile Pomodoro set passed 70 tests.
- Historical Pomodoro receipts retain their exact schema-4 payload after the notification-policy column was added. Committed receipts can load and replay; receiptless old plans fail stale and require fresh preparation. The session/receipt suites passed 91 tests, including three compatibility regressions that failed before the correction. The canonical-read contract now exercises the 12 added store writers and passes; the existing skipped case remains skipped.
- Production Swift owner harness: 80 assertions passed. Restoring the old retry route made its regression fail.
- Independent source review passed. A normal production core bundle was built from the reviewed source.
- Historical SDK8/Install10 passed signed-build and installation-preservation checks. UI8 largest-text passed, but normal-text failed at Create with the stale offer. Final data preservation and the complete failure archive passed.
- The pre-merge corrected SDK9 source packet was staged. Signing admission stopped because the existing signing keychain was locked. No corrected signed build or installation has run. That packet does not validate the merged source; subsequent SDK/device work must bind a fresh bundle and source revision.

Physical native/UI retesting and scratch-copy SQL/FTS acceptance remain pending. Source integration does not mark Task743 or the overall native iOS migration complete. Retained device data must be preserved in subsequent runs; failed test identities must not be reused.
