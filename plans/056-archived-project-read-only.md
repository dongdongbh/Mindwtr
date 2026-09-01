# Plan 056: Enforce archived-project read-only behavior

> Drift check: git diff --stat v1.2.5-rc.2..HEAD -- apps/desktop/src/components/views/projects apps/desktop/src/components/Task apps/mobile/components/projects-screen apps/mobile/components/task-list apps/mobile/components/swipeable-task-item*

## Status

- Priority P1; effort M; risk HIGH; category product integrity.
- Introduced in 939c6f92b; found by the corrected v1.2.5-rc.2..HEAD audit.

## Why

Archived projects are historical/read-only, but desktop task rows/DnD and mobile edit/swipe/bulk paths remain live. Inspecting history can mutate, move, delete, or mark archived tasks done.

## Design

1. Add failing desktop/mobile interaction tests for row edit/status/delete, DnD/reorder, selection/bulk, and swipe in an archived project.
2. Derive one authoritative archived-project read-only value at each project workspace boundary and propagate it through row, DnD, selection, editor, bulk, and swipe capabilities; avoid scattered leaf guesses.
3. Keep viewing/expanding, copying/opening content, and explicit Reactivate available. After reactivation, mutations return.
4. Follow established read-only and accessibility affordances.

## Verification and stop conditions

- Focused desktop ProjectWorkspace/TaskItem and mobile ProjectDetail/TaskList/swipe suites, typecheck/lint, accessibility, and git diff --check.
- Stop if Reactivate is blocked or read-only leaks outside archived-project context. Make one commit only.
