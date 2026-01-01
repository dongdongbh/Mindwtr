<div align="center">

<img src="apps/mobile/assets/images/icon.png" width="120" alt="Mindwtr Logo">

# Mindwtr

English | [中文](./README_zh.md)

A complete Getting Things Done (GTD) productivity system for desktop and mobile. *Mind Like Water.*

*New to GTD? Read [GTD in 15 minutes](https://hamberg.no/gtd) for a quick introduction.*

[![CI](https://github.com/dongdongbh/Mindwtr/actions/workflows/ci.yml/badge.svg)](https://github.com/dongdongbh/Mindwtr/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/dongdongbh/Mindwtr?style=social)](https://github.com/dongdongbh/Mindwtr/stargazers)
[![GitHub license](https://img.shields.io/github/license/dongdongbh/Mindwtr)](LICENSE)
[![GitHub last commit](https://img.shields.io/github/last-commit/dongdongbh/Mindwtr)](https://github.com/dongdongbh/Mindwtr/commits/main)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/dongdongbh/Mindwtr/pulls)
[![Sponsor](https://img.shields.io/static/v1?label=Sponsor&message=%E2%9D%A4&logo=GitHub&color=%23fe8e86)](https://github.com/sponsors/dongdongbh)


</div>

<div align="center">
  <video src="https://github.com/user-attachments/assets/8b067635-196e-4c9c-ad26-92ca92fef327" width="60%" autoplay loop muted playsinline></video>
  
  <video src="https://github.com/user-attachments/assets/fe1ce194-fa5a-491a-a3b2-17c96b924219" width="25%" autoplay loop muted playsinline></video>

  <p>
    <i>Local-First GTD on Arch Linux & Android</i>
  </p>
</div>

## Features

### GTD Workflow
- **Capture** - Quick add tasks from anywhere (global hotkey, tray, share sheet)
- **Clarify** - Guided inbox processing with 2-minute rule
- **Organize** - Projects, contexts, and status lists
- **Reflect** - Weekly review wizard with reminders
- **Engage** - Context-filtered next actions
- **AI Assist (Optional)** - Clarify, break down, and review with BYOK AI

### Views
- 📥 **Inbox** - Capture zone with processing wizard
- ▶️ **Next Actions** - Context-filtered actionable tasks
- 🗓️ **Agenda** - Daily focus and time-based overview
- 📁 **Projects** - Multi-step outcomes with areas
- 🏷️ **Contexts** - Hierarchical contexts (@work/meetings)
- ⏳ **Waiting For** - Delegated items
- 💭 **Someday/Maybe** - Deferred ideas
- 📅 **Calendar** - Time-based planning
- 📋 **Board** - Kanban-style drag-and-drop
- 📝 **Review** - Daily + weekly review workflows
- 📦 **Archived** - Hidden history, searchable when needed

### Productivity Features
- 🔍 **Global Search** - Search operators (status:, context:, due:<=7d)
- 💾 **Saved Searches** - Save and reuse search filters
- 📦 **Bulk Actions** - Multi-select, batch move/tag/delete
- 🔗 **Task Dependencies** - Block tasks until prerequisites complete
- 📎 **Attachments** - Files and links on tasks
- ✏️ **Markdown Notes** - Rich text descriptions with preview
- ♻️ **Reusable Lists** - Duplicate tasks or reset checklists
- ✅ **Checklist Mode** - Fast list-style checking for checklist tasks
- 🧭 **Copilot Suggestions** - Optional context/tag/time hints while typing
- 🔔 **Notifications** - Due date reminders with snooze
- 📊 **Daily Digest** - Morning briefing + evening review
- 📅 **Weekly Review** - Customizable weekly reminder

### Data & Sync
- 📁 **File Sync** - Dropbox, Google Drive, Syncthing, etc.
- 🌐 **WebDAV Sync** - Nextcloud, ownCloud, self-hosted
- ☁️ **Cloud Sync** - Self-hosted cloud backend
- 🔀 **Smart Merge** - Last-write-wins prevents data loss
- 📤 **Export/Backup** - Export data to JSON
- 🗓️ **External Calendars (ICS)** - View-only calendar overlay

### Automation
- 🔌 **CLI** - Add, list, complete, search from terminal
- 🌐 **REST API** - Local API server for scripting
- 🌍 **Web App (PWA)** - Browser access with offline support

### Cross-Platform
- 🖥️ **Desktop** - Tauri v2 (macOS, Linux, Windows)
- 📱 **Mobile** - React Native/Expo (~iOS~, Android)
- 📲 **Android Widget** - Home screen focus/next widget
- ⌨️ **Keyboard Shortcuts** - Vim and Emacs presets
- 🎨 **Themes** - Light/Dark
- 🌍 **i18n** - English and Chinese

## Installation

### Desktop (Linux)

**Arch Linux (AUR):**
```bash
# Using yay
yay -S mindwtr-bin

# Using paru
paru -S mindwtr-bin
```
📦 [AUR Package](https://aur.archlinux.org/packages/mindwtr-bin)

**Debian/Ubuntu:**
Download the `.deb` from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) and install:
```bash
sudo dpkg -i mindwtr_*.deb
```

**AppImage (Universal):**
Download the `.AppImage` from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases):
```bash
chmod +x Mindwtr_*.AppImage
./Mindwtr_*.AppImage
```

**Fedora/RHEL/openSUSE:**
Download the `.rpm` from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) and install:
```bash
sudo rpm -i mindwtr-*.rpm
```

### Desktop (Windows)
Download the installer (`.msi` or `.exe`) from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) and run it.

### Desktop (macOS)
Download the disk image (`.dmg`) from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases), open it, and drag the application to your Applications folder.

> **Note:** If macOS says the app is "damaged" or from an "unidentified developer", run:
> ```bash
> xattr -cr /Applications/Mindwtr.app
> ```
> Then open the app normally. This is required because the app is not notarized with Apple.

### Mobile

**Android:**
Download the APK from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases).

**iOS:**
iOS builds require an Apple Developer account ($99/year). Currently available as simulator builds only. If you want iOS builds, please consider [sponsoring the developer](https://github.com/sponsors/dongdongbh) so we can fund the Apple Developer account.

## Data Storage

Tasks and projects are stored locally on your device:
- **Desktop data (Linux)**: `~/.local/share/mindwtr/data.json`
- **Desktop config (Linux)**: `~/.config/mindwtr/config.toml`
- **Mobile**: Device storage (AsyncStorage)

Sync via File (Dropbox, etc.), WebDAV (Nextcloud, etc.), or Cloud can be configured in Settings.

## Documentation

- 📚 [Wiki](https://github.com/dongdongbh/Mindwtr/wiki) - Complete user guide
- 🚀 [Getting Started](https://github.com/dongdongbh/Mindwtr/wiki/Getting-Started)
- 💡 [GTD Best Practices](https://github.com/dongdongbh/Mindwtr/wiki/GTD-Best-Practices)
- 🤖 [AI Assistant](https://github.com/dongdongbh/Mindwtr/wiki/AI-Assistant)
- 🗓️ [Calendar Integration](https://github.com/dongdongbh/Mindwtr/wiki/Calendar-Integration)
- ☁️ [Cloud Sync (Self‑Hosted)](https://github.com/dongdongbh/Mindwtr/wiki/Cloud-Sync)
- 🔌 [Local API Server](https://github.com/dongdongbh/Mindwtr/wiki/Local-API)
- 🌐 [Web / PWA](https://github.com/dongdongbh/Mindwtr/wiki/Web-App-PWA)

## Development

For developers, see the [Development Guide](docs/development.md).
