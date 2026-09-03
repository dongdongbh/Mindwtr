# Mindwtr Unreleased

Changes collected after `v1.2.7` and before the next version tag.

## Full Change List

- Sync: leaving the app mid-sync (switching to another app on a phone, or a background sync hitting its deadline) could leave the shared sync lock behind on Dropbox and WebDAV, and every device then reported "Remote sync is temporarily reserved by mindwtr-mobile" and waited up to five minutes before syncing again. The abort cancelled the request that removes the lock. Lock requests on desktop and mobile now finish independently of the abort, so an interrupted cycle still releases its lock. The "Sync follow-up scheduled" log line also now reports the delay that actually applies instead of only the pacing delay. (from a v1.2.7 device log)
