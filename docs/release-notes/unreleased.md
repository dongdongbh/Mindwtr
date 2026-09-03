# Mindwtr Unreleased

Changes collected after `v1.2.7` and before the next version tag.

## Full Change List

- Sync: leaving the app mid-sync (switching to another app on a phone, or a background sync hitting its deadline) could leave the shared sync lock behind on Dropbox and WebDAV, and every device then reported "Remote sync is temporarily reserved by mindwtr-mobile" and waited up to five minutes before syncing again. The abort cancelled the request that removes the lock. Lock requests on desktop and mobile now finish independently of the abort, so an interrupted cycle still releases its lock. The "Sync follow-up scheduled" log line also now reports the delay that actually applies instead of only the pacing delay. (from a v1.2.7 device log)

- Sync: a phone could keep syncing every second or two with no changes, warning "syncConflictDiscarded" for the same attachments on every cycle, after another device had deleted attachments the phone still listed. Two causes are fixed. The app kept its own older copy of a task whenever only its attachments had changed, and then wrote that copy back over what sync had just stored. And two devices that hold the same records in a different order were treated as different, so every cycle uploaded again and a self-hosted server answered with a merge each time. The order of records no longer counts as a change, and attachment-only changes now replace the in-memory task. (#1136)
