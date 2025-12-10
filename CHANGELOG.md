# Changelog

All notable changes to Focus GTD will be documented in this file.
## [0.2.1] - 2025-12-10

### Fixed
- **Desktop**: Resolved build errors (unused variables in `ErrorBoundary` and `GlobalSearch`).
- **Desktop Tests**: Fixed Vitest environment configuration (JSDOM, mocks, accessibility matchers) to achieve 100% pass rate.

## [0.2.0] - 2025-12-10

### Features
- **Mobile Navigation**: Implemented proper Android back button handling in Settings sub-menus.
- **Sync Logic**: Implemented robust Last-Write-Wins (LWW) synchronization strategy with dedicated `SyncService`.
- **Architecture**: Consolidated translations and theme logic into `@focus-gtd/core` for consistency.

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
- Monorepo structure with shared `@focus-gtd/core` package
- Zustand for state management
- Local storage persistence
- GitHub Actions CI/CD with automated releases

## License

MIT © [dongdongbh](https://dongdongbh.tech)
