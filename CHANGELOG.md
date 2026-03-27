# Changelog

All notable changes to Mindwtr will be documented in this file.

## [Unreleased]

## [0.7.7] - 2026-03-26

### Fixed
- **Cloud auth**: Prevented auth-failure rate limiting from collapsing unrelated clients into a shared bucket when proxy headers are not trusted.
- **Docker deploys**: Require explicit cloud auth tokens, pin Bun image tags, add compose resource limits, and harden container health checks.
- **Desktop sync**: Pause blur-triggered sync during task edits, always release offline listeners after sync failures, and guard native system-theme watcher cleanup.
- **Core merge**: Preserve ordering between two clamped future timestamps and lock current SQLite project-delete cascade behavior with regression coverage.
- **Mobile reliability**: Restored the task editor project field, hardened Android/OpenAI speech-to-text flows, and cleared stale mobile sync conflict stats after later sync errors.
- **MCP**: Cap `quickAdd` input length and align add-task quick-add validation with trimmed input handling.

### Changed
- **Desktop polish**: React to system theme changes more reliably, improve Obsidian scan compatibility, and detect Flathub analytics installs more accurately.
- **Docs & release tooling**: Clarified Docker cloud API support, refreshed sync docs, corrected French labels, and updated release automation checks.

## [0.7.4] - 2026-03-16

### Added
- **Apple Sync**: Added native iCloud sync on supported Apple mobile builds.
- **Desktop Obsidian**: Added an Obsidian vault workspace for reviewing imported tasks.
- **Mobile Triage**: Added a global area switcher, time estimate filters, and daily-review focus toggles.

### Changed
- **Sync Reliability**: Hardened merge handling, missing-file attachment status tracking, and self-hosted cloud request limits/timeouts.
- **Desktop UX**: Improved Projects, Contexts, and Obsidian layouts plus sync-status accessibility.
- **Release Tooling**: Updated release workflows, documentation, and Node 24 compatibility work.

### Notes
- Intermediate patch releases in this line are documented in [docs/release-notes](docs/release-notes/README.md): `0.7.1` to `0.7.3`.

## [0.7.0] - 2026-02-28

### Changed
- **Attachments & Sync**: Fixed stale attachment-reference edge cases and made attachment validation/unrecoverable handling safer.
- **Conflict Handling**: Refined delete-vs-edit merge behavior so newer edits survive while ties remain deterministic.
- **CI & Release**: Hardened artifact validation and release automation defaults.

### Notes
- See [docs/release-notes](docs/release-notes/README.md) for the full `0.7.x` release line.

## [0.6.0] - 2026-01-25

### Added
- **Desktop UX**: Added toast notifications, clearer loading/disabled states, and unsaved-edit warnings.
- **Docs**: Added architecture, CLI/API, and MCP documentation coverage.

### Changed
- **Sync Safety**: Improved conflict visibility, timestamp normalization logging, and sync write coalescing safety.
- **Core Performance**: Added paginated SQLite loads and safer FTS rebuild locking.
- **Cloud**: Improved server logging and cache pruning.

### Notes
- Intermediate patch releases in this line are documented in [docs/release-notes](docs/release-notes/README.md): `0.6.1` to `0.6.22`.

## [0.5.7] - 2026-01-21

### Added
- **Project Sections**: Added section headers, notes, and drag-and-drop ordering inside projects.
- **Mobile Parity**: Added section selection and section-aware grouping on mobile.
- **Core Storage**: Added section sync/storage support and related tests.

## [0.5.6] - 2026-01-18

### Added
- **Desktop Focus**: Reused shared task rows with inline edit and a details/compact toggle.
- **Deferred Projects**: Show area labels and a Reactivate action in Someday/Waiting lists.
- **Mobile Someday/Waiting**: Show deferred projects alongside tasks, with swipe-to-activate and tap-to-open.

### Changed
- **Tasks**: Reference status clears action-related fields (dates, priority, recurrence).

## [0.5.0] - 2026-01-09

### Features
- **Themes**: Added E‑Ink, Nord, and Sepia themes on desktop; expanded mobile theme picker with Material 3 Light/Dark, E‑Ink, Nord, Sepia, and OLED (Midnight).

### Changed
- **Mobile UI**: Navigation headers and bars now follow the active theme.
- **Projects**: Mobile project list actions now use a trash icon and place reorder on the right.

### Security
- **AI keys**: Stored in secure storage on mobile and native config on desktop.

## [0.4.2] - 2025-12-31

### Features
- **Priority**: Added task priority metadata and badges across desktop and mobile.
- **Filtering**: Added multi-criteria filters (contexts/tags, priority, time estimate) for Next/Agenda on desktop and mobile.
- **Board/Projects**: Added project filters on the desktop board and area filters on the projects page.

### Changed
- **Windowing**: Sync native title bar theme with app theme; hide decorations on Linux with F11 fullscreen toggle.

### Fixed
- **Desktop**: `e` now opens the selected task editor in list views.
- **Dependencies**: "Blocked by" now only shows tasks from the same project.

## [0.3.1] - 2025-12-12

### Features
- **Cloud Sync**: Added a simple self-hosted cloud backend and a Cloud sync option in-app.
- **Web/PWA**: Added PWA assets (manifest + service worker) for the desktop web build.
- **Automation**: Added `mindwtr-cli` and a local REST API server for scripting and integrations.
- **Daily Review**: Added a lightweight Daily Review guide on mobile and desktop.

### Changed
- **Desktop Storage (XDG)**: Standardized Linux paths to `~/.config/mindwtr/config.toml` and `~/.local/share/mindwtr/data.json`, with migration support for legacy Tauri dirs.
- **Mobile UX**: Navigation and task preview polish (drawer width, review header layout, compact metadata chips).

### Fixed
- **CI/Build**: Unblocked CI, EAS checks, and made desktop tests run reliably under JSDOM.
- **Desktop**: Improved dark mode form control contrast and cleaned up notification subscriptions.

## [0.3.0] - 2025-12-12

### Features
- **Search & Saved Searches**: Added query operators (e.g. `status:`, `context:`, `due:<=7d`) and saved searches.
- **Bulk Actions**: Multi-select + batch move/tag/delete.
- **Organization**: Task dependencies/blocking, hierarchical contexts/tags, and project areas.
- **Reference**: Markdown notes + task/project attachments.
- **Sync**: Added WebDAV backend and daily digest notifications.
- **Desktop**: Vim/Emacs keybinding presets + shortcuts help and accessibility improvements.

### Fixed
- **Review/Bulk UX**: Aligned selection mode behavior across Inbox/Review and tightened desktop layout.
- **Store/Sync**: Hardened merge and persistence logic to reduce edge-case crashes.

## [0.2.9] - 2025-12-12

### Features
- **Phase 1 Foundation**: GTD completeness and shared i18n/settings groundwork.
- **Desktop Keybindings**: Vim/Emacs presets and a keyboard shortcuts help overlay.
- **Capture & Reminders**: Daily capture improvements and quick-add/reminders groundwork.
- **Updates**: “Check for updates” option in Desktop settings.

### Fixed
- **Stability**: Date-safety fixes, mobile checklist mutation fixes, and assorted technical debt cleanup.
- **Desktop**: Resolved TypeScript errors in `ListView` and notification services.

## [0.2.8] - 2025-12-11

### Changed
- **Desktop Config**: Refactored config path handling to use a constant and improved version bump tooling.

### Fixed
- **CI**: Windows build fixes and improved mobile troubleshooting docs.

## [0.2.7] - 2025-12-11

### Changed
- **Rename Completion**: Finished renaming Focus GTD → Mindwtr across desktop/mobile and assets.

### Fixed
- **Desktop**: Regenerated icons and fixed window/title metadata.
- **CI**: Switched macOS builds to Apple Silicon (ARM64).

## [0.2.6] - 2025-12-11

### Changed
- **App Rename**: Renamed the project from Focus GTD to Mindwtr.

### Fixed
- **Mobile iOS**: Added iOS simulator build configuration and EAS bundle identifier fixes.

## [0.2.5] - 2025-12-10

### Changed
- **Docs**: Updated README and release docs for Windows/macOS support.

## [0.2.4] - 2025-12-10

### Features
- **Desktop Releases**: Added multi-platform desktop builds (Windows, macOS, Linux).

### Fixed
- **Mobile**: Restored a working URL polyfill for Expo Go and local APK builds.

### Docs
- **README**: Reorganized the README for end users and installation.

## [0.2.3] - 2025-12-10

### Features
- **Android**: Local Android builds and improved release notes (including optional CI APK build).

## [0.2.2] - 2025-12-10

### Fixed
- **Mobile Startup**: Resolved "Unmatched Route" error by adding a root redirect (`app/index.tsx`) to the inbox.
- **Mobile Logs**: Removed verbose "Polyfill Check" success messages.

## [0.2.1] - 2025-12-10

### Fixed
- **Desktop**: Resolved build errors (unused variables in `ErrorBoundary` and `GlobalSearch`).
- **Desktop Tests**: Fixed Vitest environment configuration (JSDOM, mocks, accessibility matchers) to achieve 100% pass rate.

## [0.2.0] - 2025-12-10

### Features
- **Mobile Navigation**: Implemented proper Android back button handling in Settings sub-menus.
- **Sync Logic**: Implemented robust Last-Write-Wins (LWW) synchronization strategy with dedicated `SyncService`.
- **Architecture**: Consolidated translations and theme logic into `@mindwtr/core` for consistency.

### Fixed
- **Mobile Stability**: Implemented safe URL shim to prevent Hermes crashes (non-standard `createObjectURL`).
- **Data Integrity**: Improved data persistence with reliable `AppState` flushing on background.
- **Security**: Replaced unsafe `dangerouslySetInnerHTML` with safe text rendering.
- **Performance**: Optimized Project views by replacing O(N*M) lookups with efficient single-pass loops.

### Removed
- **Dependencies**: Removed patched `react-native-url-polyfill` in favor of a standard shim.
## [0.1.1] - 2024-12-07

### Fixed
- **Release Automation**: Fixed Android keystore generation and asset upload conflicts
- **Calendar**: Fixed date visibility in dark mode
- **Linux**: Added proper maintainer info for .deb packages

## [0.1.0] - 2024-12-07

### Added
- **Complete GTD Workflow**: Capture, Clarify, Organize, Reflect, Engage
- **Cross-Platform Support**: Desktop (Electron) and Mobile (React Native/Expo)
- **Chinese (中文) Localization**: Full translation for both platforms
- **Views**:
  - Inbox with processing wizard
  - Next Actions with context filtering
  - Board View (Kanban)
  - Calendar View
  - Projects management
  - Contexts (@home, @work, @errands)
  - Waiting For list
  - Someday/Maybe list
  - Weekly Review wizard
  - Tutorial (GTD guide)
- **Dark Mode**: Full support on both platforms
- **Settings**: Theme, language, developer info

### Technical
- Monorepo structure with shared `@mindwtr/core` package
- Zustand for state management
- Local storage persistence
- GitHub Actions CI/CD with automated releases

## License

AGPL-3.0 © [dongdongbh](https://dongdongbh.tech)
