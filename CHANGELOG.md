# Changelog

All notable changes to Mindwtr will be documented in this file.

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

MIT © [dongdongbh](https://dongdongbh.tech)
