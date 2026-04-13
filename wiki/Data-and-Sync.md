# Data and Sync

Mindwtr stores data locally and supports multiple synchronization options between devices.

Mindwtr does **not** run a hosted cloud service. Sync is local‑first and user‑configured: you choose how the `data.json` file (and `attachments/`) moves between devices. It won’t happen automatically until you set up one of the options below—but once configured, it works smoothly.

For desktop vault import and note deep links, see [[Obsidian Integration]].

---

## Data Storage

### Desktop

Data is stored in a local SQLite database, with a JSON sync/backup file:

| Platform    | Database (SQLite)                                  | JSON (sync/backup)                                     |
| ----------- | -------------------------------------------------- | ------------------------------------------------------ |
| **Linux**   | `~/.local/share/mindwtr/mindwtr.db`                 | `~/.local/share/mindwtr/data.json`                     |
| **Windows** | `%APPDATA%/mindwtr/mindwtr.db`                      | `%APPDATA%/mindwtr/data.json`                          |
| **macOS**   | `~/Library/Application Support/mindwtr/mindwtr.db`  | `~/Library/Application Support/mindwtr/data.json`      |

Config is stored separately:

| Platform    | Location                                      |
| ----------- | --------------------------------------------- |
| **Linux**   | `~/.config/mindwtr/config.toml`               |
| **Windows** | `%APPDATA%/mindwtr/config.toml`               |
| **macOS**   | `~/Library/Application Support/mindwtr/config.toml` |

> Legacy Tauri builds used `~/.config/tech.dongdongbh.mindwtr/` and `~/.local/share/tech.dongdongbh.mindwtr/` on Linux. These are auto-migrated when detected.

### Mobile

Data is stored in a local SQLite database, with a JSON sync/backup file:

- **SQLite DB**: `mindwtr.db`
- **JSON backup**: `data.json`

---

## Sync Backends

Mindwtr directly supports five sync backends:

- **Native iCloud / CloudKit Sync**: Apple-only native sync where available
- **File Sync**: a user-selected folder/file (`data.json` + `attachments/`)
- **WebDAV**: any compatible WebDAV endpoint
- **Mindwtr Cloud (Self-Hosted)**: your own `apps/cloud` endpoint
- **Dropbox OAuth Sync**: direct Dropbox App Folder sync in supported builds

### Direct vs indirect provider support

- **Directly supported providers/protocols**: native iCloud / CloudKit on supported Apple builds, WebDAV servers, the Mindwtr self-hosted endpoint, and Dropbox OAuth (supported builds).
- **Indirectly supported providers**: iCloud Drive, Google Drive, OneDrive, Syncthing, network shares, and Dropbox via File Sync.
- **Important**: native iCloud sync is **Apple-only**. Android, Windows, and Linux should use File Sync, WebDAV, Mindwtr Cloud, or Dropbox instead.

**Quick guidance:**
- **Syncthing**: device-to-device file sync. Best on the same LAN/subnet. For remote sync, use a Syncthing relay or a mesh VPN (Nebula/Tailscale).
- **WebDAV**: use a provider that supports WebDAV (e.g., Nextcloud, ownCloud, Fastmail, self-hosted).
- **Dropbox**: use native Dropbox sync (supported builds) or File Sync.
- **iCloud**: use native iCloud sync on supported Apple builds, or iCloud Drive via File Sync.
- **Google Drive/OneDrive**: use File Sync (and Android bridge apps when needed).

## Sync Recommendations

- **Best for multi-device:** WebDAV or Mindwtr Cloud (self-hosted). The app controls the sync cycle and merges per item.
- **File Sync (Syncthing/Dropbox/etc.):** works, but **conflicts are file-level** because `data.json` is a single file.
- **Best practices for File Sync:** avoid editing on two devices at the same time, and wait for sync to finish before opening the app on another device. If conflicts appear, keep the newest `data.json` and delete the `data.json.sync-conflict-*` copies.

### 1. Native iCloud / CloudKit Sync (Apple-only)

Mindwtr includes a native **iCloud** backend on supported Apple builds.

- **Guide**: [[iCloud Sync]]
- **Best for**: Apple-only device setups where you want a simpler experience than managing a shared folder
- **Not for**: Android, Windows, or Linux devices in the same sync setup

This backend is available on iPhone, iPad, and macOS. If you prefer a folder-based setup on macOS, you can still use **iCloud Drive + File Sync** instead.

### 2. File Sync

Sync via a shared JSON file with any folder-based sync service:

- Dropbox
- Google Drive
- Syncthing
- OneDrive
- iCloud Drive
- Any network folder

#### iCloud Drive as File Sync (macOS + iOS)

iCloud Drive also works with Mindwtr through **File Sync** if you want to sync through a shared folder instead of the native CloudKit backend.

Recommended setup:
1. On macOS, create a folder like `iCloud Drive/Mindwtr`.
2. In Mindwtr desktop, set **Sync Backend = File** and pick that folder.
3. Export once to create `data.json` and `attachments/`.
4. Wait for iCloud Drive to finish uploading.
5. On iOS, in Mindwtr mobile **Settings → Data & Sync → Select Folder**, choose the same iCloud Drive folder in Files.
   - If a provider is greyed out in the iOS folder picker, select any JSON file inside the target folder. Mindwtr will still use that folder for `data.json` and `attachments/`.

Important:
- Sync both `data.json` **and** `attachments/`. Attachments are part of sync data.
- Do not move only `data.json` without `attachments/`, or attachment metadata/files can drift.
- If iCloud Optimize Storage offloads files, let Files re-download before running a manual sync.

#### Syncthing Notes (Recommended Setup)

Syncthing works well with Mindwtr, but the initial setup order matters.
Devices must be able to reach each other: best on the same subnet/LAN, or via a relay/mesh VPN (e.g., Nebula or Tailscale) if you want remote syncing.

**Recommended flow:**
1. Create a single Syncthing folder (e.g., `Mindwtr/`) and let it fully sync.
2. On desktop, choose that folder in **Settings → Data & Sync → File Sync**.
3. **Export Backup** to that folder to create `data.json` and `attachments/`.
4. Wait for Syncthing to finish syncing to your phone.
5. On mobile, select the same folder in **Settings → Data & Sync**.

**Why you see `attachments (1)` / `attachments (2)`**
Syncthing creates duplicate folders when both devices create or modify the same folder at the same time. This often happens if both devices open Mindwtr before the initial sync completes.

**How to fix duplicates:**
1. Pick the “real” `attachments/` folder (usually the one with more files).
2. Move files from `attachments (1)`/`attachments (2)` into `attachments/`.
3. Delete the duplicate folders and let Syncthing converge.

**Important:** Don’t sync `~/.local/share/mindwtr` directly. Mobile storage is sandboxed. Use the file sync folder + `data.json` instead.
If you already synced the app data directory, switch to a dedicated sync folder and re-select it in Settings.

#### Google Drive on Android (File Sync) and Dropbox File-Sync Fallback

Google Drive does **not** provide WebDAV. If you want to use Google Drive with file sync on Android, you need a bridge app that keeps a local folder in sync (so Mindwtr can read/write `data.json` directly).

Dropbox users on Android can use native Dropbox sync in supported builds. If you prefer file sync, the same bridge-app approach also works for Dropbox.

Examples:
- **Dropsync** (Dropbox)
- **Autosync** (Google Drive)
- **FolderSync** (generic)

Then point Mindwtr to the local synced folder in **Settings → Data & Sync**.

#### OneDrive on Android (Recommended Setup)

Android’s official OneDrive app does **not** keep a local folder in continuous two‑way sync.
To use OneDrive reliably with Mindwtr on Android, install a “bridge” app:

- **OneSync (Autosync for OneDrive)**
- **FolderSync**

Then:
1. Create a OneDrive folder for Mindwtr (on desktop).
2. Use the bridge app to sync that folder to a local folder on Android.
3. In Mindwtr, select that local folder in **Settings → Data & Sync** (Mindwtr will use `data.json` inside).

### 3. WebDAV Sync

Sync directly to a WebDAV server:

- Nextcloud
- ownCloud
- Fastmail
- Any WebDAV-compatible server

### 4. Mindwtr Cloud (Self-Hosted)

For advanced users, Mindwtr includes a simple sync server (`apps/cloud`) that can be self-hosted.

- **Protocol**: Simple REST API (GET/PUT)
- **Auth**: Bearer token (mapped to a specific data file on the server)
- **Deployment**: Node.js/Bun
- **Docker setup**: [[Docker Deployment]]
- **Operations guide**: [[Cloud Deployment]]

Important client note:

- **HTTPS is required for Mindwtr Cloud on normal device URLs.** `http://localhost` is allowed for local development, but a LAN URL such as `http://192.168.x.x` is not supported for Cloud sync clients.
- If you are self-hosting on your local network, put the cloud server behind HTTPS with a reverse proxy such as `caddy`, `nginx`, or `traefik`.
- If you specifically need plain HTTP on a private LAN, use **WebDAV** instead. Mindwtr allows HTTP for WebDAV on localhost/private IP ranges.

### 5. Dropbox OAuth Sync

Mindwtr also supports direct Dropbox sync in supported desktop/mobile builds.

- **Scope**: Dropbox App Folder (`/Apps/Mindwtr/`)
- **Synced data**: `data.json` and `attachments/*`
- **Auth**: OAuth 2.0 + PKCE
- **Guide**: [[Dropbox Sync]]

---

## How Sync Works

### Auto-Sync

Mindwtr automatically syncs in the following situations:

- **On data changes** — 5 seconds after any task/project modification (debounced)
- **On app focus** — When the app regains focus (throttled to every 30 seconds)
- **On app blur/background** — When you switch away from the app
- **On startup** — Shortly after the app launches

### Settings Sync Options

Mindwtr can sync select preferences across devices. Configure in **Settings → Data & Sync → Settings sync options**.

Available options include:
- **Appearance** (theme)
- **Language & date format**
- **External calendar URLs** (ICS subscriptions)
- **AI settings** (models/providers)

> API keys and local model paths are never synced.
> Settings conflict resolution is group-based. If two devices edit different fields in the same settings group at nearly the same time, the newer group update can overwrite the older one.

### Merge Strategy

Mindwtr uses **revision-aware Last-Write-Wins (LWW)** per item:
- Each task, project, section, and area carries an `updatedAt` timestamp.
- When available, revision metadata (`rev` and `revBy`) is used before falling back to plain timestamps.
- Soft-deleted items (tombstones) are preserved so deletions propagate correctly across devices.

Delete-vs-live conflicts use the **last operation time**, not just the raw `updatedAt`:
- For deleted items, Mindwtr compares `deletedAt` against the live item's latest update.
- If the delete and live edit are more than 5 seconds apart, the newer operation wins.
- Inside that 5-second ambiguity window, Mindwtr prefers higher revision metadata first, then newer timestamps, then `revBy`, and finally a deterministic content signature so both devices converge on the same winner.

Clock-skewed future timestamps are clamped during merge safety checks so a bad device clock does not dominate forever. If both sides are clamped into the future, Mindwtr still preserves their relative ordering instead of treating them as a false tie.

### Conflict Visibility & Clock Skew

After each sync, Mindwtr stores sync stats in settings:

- **Conflicts**: total conflict count and a small sample of conflicting IDs
- **Clock skew**: max observed timestamp skew between devices
- **Timestamp fixes**: when `updatedAt < createdAt`, timestamps are corrected during merge

You can see these details in **Settings → Sync** (desktop and mobile). Large skew values usually indicate device clocks are out of sync.  
On mobile, sync history entries are collapsed by default; tap to expand.

### Attachment Sync & Cleanup

- Attachments are synced **after** metadata merges.
- Missing attachments remain as placeholders until downloaded.
- Orphaned attachments are cleaned up automatically (and can be triggered manually on desktop in **Settings → Sync**).

---

## Desktop Sync Setup

### File Sync

1. Open **Settings → Data & Sync**
2. Set **Sync Backend** to **File**
3. Click **Change Location** and select a folder in your sync service
4. Click **Save**

Mindwtr will automatically sync on startup and when data changes.

### WebDAV Sync

1. Open **Settings → Data & Sync**
2. Set **Sync Backend** to **WebDAV**
3. Enter your WebDAV server details:
   - **URL** — Folder URL; Mindwtr will store `data.json` inside (e.g., `https://nextcloud.example.com/remote.php/dav/files/user/Mindwtr`)
   - **Username** — Your WebDAV username
   - **Password** — Your WebDAV password
4. Click **Save WebDAV**

> **Linux note:** If your desktop session does not provide a Secret Service keyring (for example `org.freedesktop.secrets` is unavailable), Mindwtr falls back to local secrets storage in `~/.config/mindwtr/secrets.toml`.

> **Tip:** For Nextcloud, the URL format is:
> `https://your-server.com/remote.php/dav/files/USERNAME/path/to/folder`
>
> URLs with explicit ports are supported (e.g., `https://example.com:5000/mindwtr`).

## Mobile Sync Setup

Mobile sync requires manually selecting a sync folder due to Android/iOS storage restrictions.

On iOS, some cloud providers may not expose folder selection in Files. In that case, select any JSON file inside the target sync folder; Mindwtr will resolve and use the folder path for sync.

### 1. Export Your Data First

1. Go to **Settings → Data & Sync**
2. Tap **Export Backup**
3. Save the file to your sync folder (e.g., Google Drive)

### 2. Select Sync Folder

1. In **Settings → Data & Sync**
2. Tap **Select Folder**
3. Navigate to your sync folder
4. Select the folder that contains (or will contain) `data.json`

### 3. Auto-Sync

Mobile now syncs automatically:
- When the app goes to background
- 5 seconds after data changes
- When returning to the app (if >30 seconds have passed)

You can also tap **Sync** manually anytime in Settings.

---

## SQLite + JSON Sync Bridge

Mindwtr uses SQLite as the primary local store. When sync is enabled, it keeps a JSON file in sync:

- **Outgoing**: SQLite changes are exported to `data.json` (debounced).
- **Incoming**: External changes to `data.json` are imported back into SQLite.

This preserves Dropbox/Syncthing/WebDAV workflows while improving speed and data safety.

---

## Sync Workflow

### Two Devices

**Initial setup:**
1. Set up desktop with sync folder
2. Export backup, save to sync folder
3. On mobile, select that folder

**Daily use:**
1. Make changes on Device A
2. Wait for sync service to replicate
3. On Device B, trigger sync (Settings → Sync)

### Multiple Devices

The same workflow applies. Avoid editing on multiple devices simultaneously to prevent conflicts.

---

## Troubleshooting Checklist

- **Confirm `data.json` exists** in your sync folder and is being updated.
- **Wait for Syncthing to fully sync** before opening Mindwtr on the second device.
- **Use “Sync” manually** in Settings if you want an immediate pull/push.
- **Check for duplicate attachment folders** (`attachments (1)`, etc.) and merge them.
- **Make sure device clocks are correct** (large skew causes conflicts).
- **Verify folder permissions** (Android SAF may block write access to some folders).

---

## Backup and Export

### Export Data

**Desktop:**
- Use **Settings → Sync → Data Transfer → Export Backup**
- Sync backends also keep `data.json` updated automatically when sync is enabled

**Mobile:**
1. Go to **Settings → Data & Sync**
2. Tap **Export Backup**
3. Save to your desired location

### Restore from Backup

Mindwtr can restore local data directly from a backup JSON file on both desktop and mobile.

Flow:
1. Open **Settings → Data & Sync / Sync**
2. Choose **Restore Backup**
3. Pick a Mindwtr backup JSON file
4. Review the backup summary and confirm

Before restore, Mindwtr validates the file and creates a recovery snapshot when the platform supports it. Restore is a full local replacement, not a merge.

- **Desktop**: a recovery snapshot is created in the app data snapshot folder before restore
- **Mobile**: a local recovery snapshot is created in app storage before restore
- **If the file is invalid**: restore is blocked and your current data stays untouched

See [[Backup and Restore]] for the detailed flow.

### Todoist CSV / ZIP Import

Mindwtr can import Todoist exports from **Settings → Data & Sync / Sync → Import from Todoist**.

- Supports a single Todoist CSV export or a ZIP backup containing multiple project CSVs
- Creates Mindwtr projects from Todoist projects
- Preserves Todoist sections as Mindwtr sections
- Converts Todoist subtasks into checklist items
- Leaves imported tasks in **Inbox** so you can process them through your normal GTD flow

Recurring Todoist schedules are not recreated automatically. Mindwtr imports the task once and keeps the original recurrence text in the description.

See [[Todoist Import]] for details and supported mappings.

### Backup Strategy

- Regular exports to sync folder
- Keep local config folder backed up
- The sync file serves as a backup
- Recovery snapshots are saved automatically before restore/import operations

---

## Troubleshooting

### Sync Not Working

1. **Check sync folder path**
   - Ensure the path exists and is accessible
   - Verify permissions

2. **Check sync service**
   - Is Dropbox/Google Drive running?
   - Is the file synced across devices?

3. **Temporary file errors**
   - If a sync service is mid‑write (e.g., Syncthing), the JSON can be temporarily invalid.
   - Wait a moment and sync again.

4. **Manual sync**
   - Click Sync Now (desktop) or Sync (mobile)
   - Check for any error messages

### Data Conflicts

If you see unexpected data:
1. Export a backup of current data
2. Check the sync folder for the latest file
3. Manually review and merge if needed

### Mobile Sync File Not Found

1. Ensure the file exists in your cloud folder
2. Re-select the file in Settings → Data & Sync
3. Check file permissions

### Reset Sync

To start fresh:
1. Delete the sync folder contents
2. Export from one device
3. Import/sync on other devices

---

## Data Format

The `data.json` file structure:

```json
{
  "tasks": [
    {
      "id": "uuid",
      "title": "Task title",
      "status": "next",
      "contexts": ["@home"],
      "tags": ["#focused"],
      "dueDate": "2025-01-15T09:00:00Z",
      "createdAt": "2025-01-01T10:00:00Z",
      "updatedAt": "2025-01-10T15:30:00Z",
      "deletedAt": null
    }
  ],
  "projects": [
    {
      "id": "uuid",
      "title": "Project name",
      "status": "active",
      "color": "#3B82F6",
      "areaId": "area-uuid",
      "tagIds": ["#client", "#feature"],
      "createdAt": "2025-01-01T10:00:00Z",
      "updatedAt": "2025-01-10T15:30:00Z"
    }
  ],
  "areas": [
    {
      "id": "uuid",
      "name": "Research",
      "color": "#3B82F6",
      "icon": "🔬",
      "order": 0,
      "createdAt": "2025-01-01T10:00:00Z",
      "updatedAt": "2025-01-10T15:30:00Z"
    }
  ],
  "settings": {
    "theme": "dark",
    "language": "en"
  }
}
```

---

## Privacy

- All data is stored locally on your device
- Sync happens through your own cloud service
- No data is sent to Mindwtr servers
- You control your data completely

---

## See Also

- [[User Guide Desktop]]
- [[User Guide Mobile]]
- [[Getting Started]]
- [[Attachments]]
