<div align="center">

<img src="apps/mobile/assets/images/icon.png" width="120" alt="Mindwtr Logo">

# Mindwtr

English | [中文](./README_zh.md)

The free, open-source, cross-platform GTD app. Local-first, no account required. _Mind Like Water._

_New to GTD? Read [GTD in 15 minutes](https://hamberg.no/gtd) for a quick introduction._

[Install](#installation) · [Getting Started](https://github.com/dongdongbh/Mindwtr/wiki/Getting-Started) · [Data & Sync](https://github.com/dongdongbh/Mindwtr/wiki/Data-and-Sync) · [Cloud Sync](https://github.com/dongdongbh/Mindwtr/wiki/Cloud-Sync) · [MCP Server](https://github.com/dongdongbh/Mindwtr/wiki/MCP-Server)

[![CI](https://github.com/dongdongbh/Mindwtr/actions/workflows/ci.yml/badge.svg)](https://github.com/dongdongbh/Mindwtr/actions/workflows/ci.yml)
[![GitHub license](https://img.shields.io/github/license/dongdongbh/Mindwtr?color=brightgreen)](LICENSE)
[![GitHub downloads](https://img.shields.io/github/downloads/dongdongbh/Mindwtr/total)](https://github.com/dongdongbh/Mindwtr/releases)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/dongdongbh/Mindwtr)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/ahhFxuDBb4)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-ff5f5f?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/dongdongbh)
[![Ko-fi](https://img.shields.io/badge/Sponsor-Ko--fi-29abe0?logo=kofi&logoColor=white)](https://ko-fi.com/D1D01T20WK)

<p align="center" style="text-align: center;">
  <a href="https://apps.microsoft.com/detail/9n0v5b0b6frx?ocid=webpdpshare" target="_blank">
    <img src="https://developer.microsoft.com/store/badges/images/English_get-it-from-MS.png"
         align="center"
         alt="Microsoft Store"
         style="height: 50px"
         height="50" />
  </a>
  <a href="https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr" target="_blank">
    <img src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png"
         align="center"
         alt="Google Play"
         style="height: 56px"
         height="56" />
  </a>
  <a href="https://apps.apple.com/app/mindwtr/id6758597144" target="_blank">
    <img src="https://tools.applemediaservices.com/api/badges/download-on-the-app-store/black/en-us?size=250x83"
         align="center"
         alt="App Store"
         style="height: 50px"
         height="50" />
  </a>
  <a href="https://apt.izzysoft.de/fdroid/index/apk/tech.dongdongbh.mindwtr" target="_blank">
    <img src="https://gitlab.com/IzzyOnDroid/repo/-/raw/master/assets/IzzyOnDroidButtonGreyBorder_nofont.png"
         align="center"
         alt="Get it on IzzyOnDroid"
         style="height: 50px"
         height="50" />
  </a>
  <a href="https://flathub.org/apps/tech.dongdongbh.mindwtr" target="_blank">
    <img alt="Get it on Flathub"
         src="https://flathub.org/api/badge?locale=en"
         align="center"
         style="height: 50px"
         height="50" />
  </a>
</p>

</div>

<div align="center">
  <video src="https://github.com/user-attachments/assets/8b067635-196e-4c9c-ad26-92ca92fef327" width="60%" autoplay loop muted playsinline></video>
  
  <video src="https://github.com/user-attachments/assets/08e4f821-0b1c-44f9-af58-0b727bc2bd91" width="25%" autoplay loop muted playsinline></video>

  <p>
    <i>Local-First GTD on Arch Linux & Android</i>
  </p>
</div>

## Why Mindwtr (Quick Comparison)

Mindwtr is built for people who want a complete GTD system without lock-in. Here is a brief, respectful comparison with mainstream task apps and GTD-focused alternatives.

| Capability                                                        | Mindwtr | Todoist | TickTick | Everdo | NirvanaHQ |
| ----------------------------------------------------------------- | ------- | ------- | -------- | ------ | --------- |
| Open source                                                       | ✅      | ❌      | ❌       | ❌     | ❌        |
| GTD-native workflow                                               | ✅      | ⚠️      | ⚠️       | ✅     | ✅        |
| All major platforms (desktop + mobile + web, incl. Linux desktop) | ✅      | ✅      | ✅       | ⚠️     | ⚠️        |
| Local-first + no account required                                 | ✅      | ❌      | ❌       | ✅     | ❌        |
| AI assistant (BYOK + local LLM)                                   | ✅      | ❌      | ❌       | ❌     | ❌        |
| Flexible sync (WebDAV / Dropbox / self-hosted / local file)       | ✅      | ❌      | ❌       | ⚠️     | ❌        |
| Completely free                                                   | ✅      | ❌      | ❌       | ❌     | ❌        |

Legend: `✅` = yes, `❌` = no, `⚠️` = partial/limited support.

_This comparison is based on the current public capabilities of each product. If any entry is outdated, feel free to open an issue or PR with sources._

## Philosophy

Mindwtr is built to be **simple by default and powerful when you need it**. We focus on reducing cognitive load, cutting the fat, and keeping you in flow. That means:

- **Progressive disclosure**: advanced options stay hidden until they matter.
- **Less by default**: fewer fields, fewer knobs, fewer distractions.
- **Avoid feature creep**: we prioritize clarity over clutter.

_Don't show me a cockpit when I just want to ride a bike._

## Features

- GTD workflow end-to-end: Capture, Clarify, Organize, Reflect, Engage.
- Focus view combines time-based agenda with next actions.
- Local-first data model with native iCloud / CloudKit sync on supported Apple builds, plus file sync, WebDAV, Dropbox, and self-hosted cloud options.
- Projects support sections and areas for larger multi-step planning.
- Obsidian vault import with note deep links on desktop.
- Optional AI copilot (BYOK + local/self-hosted compatible models).
- Cross-platform apps for desktop and mobile, plus PWA.
- Built-in automation with CLI, REST API, and MCP server.

<details>
<summary>See all features</summary>

### GTD Workflow

- **Capture** - Quick add tasks from anywhere (global hotkey, tray, share sheet, voice)
- **Clarify** - Guided inbox processing with 2-minute rule
- **Organize** - Projects, sections, contexts, and status lists
- **Reflect** - Weekly review wizard with reminders
- **Engage** - Context-filtered next actions
- **AI Assist (Optional)** - Clarify, break down, and review with BYOK AI (OpenAI, Gemini, Claude, or local/self-hosted OpenAI-compatible LLMs)

### Views

- 📥 **Inbox** - Capture zone with processing wizard
- 🎯 **Focus** - Agenda (time-based) + Next Actions in one view
- 📁 **Projects** - Multi-step outcomes with sections and areas
- 🏷️ **Contexts** - Slash-delimited contexts with parent matching (@work/meetings)
- ⏳ **Waiting For** - Delegated items
- 💭 **Someday/Maybe** - Deferred ideas
- 📅 **Calendar** - Time-based planning
- 📋 **Board** - Kanban-style drag-and-drop
- 📝 **Review** - Daily + weekly review workflows
- 📦 **Archived** - Hidden history, searchable when needed

### Productivity Features

- 🔍 **Global Search** - Search operators (status:, context:, due:<=7d)
- 📦 **Bulk Actions** - Multi-select, batch move/tag/delete
- 📎 **Attachments** - Files and links on tasks
- ✏️ **Markdown Notes** - Rich text descriptions with preview
- 🗂️ **Project States** - Active, Waiting, Someday, Archived
- ♾️ **Fluid Recurrence** - Next date is calculated after completion
- ♻️ **Reusable Lists** - Duplicate tasks or reset checklists
- ✅ **Checklist Mode** - Fast list-style checking for checklist tasks
- ✅ **Audio Capture** - Quick voice capture with automatic transcription and task creation
- 🧭 **Copilot Suggestions** - Optional context/tag/time hints while typing
- 🍅 **Pomodoro Focus (Optional)** - 15/3, 25/5, 50/10 timer panel in Focus view
- 🔔 **Notifications** - Due date reminders with snooze
- 📊 **Daily Digest** - Morning briefing + evening review
- 📅 **Weekly Review** - Customizable weekly reminder

### Data & Sync

- 🔄 **Sync Options** - See the [Data & Sync wiki](https://github.com/dongdongbh/Mindwtr/wiki/Data-and-Sync) for supported backends and setup
- 🍎 **Native iCloud / CloudKit Sync** - Apple-only structured sync on supported iPhone, iPad, and macOS builds
- ☁️ **Dropbox OAuth Sync (Optional)** - Native Dropbox App Folder sync in supported non-FOSS builds
- 📤 **Export/Backup** - Export data to JSON
- ♻️ **Restore from Backup** - Replace local data from a validated Mindwtr backup with a recovery snapshot first
- 📥 **Todoist + DGT GTD Import** - Import Todoist CSV/ZIP exports or DGT GTD JSON/ZIP exports into Mindwtr
- 🔗 **Obsidian Integration** - Desktop vault task import with deep links back to source notes
- 🗓️ **External Calendars (System + ICS)** - Mobile reads system calendars; desktop supports ICS subscriptions

### Automation

- 🔌 **CLI** - Add, list, complete, search from terminal
- 🌐 **REST API** - Local API server for scripting
- 🌍 **Web App (PWA)** - Browser access with offline support
- 🧠 **MCP Server** - Local Model Context Protocol server for LLM automation

### Cross-Platform

- 🖥️ **Desktop** - Tauri v2 (macOS, Linux, Windows)
- 📱 **Mobile** - React Native/Expo (iOS via App Store/TestFlight, Android)
- 📲 **Android Widget** - Home screen focus/next widget
- ⌨️ **Keyboard Shortcuts** - Vim and Emacs presets
- 🎨 **Themes** - Light/Dark
- 🌍 **i18n** - English, Chinese (Simplified), Chinese (Traditional), Spanish, Hindi, Arabic, German, Russian, Japanese, French, Portuguese, Polish, Korean, Italian, Turkish, Dutch
- 🐳 **Docker** - Run the PWA + self-hosted sync server with Docker

</details>

## Installation

### Desktop (Linux)

**Arch Linux (AUR, prebuilt recommended):**
<a href="https://aur.archlinux.org/packages/mindwtr-bin">
<img src="https://img.shields.io/aur/version/mindwtr-bin?logo=arch-linux&logoColor=white&color=1793d1&label=mindwtr-bin" alt="AUR mindwtr-bin Version">
</a>

```bash
# Using yay
yay -S mindwtr-bin

# Using paru
paru -S mindwtr-bin
```

**Arch Linux (AUR, build from source):**
<a href="https://aur.archlinux.org/packages/mindwtr">
<img src="https://img.shields.io/aur/version/mindwtr?logo=arch-linux&logoColor=white&color=1793d1&label=mindwtr" alt="AUR mindwtr Version">
</a>

```bash
# Using yay
yay -S mindwtr

# Using paru
paru -S mindwtr
```

**Debian / Ubuntu (APT repo, recommended):**

```bash
curl -fsSL https://dongdongbh.github.io/Mindwtr/mindwtr.gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/mindwtr-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/mindwtr-archive-keyring.gpg] https://dongdongbh.github.io/Mindwtr/deb ./" | sudo tee /etc/apt/sources.list.d/mindwtr.list
sudo apt update
sudo apt install mindwtr
```

**Fedora / RHEL / openSUSE (DNF/YUM repo, recommended):**

```bash
cat <<'EOF' | sudo tee /etc/yum.repos.d/mindwtr.repo
[mindwtr]
name=Mindwtr Repository
baseurl=https://dongdongbh.github.io/Mindwtr/rpm
enabled=1
gpgcheck=0
EOF

sudo dnf install mindwtr
```

**Flatpak (Flathub):**
<a href="https://flathub.org/apps/tech.dongdongbh.mindwtr">
<img src="https://img.shields.io/badge/Flathub-Install-000000?logo=flathub&logoColor=white" alt="Get it on Flathub">
</a>

```bash
flatpak install flathub tech.dongdongbh.mindwtr
```

**Other methods:** AppImage or `.deb`/`.rpm` from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases).

### Desktop (Windows)

**Microsoft Store (recommended):**
<a href="https://apps.microsoft.com/detail/9n0v5b0b6frx?ocid=webpdpshare">
<img src="https://img.shields.io/badge/Microsoft_Store-Install-0078D6?logo=microsoft&logoColor=white" alt="Microsoft Store">
</a>

**Winget:**
<a href="https://winstall.app/apps/dongdongbh.Mindwtr">
<img src="https://img.shields.io/winget/v/dongdongbh.Mindwtr?label=Winget&logo=windows&logoColor=white&color=00D2FF" alt="Winget Version">
</a>

```powershell
winget install dongdongbh.Mindwtr
```

**Scoop:**
<a href="https://github.com/dongdongbh/homebrew-mindwtr">
<img src="https://img.shields.io/scoop/v/mindwtr?bucket=https://github.com/dongdongbh/homebrew-mindwtr&label=Scoop&logo=scoop&logoColor=white&color=E6E6E6" alt="Scoop Version">
</a>

```powershell
scoop bucket add mindwtr https://github.com/dongdongbh/homebrew-mindwtr
scoop install mindwtr
```

**Portable ZIP (no admin required):**

- Download `mindwtr_<version>_windows_x64_portable.zip` from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases).
- Extract it to a writable folder and keep `portable.txt` next to `mindwtr.exe`.
- Mindwtr stores data under `profile/` in the extracted folder.

**Other methods:** installer `.exe` from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases).

### Desktop (macOS)

**Mac App Store (recommended):**
<a href="https://apps.apple.com/app/mindwtr/id6758597144">
<img src="https://img.shields.io/badge/Mac_App_Store-Install-0A84FF?logo=apple&logoColor=white" alt="Mac App Store">
</a>

Install from the Mac App Store: [Mindwtr on Mac App Store](https://apps.apple.com/app/mindwtr/id6758597144).
TestFlight beta (macOS): [Join the beta](https://testflight.apple.com/join/7SMJCTSR).

**Homebrew:**
<a href="https://formulae.brew.sh/cask/mindwtr">
<img src="https://img.shields.io/homebrew/cask/v/mindwtr?label=Homebrew&logo=homebrew&logoColor=white" alt="Homebrew Cask Version">
</a>

```bash
brew install --cask mindwtr
```

**Other methods:** `.dmg` from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases).

### Mobile

**Android:**
<a href="https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr">
<img src="https://img.shields.io/badge/Google_Play-Install-414141?logo=googleplay&logoColor=white" alt="Get it on Google Play">
</a>
<a href="https://apt.izzysoft.de/fdroid/index/apk/tech.dongdongbh.mindwtr">
<img src="https://img.shields.io/endpoint?url=https://apt.izzysoft.de/fdroid/api/v1/shield/tech.dongdongbh.mindwtr&label=IzzyOnDroid" alt="IzzyOnDroid">
</a>

Install with IzzyOnDroid:

1. Install an F-Droid-compatible client (Droid-ify, Neo Store, or F-Droid).
2. Add the IzzyOnDroid repository: `https://apt.izzysoft.de/fdroid/repo`.
3. Open [Mindwtr on IzzyOnDroid](https://apt.izzysoft.de/fdroid/index/apk/tech.dongdongbh.mindwtr) and install.

Other methods: APK from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases).

**iOS:**
<a href="https://apps.apple.com/app/mindwtr/id6758597144">
<img src="https://img.shields.io/badge/App_Store-iOS-0A84FF?logo=apple&logoColor=white" alt="App Store">
</a>

Available on the App Store: [Mindwtr for iOS](https://apps.apple.com/app/mindwtr/id6758597144).
TestFlight beta: [Join the beta](https://testflight.apple.com/join/7SMJCTSR).

However, maintaining the iOS version on the App Store requires a substantial annual fee (see the [Apple Developer Program](https://developer.apple.com/support/enrollment/)), which I currently cover out of pocket.

To ensure Mindwtr's continued existence and future development, your support is greatly appreciated! If you find value in the app, please consider supporting the project via [GitHub Sponsors](https://github.com/sponsors/dongdongbh) or [Ko-fi](https://ko-fi.com/D1D01T20WK).

### Docker (PWA + Cloud Sync)

Run the web app (PWA) and the self-hosted sync server with Docker:

- Guide: [`docker/README.md`](docker/README.md)

Install guides: 🚀 [Getting Started](https://github.com/dongdongbh/Mindwtr/wiki/Getting-Started)

## Community

Mindwtr is shaped by its users and contributors. Thank you for helping improve it.

### :hearts: Contributing & Support

If you want to get involved, start with [CONTRIBUTING.md](docs/CONTRIBUTING.md).

You can help in several ways:

1. **Spread the word:** Share Mindwtr with friends and communities, and support it on [Product Hunt](https://www.producthunt.com/products/mindwtr) and [AlternativeTo](https://alternativeto.net/software/mindwtr/).
2. **Leave store reviews:** A good rating/review on the [App Store](https://apps.apple.com/app/mindwtr/id6758597144), [Google Play](https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr), or [Microsoft Store](https://apps.microsoft.com/detail/9n0v5b0b6frx?ocid=webpdpshare) helps a lot.
3. **Star and share:** Star the repo and post about Mindwtr on [X](https://twitter.com/intent/tweet?text=I%20like%20Mindwtr%20https%3A%2F%2Fgithub.com%2Fdongdongbh%2FMindwtr), [Reddit](https://www.reddit.com/submit?url=https%3A%2F%2Fgithub.com%2Fdongdongbh%2FMindwtr&title=I%20like%20Mindwtr), or [LinkedIn](https://www.linkedin.com/shareArticle?mini=true&url=https%3A%2F%2Fgithub.com%2Fdongdongbh%2FMindwtr&title=I%20like%20Mindwtr).
4. **Report bugs and request features:** Open issues on [GitHub Issues](https://github.com/dongdongbh/Mindwtr/issues).
5. **Join the community chat:** Come to [Discord](https://discord.gg/ahhFxuDBb4).
6. **Help with translations:** Contribute locale updates in [`packages/core/src/i18n/locales/`](packages/core/src/i18n/locales/).
7. **Contribute code/docs:** Open a pull request and follow the [contribution guide](docs/CONTRIBUTING.md) and commit conventions.
8. **Pick and build:** Community members are welcome to pick any item in the [Roadmap](#roadmap) or any open issue and submit a PR.
9. **Sponsor the project:** Support ongoing development via [GitHub Sponsors](https://github.com/sponsors/dongdongbh) or [Ko-fi](https://ko-fi.com/D1D01T20WK).

## Roadmap

- 🤖 Add to F-Droid ([#219](https://github.com/dongdongbh/Mindwtr/issues/219))
- ✉️ Email to Inbox ([#35](https://github.com/dongdongbh/Mindwtr/issues/35))
- 🗓️ One-way Mindwtr -> external calendar export/sync ([#361](https://github.com/dongdongbh/Mindwtr/issues/361))

## Documentation

- 📚 [Wiki](https://github.com/dongdongbh/Mindwtr/wiki) - Complete user guide
- 🚀 [Getting Started](https://github.com/dongdongbh/Mindwtr/wiki/Getting-Started)
- ❓ [FAQ](https://github.com/dongdongbh/Mindwtr/wiki/FAQ)
- 🔄 [Data & Sync](https://github.com/dongdongbh/Mindwtr/wiki/Data-and-Sync)
- 🔗 [Markdown Links](https://github.com/dongdongbh/Mindwtr/wiki/Markdown-Links)
- ☁️ [Cloud Sync](https://github.com/dongdongbh/Mindwtr/wiki/Cloud-Sync)
- 🛠️ [Cloud Deployment](https://github.com/dongdongbh/Mindwtr/wiki/Cloud-Deployment)
- 🧠 [MCP Server](https://github.com/dongdongbh/Mindwtr/wiki/MCP-Server)
- 📝 [Release Notes Index](docs/release-notes/README.md)

## Sponsors

Thanks to these monthly sponsors for supporting Mindwtr.

<p align="center">
  <a href="https://github.com/jarrydstan" title="@jarrydstan">
    <img src="docs/assets/sponsors/jarrydstan.png" width="60" height="60" alt="@jarrydstan" />
  </a>
  <a href="https://github.com/ronmolenda" title="@ronmolenda">
    <img src="docs/assets/sponsors/ronmolenda.png" width="60" height="60" alt="@ronmolenda" />
  </a>
  <a href="https://github.com/laripernu" title="@laripernu">
    <img src="docs/assets/sponsors/laripernu.png" width="60" height="60" alt="@laripernu" />
  </a>
  <a href="https://github.com/karl1990" title="@karl1990">
    <img src="docs/assets/sponsors/karl1990.png" width="60" height="60" alt="@karl1990" />
  </a>
</p>

<p align="center">
  <sub><a href="https://github.com/jarrydstan">@jarrydstan</a> · <a href="https://github.com/ronmolenda">@ronmolenda</a> · <a href="https://github.com/laripernu">@laripernu</a> · <a href="https://github.com/karl1990">@karl1990</a></sub>
</p>
