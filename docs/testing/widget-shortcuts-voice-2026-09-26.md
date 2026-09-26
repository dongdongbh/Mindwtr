# Widget, saved-list Shortcuts, and voice capture checks

## Behavior

- Tasks widgets own their padding; both configuration variants disable WidgetKit content margins. This avoids budgeting twice for margins and hiding all task rows at medium size.
- In iOS Shortcuts, choose **Open Mindwtr Saved List** and select a saved Focus filter (including a context filter). Open Mindwtr after saving a filter to refresh the picker. Existing **Open Mindwtr List** automations retain their enum parameter.
- Saved lists use stable IDs. The destination resolves current data rather than cached widget tasks; renamed filters keep working, and deleted filters do not open a replacement list.
- Desktop quick capture focuses Start recording when Audio opens. Enter uses normal button activation, including the existing speech configuration and recording guards.

## Automated validation

Run from the appropriate package directory:

```sh
# apps/desktop
bunx vitest run src/components/QuickAddModal.test.tsx
bunx tsc --noEmit

# apps/mobile
bunx vitest run plugins/ios-widgets-and-shortcuts.test.js lib/widget-list-destination.test.ts 'app/(drawer)/widget-list/widget-list-screen.test.tsx' lib/widget-data.test.ts lib/widget-service.test.ts lib/pending-captures.test.ts
bunx tsc --noEmit

# repository root
node scripts/ci/validate-ios-app-intents-availability.js
bunx vitest run packages/core/src/release-diagnostics-fields.test.ts
```

On macOS, compile and run the Foundation catalog/URL check:

```sh
mkdir -p "$HOME/worktrees/Mindwtr/saved-list-shortcut-check"
swiftc apps/mobile/ios-app-intents/MindwtrSavedListCatalog.swift \
  apps/mobile/tests/ios-saved-list/SavedListCatalogCheck.swift \
  -o "$HOME/worktrees/Mindwtr/saved-list-shortcut-check/catalog-check"
"$HOME/worktrees/Mindwtr/saved-list-shortcut-check/catalog-check"
```

All checks above passed on September 26. Xcode 27 also typechecked the maintained widget and App Intents sources against the iOS SDK with an iOS 16 deployment target. Its metadata processor successfully exported the App Intents metadata, including the saved-list action and entity. This was isolated source/metadata validation, not a signed full-app archive.

## Device acceptance still required

The wired iPhone 12 (iOS 17.5.1) was detected. This change has not been installed over its existing app or confirmed end to end on hardware.

1. Resize a populated Tasks widget large → medium → large; confirm rows remain visible at ordinary text sizes and check larger accessibility sizes for clipping.
2. Run Open Mindwtr Saved List from Shortcuts, cold and warm. Confirm the selected context filter, rename it, then remove it and verify it never opens another filter. Diagnostics should contain `v1.3.3/saved-list-shortcut` and `available: true` for a live filter.
3. On Mac, open Audio capture with a configured speech provider and press Enter. Confirm microphone recording and subsequent capture/transcription. Automated desktop coverage checks keyboard activation with the native recording command mocked; it does not establish microphone delivery.

No physical-device data, signing settings, account state, or simulator sessions were changed for these checks.
