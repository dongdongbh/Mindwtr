<div align="center">

<img src="https://raw.githubusercontent.com/dongdongbh/Mindwtr/main/apps/mobile/assets/images/icon.png" width="120" alt="Mindwtr Logo">

# Mindwtr Wiki

**A complete Getting Things Done (GTD) productivity system for desktop and mobile.**

*Mind Like Water*

[![GitHub](https://img.shields.io/badge/GitHub-Mindwtr-blue?logo=github)](https://github.com/dongdongbh/Mindwtr)
[![License](https://img.shields.io/badge/License-AGPL%20v3-blue)](https://github.com/dongdongbh/Mindwtr/blob/main/LICENSE)

</div>

---

## 🧠 Design Philosophy

Mindwtr is **simple by default and powerful when needed**. We focus on reducing cognitive load, cutting the fat, and keeping you in flow.

- **Progressive disclosure** keeps advanced controls out of sight until you need them.
- **Less by default** means fewer fields and fewer distractions.
- **Avoid feature creep** so the UI stays calm and purposeful.

*Don’t show me a cockpit when I just want to ride a bike.*

## 📚 Table of Contents

### Getting Started
- [[Getting Started]] — Quick installation and first steps
- [[FAQ]] — Frequently asked questions

### User Guides
- [[User Guide Desktop]] — Complete desktop app documentation
  - [[Desktop Installation]] — Install on Linux, Windows, macOS
  - Keyboard shortcuts now live in [[User Guide Desktop]]
- [[User Guide Mobile]] — Complete mobile app documentation
  - [[Mobile Installation]] — Install on Android and iOS (App Store/TestFlight)
- [[Pomodoro Focus]] — Optional deep-work timer in Focus view
- [[Docker Deployment]] — Run PWA and Cloud Server with Docker

### GTD Methodology
- [[GTD Overview]] — Introduction to Getting Things Done
- [[GTD Best Practices]] — Master the GTD methodology
- [[GTD Workflow in Mindwtr]] — How to implement GTD with this app
- [[Contexts and Tags]] — Location and energy-based contexts
- [[Weekly Review]] — Step-by-step review process

### Data & Sync
- [[Data and Sync]] — Storage locations and sync setup
- [[iCloud Sync]] — Native Apple-only iCloud / CloudKit backend
- [[Sync Algorithm]] — Conflict rules, tombstones, and merge behavior
- Self-hosted cloud setup is split between [[Data and Sync]] (client setup) and [[Cloud Deployment]] (server operations)
- [[Dropbox Sync]] — Native Dropbox OAuth sync setup
- [[Cloud Deployment]] — Cloud deployment and operations runbook
- [[Obsidian Integration]] — Desktop vault import and deep links
- [[Calendar Integration]] — External calendars (ICS)
- [[AI Assistant]] — Optional BYOK assistant
- [[Reusable Lists]] — Templates and checklist reset
- [[Attachments]] — Files, links, and audio notes
- [[Diagnostics and Logs]] — Debug logging and log locations

### Developer Documentation
- [[Developer Guide]] — Development setup and overview
- [[Architecture]] — Technical architecture and design
- [[Core API]] — `@mindwtr/core` package documentation
- [[MCP Server]] — Local MCP server setup and tool usage
- [[Deployment Guide]] — Platform deployment entry points
- [[Performance Guide]] — Performance-focused implementation notes
- [Release Notes (Repository)](https://github.com/dongdongbh/Mindwtr/tree/main/docs/release-notes) — Version-by-version release notes
- [Contributing (Repository Guide)](https://github.com/dongdongbh/Mindwtr/blob/main/docs/CONTRIBUTING.md) — How to contribute to Mindwtr

---

## ✨ Key Features

| Feature               | Description                                        |
| --------------------- | -------------------------------------------------- |
| 📥 **Inbox**           | Capture everything with quick-add                  |
| 🎯 **Focus**           | Combined daily agenda and next actions             |
| 🍅 **Pomodoro Focus**  | Optional task-linked focus/break timer in Focus view |
| 📁 **Projects**        | Multi-step outcomes with sequential/parallel modes |
| 🧭 **Areas of Focus**  | Group projects by higher-level areas               |
| 🏷️ **Contexts & Tags** | @home, @work, #focused, #lowenergy                 |
| 📋 **Board View**      | Kanban-style drag-and-drop                         |
| 📅 **Calendar**        | Time-based planning + external calendars (ICS)     |
| 📋 **Weekly Review**   | Guided GTD review wizard                           |
| 🔁 **Recurring Tasks** | Daily/weekly/monthly + completion-based            |
| 📎 **Attachments**     | Files, links, and audio notes                      |
| 🎙️ **Audio Capture**   | Voice-to-text with local Whisper or Cloud AI       |
| 🤖 **AI Assistant**    | Clarify, break down, review (optional)             |
| 🧩 **Copilot**         | Context/tag/time suggestions while typing          |
| ♻️ **Reusable Lists**  | Duplicate projects or reset checklists             |
| 🔄 **Sync Options**    | iCloud (Apple), File, WebDAV, Cloud, Local API     |
| 📲 **Android Widget**  | Home screen focus/next widget                      |
| 🌐 **Web App (PWA)**   | Offline-capable browser version                    |
| 🌍 **i18n**            | EN, 中文, ES, HI, AR, DE, RU, JA, FR, PT, PL, KO, IT, TR, NL |
| 🖥️ **Cross-Platform**  | Desktop (Tauri) + Mobile (React Native)            |

## 📱 Feature Parity Matrix

| Feature | Desktop (Tauri) | Mobile (React Native) |
| :--- | :---: | :---: |
| **Core GTD Views** | ✅ | ✅ |
| **Inbox & Capture** | ✅ (Global Hotkey) | ✅ (Share Sheet, Widget) |
| **Focus View** | ✅ (Top 3 + Next) | ✅ (Zen Mode) |
| **Projects** | ✅ | ✅ |
| **Areas of Focus** | ✅ | ✅ |
| **Contexts & Tags** | ✅ | ✅ |
| **Board View (Kanban)** | ✅ | ✅ |
| **Calendar View** | ✅ | ✅ |
| **Weekly Review** | ✅ | ✅ |
| **Focus/Zen Mode** | ✅ (Sidebar toggle + Top 3) | ✅ (Zen toggle) |
| **Pomodoro Focus** | ✅ (Optional in Focus) | ✅ (Optional in Focus) |
| **Notifications** | ✅ | ✅ |
| **Widgets** | ❌ | ✅ (Android) |
| **Global Hotkey** | ✅ | ❌ |
| **Share Sheet** | ❌ | ✅ |
| **Keyboard Shortcuts** | ✅ (Vim/Emacs) | ❌ |
| **File Sync** | ✅ | ✅ |
| **WebDAV Sync** | ✅ | ✅ |
| **External Calendars (ICS)** | ✅ | ✅ |
| **Audio Capture** | ✅ (Whisper/Cloud) | ✅ |
| **AI Assistant** | ✅ | ✅ |

---

## 🚀 Quick Links

- **New to GTD?** Start with [[GTD Overview]]
- **Installing the app?** See [[Getting Started]]
- **Want to contribute?** Check [[Developer Guide]]
- **Latest release:** [v0.7.6 notes](https://github.com/dongdongbh/Mindwtr/blob/main/docs/release-notes/0.7.6.md)

---

## Google Play

Mindwtr is available on Google Play:
https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr

## App Store (iOS)

Mindwtr is available on the Apple App Store:
https://apps.apple.com/app/mindwtr/id6758597144

<div align="center">

*Built with ❤️ by [dongdongbh](https://dongdongbh.tech)*

</div>
