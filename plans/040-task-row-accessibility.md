# Identify desktop task detail controls

## Problem and evidence

Every desktop task title button exposes the same accessible name, “Toggle task details.” In a list, assistive-technology users cannot tell which task any one of those controls opens or collapses.

## Desired behavior

The title button's accessible name must include both the localized action and the visible task title while preserving its expanded state and existing pointer/keyboard behavior.

## Implementation

1. Change the focused display regression to require the task title in the accessible name.
2. Compose the localized `task.toggleDetails` action with `task.title` using the same `Action: task` convention already used by mobile row actions.
3. Update exact-name integration assertions; keep regex-based interaction tests compatible.

## Verification

- Run `TaskItemDisplay`, `TaskItem`, Agenda, Archive, and ListView desktop suites.
- Run desktop package tests, root typecheck, and localization parity.

## Non-goals

- Rename visible task titles or hover hints.
- Change mobile's richer row-level accessibility description.
- Add new translation keys for a composition pattern already used cross-platform.

## Risks and rollback

Long task titles produce longer accessible names, but identifying the target is necessary and the title is already the row's primary content. Reverting restores the ambiguous name.
