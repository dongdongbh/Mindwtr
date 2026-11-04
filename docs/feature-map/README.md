# Feature map

A feature map tells an agent, or a new contributor, how to reach every feature from the user's side, and how to find it from a test. Read the page for the surface you are about to change or verify.

| Surface | Page | Source |
| --- | --- | --- |
| Desktop (Tauri + React) | [desktop.md](desktop.md) | `apps/desktop` |
| Mobile (Expo + React Native) | [mobile.md](mobile.md) | `apps/mobile` |
| Android native client | [android-native.md](android-native.md) | `apps/android-native` |
| iOS native client | [ios-native.md](ios-native.md) | `apps/ios-native` |

Feature names use the labels of the English locale (`packages/core/src/i18n/locales/en.ts`).

## Entry format

Each surface page starts with how to launch the surface for testing. Then each feature is one `##` heading followed by these lines, in this order. Omit a line that does not apply.

```markdown
## Inbox

- Reach: Sidebar › Inbox. Badge shows the unprocessed count.
- Shortcuts: `Ctrl+1` (Linux/Windows), `Cmd+1` (macOS)
- Selectors: `inbox-list`, `inbox-process-button`
- Code: `apps/desktop/src/components/views/InboxView.tsx`
- Checks: `e2e/clarify.spec.ts`
- Notes: Ignores the global area filter.
```

- **Reach** is the path a user takes, written with `›` between steps. Name the visible label as it appears in the English locale.
- **Shortcuts** lists keyboard shortcuts or gestures.
- **Selectors** lists stable automation handles exactly as they appear in source: `data-testid` values on desktop, `testID` values on mobile, `testTag` values on Android native, and `accessibilityIdentifier` values on iOS native. Do not list visible text here.
- **Code** lists the files that own the feature's screen or entry point.
- **Checks** lists the tests or device scripts that exercise the feature from the user's side.
- **Notes** holds one or two sentences of behavior an agent would otherwise get wrong.

## Keeping it true

`bun run docs:check-feature-map` fails when:

- a path on a `Code:` or `Checks:` line does not exist;
- a value on a `Selectors:` line does not appear as a quoted string in that surface's source;
- an `apps/android-native/scripts/check-*-device.mjs` script is not listed on any `Checks:` line of `android-native.md`.

A change that adds, moves, or removes a user-facing feature updates its page in the same commit.
