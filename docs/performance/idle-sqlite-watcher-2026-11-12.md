# Idle SQLite watcher, November 12

Issue #1548 reports v1.3.8 .deb on Linux Mint with WebDAV. The supplied diagnostic interval contains 22 SQLite refresh starts and 22 no-change results; database events recur roughly every three seconds. No task data was needed for the investigation.

At base 9aac1cf, local JSON and SQLite watchers and the File Sync watcher filtered paths but ignored event kinds. A regression through the registered watcher callbacks fails before the filter: access events cause storage reads. A separate synthetic Linux SQLite probe, five connection open/read/close cycles, emits five database opens, ten access events, and five close-write events despite executing only SELECT. Close-write describes the descriptor's access mode and does not prove a SQL mutation.

The shared event predicate ignores access-only notifications and access-time metadata changes. Content changes, create/remove/rename, write-time metadata, and unknown events continue through existing handlers. WAL creation/removal stays observable, external writes retain their reconciliation path, and durability/checkpoint settings are unchanged. One diagnostic per controller confirms the SQLite filter ran without logging every ignored event.

Validation: failing-before/passing-after callback regression and focused watcher, sync, and event tests. This establishes avoided redundant reads for access events, not an SSD-write byte reduction or reproduction of the complete Linux Mint app session. Reporter confirmation of quiet idle behavior and external-edit refresh remains required. Next bounded step if churn continues: obtain event kinds and measure actual changed file bytes; do not suppress WAL lifecycle events blindly.
