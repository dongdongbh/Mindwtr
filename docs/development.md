# Development Guide

This document covers development setup and project structure for contributors.

## Quick Start

```bash
# Install dependencies
bun install

# Run desktop app
bun desktop:dev

# Run mobile app
bun mobile:start
```

## Project Structure

```
Mindwtr/
├── apps/
│   ├── desktop/     # Tauri v2 + React + Vite
│   └── mobile/      # Expo + React Native + NativeWind
├── packages/
│   └── core/        # Shared business logic (Zustand store)
├── docs/            # Documentation
└── package.json     # Monorepo root
```

## Tech Stack

| Layer     | Desktop          | Mobile                |
| --------- | ---------------- | --------------------- |
| Framework | React + Vite     | React Native + Expo   |
| Styling   | Tailwind CSS     | NativeWind (Tailwind) |
| State     | Zustand (shared) | Zustand (shared)      |
| Platform  | Tauri v2 (Rust)  | iOS/Android           |

## Data Storage

Tasks and projects are stored locally:
- **Desktop data (Linux)**: `~/.local/share/mindwtr/data.json`
- **Desktop config (Linux)**: `~/.config/mindwtr/config.toml`
- **Mobile**: AsyncStorage

Optional sync folder (e.g., Dropbox, Syncthing) can be configured in Settings for cross-device sync.
Default sync folder: `~/Sync/mindwtr/`

## App READMEs

- [Desktop App](../apps/desktop/README.md)
- [Mobile App](../apps/mobile/README.md)

## Additional Documentation

- [Cloud Sync (Self‑Hosted)](cloud-sync.md) - Run and deploy the cloud backend
- [Local API Server](api.md) - REST API for automation and scripting
- [Web / PWA](pwa.md) - Build and host the desktop web/PWA
- [Mobile URL Polyfill](mobile-url-polyfill.md) - Critical polyfill documentation
- [Desktop Keybindings](desktop-keybindings.md) - Vim/Emacs presets and shortcuts
- [GTD Best Practices](gtd-best-practices.md) - GTD methodology reference
- [AI Assistant](ai-assistant.md) - BYOK AI assistant and copilot
- [Reusable Lists](reusable-lists.md) - Task templates and checklist reset
- [Calendar Integration](calendar-integration.md) - External calendars (ICS)
