# Mindwtr Unreleased

Changes collected after `v1.2.7` and before the next version tag.

## Full Change List

- Desktop Timeline: the view is easier to read. A line now separates one project from the next, task bars are drawn in a lighter tint of the project color so the project bar stands out as their parent, and a task title is shown once in the name column on the left instead of also on the bar. (#1111)

- Sync: leaving the app mid-sync (switching to another app on a phone, or a background sync hitting its deadline) could leave the shared sync lock behind on Dropbox and WebDAV, and every device then reported "Remote sync is temporarily reserved by mindwtr-mobile" and waited up to five minutes before syncing again. The abort cancelled the request that removes the lock. Lock requests on desktop and mobile now finish independently of the abort, so an interrupted cycle still releases its lock. The "Sync follow-up scheduled" log line also now reports the delay that actually applies instead of only the pacing delay. (from a v1.2.7 device log)

- Sync: a phone could keep syncing every second or two with no changes, warning "syncConflictDiscarded" for the same attachments on every cycle, after another device had deleted attachments the phone still listed. Two causes are fixed. The app kept its own older copy of a task whenever only its attachments had changed, and then wrote that copy back over what sync had just stored. And two devices that hold the same records in a different order were treated as different, so every cycle uploaded again and a self-hosted server answered with a merge each time. The order of records no longer counts as a change, and attachment-only changes now replace the in-memory task. (#1136)

- Arch Linux: the source-built AUR package `mindwtr` is now community maintained and is no longer published by the Mindwtr release pipeline. The packages Mindwtr publishes are `mindwtr-bin` (stable) and `mindwtr-beta-bin` (release candidates). The docs and the AUR package policy now say so.

- Web app: choosing a self-hosted server that already holds attachments failed with "Candidate attachment proof failed for …" on every attempt, because the browser build was asked to prove attachments it has no storage for. The web app now skips that proof; attachments stay available on your native apps and unavailable in the browser, as before. (#1119)

- Self-hosted server: a new capture webhook, `POST /v1/capture`, turns a posted transcription and optional audio recording into an Inbox task with the recording attached. Send it as a form upload, as JSON, or as plain text, with your sync token as the bearer token. It matches the format the Pebble Index watch already posts, so that watch can send straight to your own server, and so can any shortcut, script, or automation that can make a web request. (#1148)
