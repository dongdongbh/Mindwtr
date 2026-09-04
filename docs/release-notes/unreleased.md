# Mindwtr Unreleased

Changes collected after `v1.2.7` and before the next version tag.

## Full Change List

- Android: a background sync that uploaded two or more attachments to WebDAV could stall until the app was reopened, holding the system's background job for its whole allowance and draining the battery. The short pause between attachment requests and the upload time limit both waited on a timer Android never fires while the app is in the background; both now step aside while timers are paused, as the rest of the background path already did. (#1001)

- Sync: a completion date written through MCP onto a task that is not done or archived was read back from the local database in a form the sync normalizer would still strip, the same class of problem as the repeat flag above; both readers now surface a completion date only on done or archived tasks, and a contract test now checks every synced task field this way. (#1001)

- Sync: a task whose "show future occurrences" flag was set through MCP on a task with no repeat rule read back from the local database in a form the sync normalizer would still change, which on 1.2.7 desktops failed the next automatic sync once before self-healing. Both the desktop (Rust) and the phone (TypeScript) readers now treat the flag as set only when the task actually repeats. (#1001)

- Desktop and web app: an automatic sync that could upload the local library without merging first (a change made only on this device) still paid a full merge and two whole-library serializations on the interface thread in 1.2.7, because a development-only self-check was accidentally active in those builds; and when a task written through MCP looked different after the normalizing pass, that self-check failed the whole sync cycle instead of staying silent. The check now runs only in development builds. (#1001)

- Desktop Timeline: a project whose dates all fall outside the visible window no longer shows as a bare row with nothing drawn; it is counted in the Earlier or Later notice like the tasks that are out of view. (#1111)

- Desktop Timeline: the chart can be focused with the keyboard and scrolled sideways with the arrow keys, and screen readers now announce the chart and the zoom control by name. (#1111)

- Mobile: the task editor's status list now offers Reference for every task, as the status badge on the same screen and the desktop already did, so a note can be filed as reference material without leaving the editor. (#1155)

- Desktop: after switching sync backends, a follow-up sync that does not finish (for example because another device holds the location) now says the new settings are active and that sync will retry, instead of the old message claiming the previous sync settings were still in use.

- Desktop: Trash has a go-to keyboard chord, `g T` in the Vim preset and `Alt+Shift+T` in the Emacs preset, so a Trash hidden through Settings → Sidebar views stays reachable, and the setting's description now says hidden views stay reachable through their go-to chord rather than from search, which never opened views. (#1115)

- Desktop: the Daily Review focus step shows your configured Today's Focus limit (for example "1 / 1" or "2 / 5") instead of always "/ 3", so it no longer invites picks the star control then refuses.

- Desktop: each Daily Review step now shows every task it counts. The step header said, for example, "23 tasks" while only the first ten were listed, so the rest could not be reviewed from inside the review. The phone was fixed the same way in 1.2.6.

- Desktop: editing a task no longer rebuilds the whole task index just so each visible row can read the Today's Focus count. On a large library every edit paid that rebuild on the interface thread; rows now read the count from a cached scan, as the phone already did since 1.2.7. (#1001)

- Self-hosted server: when a `POST /v1/capture` request fails after its audio recording was already written to disk, the recording is removed again instead of staying behind as a file no task refers to.

- MCP: `mindwtr_update_task` and `mindwtr_update_project` re-read the stored attachments inside the retried write, so a link removed by the app or by another agent while the update was being retried stays removed instead of coming back.

- MCP: `mindwtr_add_task`, `mindwtr_update_task`, `mindwtr_add_project` and `mindwtr_update_project` now refuse a link attachment whose uri points at a network share (`\\host\share`, `//host/share` or `file://host/...`), because opening such a link on Windows makes the desktop contact that host before any check runs. `https://`, `obsidian://`, `file:///` and plain local paths keep working as before.

- Desktop: choosing Reference while processing the inbox now offers the project and area pickers, so a note lands in its project in one step, and the task status menus on rows and in the editor list Reference for every task, so a task inside a project can be turned into a reference without leaving the project. (#1155)

- MCP: `mindwtr_add_task`, `mindwtr_update_task`, `mindwtr_add_project` and `mindwtr_update_project` accept link attachments (`kind: "link"`, a title and a uri such as obsidian://, file:// or https://), so an agent can attach the clickable reference the app shows as a link. On update the list is the complete set of links: links left out are removed, file attachments are never touched. (#1154)

- Desktop Timeline: the view is easier to read. A line now separates one project from the next, task bars are drawn in a lighter tint of the project color so the project bar stands out as their parent, a task title is shown once in the name column on the left instead of also on the bar, task bars are thinner than the solid project bar, the daily and weekly gridlines are drawn as crisp lines instead of a repeating pattern that blurred into soft vertical bands on scaled displays, and the view opens centered on today and re-centers when you change the zoom. (#1111)

- Desktop: the buttons that appear when you hover a task row (start a Pomodoro, the three-dot menu, duplicate, delete, and the trash can on deleted rows) were invisible in 1.2.7. The cursor still changed over them and clicks still worked, but nothing was drawn. A security update of a stylesheet tool made every hover-revealed style disappear from the build; the tool is now on the corrected release and a build check guards it. (from in-app feedback)

- Sync: a desktop joining a File Sync folder whose attachment files had not arrived yet (a Syncthing or mounted folder that carried `data.json` but not `attachments/`) refused the folder with "Candidate attachment proof failed for <id>" and kept the previous sync settings, on every retry. When the device holds no copy of the file, the switch now completes and the record stays downloadable, so the file arrives on a later sync once the folder delivers it. A device that does hold the file is still refused. (from in-app feedback)

- Sync: leaving the app mid-sync (switching to another app on a phone, or a background sync hitting its deadline) could leave the shared sync lock behind on Dropbox and WebDAV, and every device then reported "Remote sync is temporarily reserved by mindwtr-mobile" and waited up to five minutes before syncing again. The abort cancelled the request that removes the lock. Lock requests on desktop and mobile now finish independently of the abort, so an interrupted cycle still releases its lock. The "Sync follow-up scheduled" log line also now reports the delay that actually applies instead of only the pacing delay. (from a v1.2.7 device log)

- Sync: a phone could keep syncing every second or two with no changes, warning "syncConflictDiscarded" for the same attachments on every cycle, after another device had deleted attachments the phone still listed. Two causes are fixed. The app kept its own older copy of a task whenever only its attachments had changed, and then wrote that copy back over what sync had just stored. And two devices that hold the same records in a different order were treated as different, so every cycle uploaded again and a self-hosted server answered with a merge each time. The order of records no longer counts as a change, and attachment-only changes now replace the in-memory task. (#1136)

- Arch Linux: the source-built AUR package `mindwtr` is now community maintained and is no longer published by the Mindwtr release pipeline. The packages Mindwtr publishes are `mindwtr-bin` (stable) and `mindwtr-beta-bin` (release candidates). The docs and the AUR package policy now say so.

- Web app: choosing a self-hosted server that already holds attachments failed with "Candidate attachment proof failed for …" on every attempt, because the browser build was asked to prove attachments it has no storage for. The web app now skips that proof; attachments stay available on your native apps and unavailable in the browser, as before. (#1119)

- Self-hosted server: a new capture webhook, `POST /v1/capture`, turns a posted transcription and optional audio recording into an Inbox task with the recording attached. Send it as a form upload, as JSON, or as plain text, with your sync token as the bearer token. It matches the format the Pebble Index watch already posts, so that watch can send straight to your own server, and so can any shortcut, script, or automation that can make a web request. (#1148)

- iCloud sync (iOS and macOS): when CloudKit refused a save, the Sync screen showed "Atomic failure" for a bystander record instead of the record and reason that actually failed, so the cause could not be read from the shared log. The screen and the log now name the failing record's real error. (Discord report, App Store 1.2.7)

- iCloud sync (iOS and macOS): after 1.2.7, iCloud sync failed on every attempt with "Atomic failure" for anyone whose library held a project with a start date. The new project start date was created in the iCloud schema as a date field, while the app stores every date as text, so CloudKit refused the record and the whole batch with it. The start date now syncs through a text field like the other dates. (Discord report, App Store 1.2.7)

- Windows (Microsoft Store): due-date and other reminders never showed a notification while the app ran in the tray, because the Store version of the app asked Windows to post the toast under a name Windows does not accept for it. Store installs now post reminders under the app's own package identity, and the debug log records every reminder the app fires and which path delivered it. (#1146)

- Sync setup: when a new sync location cannot be verified because of an attachment, the message now names the file and the task or project it belongs to, and says why, for example that the file was uploaded to iCloud and is not reachable from the new location. On the phone the toast now shows that reason instead of only "Review Settings → Sync and try again". (#1151)
