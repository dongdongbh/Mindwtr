# Mindwtr Desktop

Tauri v2 desktop app for the Mindwtr productivity system.

## Features

### GTD Workflow
- **Inbox Processing** - Guided clarify workflow with 2-minute rule
- **Context Filtering** - Slash-delimited contexts with parent matching (@work/meetings)
- **Weekly Review** - Step-by-step GTD review wizard
- **Board View** - Kanban-style drag-and-drop
- **Calendar View** - Time-based task planning
- **AI Assistant (Optional)** - Clarify, break down, and review with BYOK AI

### Productivity
- **Global Search** - Search operators (status:, context:, due:<=7d)
- **Saved Searches** - Save and reuse search filters
- **Bulk Actions** - Multi-select, batch move/tag/delete
- **Task Dependencies** - Block tasks until prerequisites complete
- **Markdown Notes** - Rich text descriptions with preview
- **Attachments** - Files and links on tasks
- **Reusable Lists** - Duplicate tasks or reset checklists
- **Keyboard Shortcuts** - Vim and Emacs presets
- **Global Hotkey** - Capture from anywhere
- **Tray Icon** - Quick access and capture

### Notifications
- **Due Date Reminders** - Desktop notifications with snooze
- **Daily Digest** - Morning briefing + evening review prompts

### Views
| View          | Description                        |
| ------------- | ---------------------------------- |
| Inbox         | Capture and process incoming items |
| Next Actions  | Context-filtered actionable tasks  |
| Projects      | Multi-step outcomes with areas     |
| Contexts      | Slash-delimited context filtering with parent matching |
| Waiting For   | Delegated items                    |
| Someday/Maybe | Deferred ideas                     |
| Calendar      | Time-based view                    |
| Board         | Kanban drag-and-drop               |
| Review        | Weekly review wizard               |
| Settings      | Theme, sync, and preferences       |

## Tech Stack

- **Frontend**: React + TypeScript + Vite
- **Styling**: Tailwind CSS
- **State**: Zustand (shared with mobile)
- **Platform**: Tauri v2 (Rust backend, WebKitGTK)
- **Drag & Drop**: @dnd-kit

### Why Tauri?
- 🚀 **Small binary** (~5MB vs ~150MB for Electron)
- 💾 **Low memory** (~50MB vs ~300MB for Electron)
- 🦀 **Rust backend** for fast file operations
- 🖥️ **Native dialogs** via system webview

### Security Note
- CSP is disabled for the trusted local UI (`src-tauri/tauri.conf.json`). Avoid loading untrusted remote content in the webview.

## Prerequisites

- [Rust](https://rustup.rs/) (for building Tauri)
- [Bun](https://bun.sh/) (package manager)

### Arch Linux
```bash
sudo pacman -S rust webkit2gtk-4.1 base-devel
```

## Getting Started

```bash
# From monorepo root
bun install

# Run desktop app (dev mode)
cd apps/desktop
bun dev

# Or from root
bun desktop:dev
```

## Building

```bash
# Build for distribution
bun run build

# Output in src-tauri/target/release/
```

## Data Storage

Tasks are saved to:
- **Linux data**: `~/.local/share/mindwtr/data.json`
- **Linux config**: `~/.config/mindwtr/config.toml`

Desktop Settings → Sync → Local Data shows the exact paths for your OS. If you used very early builds, data may exist under legacy Tauri directories like `~/.config/tech.dongdongbh.mindwtr/` and `~/.local/share/tech.dongdongbh.mindwtr/` and will be migrated automatically.

## Sync

Configure sync in Settings:
- **File Sync** - Dropbox, Google Drive, Syncthing, etc.
- **WebDAV** - Nextcloud, ownCloud, self-hosted servers
- **Cloud** - Self-hosted cloud backend (see `../../docs/cloud-sync.md`)
- **External Calendars (ICS)** - View-only calendar overlay

Sync recommendation:
- Prefer **WebDAV** for frequent multi-device edits.
- If using **Syncthing**, use `Send & Receive` + `Watch for Changes`, keep scan intervals short, and tap **Sync now** before switching devices.

## Testing

```bash
bun run test
```

Includes unit tests, component tests, and accessibility tests.
