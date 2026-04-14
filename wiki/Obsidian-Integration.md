# Obsidian Integration

Mindwtr can import tasks from an Obsidian vault on desktop, keep them refreshed as files change, open the source note back in Obsidian, and perform narrowly-scoped write-back for supported task formats.

Related: [[Markdown Links]]

## Current Scope

Desktop Obsidian support currently includes:

- desktop only
- automatic file watching with incremental refresh
- manual rescan as a fallback
- deep links back to the source note with `obsidian://`
- limited write-back for supported task formats
- support for standard inline Markdown tasks
- support for Mindwtr internal Markdown task/project references
- support for TaskNotes files

Out of scope:

- mobile vault access
- treating Obsidian as a Mindwtr sync backend
- broad note rewriting or restructuring
- Dataview as a core task format
- a full Obsidian plugin

## Philosophy

Obsidian integration is a file-based external integration, not a new Mindwtr sync backend.

Mindwtr's sync engine is built around `data.json`, while Obsidian is note-based. To avoid destructive conflicts and surprise edits, Mindwtr reads vault files directly and keeps write access intentionally narrow.

## Setup

On desktop:

1. Open **Settings -> Integrations**
2. Find **Obsidian Vault**
3. Select your vault folder
4. Enable the integration
5. Optionally limit scanning to specific folders
6. Optionally set the inline inbox file, defaulting to `Mindwtr/Inbox.md`
7. Optionally choose whether archived TaskNotes files should be included
8. Optionally choose the new task format: `auto`, `inline`, or `tasknotes`
9. Save and run **Rescan vault** once

After the initial scan, Mindwtr watches the vault and refreshes changed files automatically. The manual rescan button stays available as a recovery path if the watcher misses an event or a synced folder is slow to update.

If the selected folder does not contain a `.obsidian/` directory, Mindwtr shows a warning but still lets you save the path.

## Supported Task Formats

### Inline Markdown Tasks

If the scanned scope does not contain TaskNotes files, Mindwtr imports standard Markdown checkboxes:

```md
- [ ] Incomplete task
- [x] Completed task
```

Mindwtr preserves:

- nested task indentation
- inline tags like `#work` or `#project/alpha`
- wiki-links like `[[Meeting Notes]]`
- note-level YAML frontmatter tags

Imported inline tasks show:

- task text
- completion state
- source note path + line number
- an **Open in Obsidian** action

### TaskNotes

Mindwtr also supports [TaskNotes](https://tasknotes.dev/), which stores one task per Markdown file with YAML frontmatter.

Example:

```md
---
tags:
  - task
title: Review quarterly report
status: in-progress
priority: high
due: 2025-01-15
scheduled: 2025-01-14
contexts:
  - "@office"
projects:
  - "[[Q1 Planning]]"
timeEstimate: 120
---
## Notes
Key points to review
```

When TaskNotes files are detected in the scanned scope, Mindwtr treats TaskNotes as the source of truth for imported Obsidian tasks and does **not** also import random inline checklists from other notes. This avoids turning ordinary checklists into tasks for TaskNotes users.

Mindwtr currently imports TaskNotes fields such as:

- title
- status / completion state
- priority
- due and scheduled dates
- tags
- contexts
- projects
- time estimate
- a short body preview

Mindwtr skips TaskNotes view/config files, and archived TaskNotes files are hidden by default unless you enable them in settings.

## File Watching And Refresh

Mindwtr watches the configured vault on desktop and reparses only changed Markdown files instead of rescanning the full vault every time.

This means:

- edits in Obsidian show up in Mindwtr automatically
- deleted source files remove their imported tasks
- renamed files behave like delete + create
- rapid saves are batched before refresh

If a change crosses the inline-vs-TaskNotes boundary, Mindwtr falls back to a full rescan so the import mode stays consistent.

## Write-Back Behavior

Write-back is intentionally constrained.

### Inline Tasks

When you toggle an imported inline Obsidian task in Mindwtr, Mindwtr only updates the checkbox marker on that task line:

- `- [ ]` -> `- [x]`
- `- [x]` -> `- [ ]`

Mindwtr does not rewrite the rest of the note. If the stored line number is stale, it falls back to matching the task text in the file. Ambiguous matches fail safely.

### TaskNotes Tasks

When you toggle an imported TaskNotes task in Mindwtr, Mindwtr updates the frontmatter status instead of editing note body text. It may also add or remove `completedDate` as part of the same safe write.

Mindwtr does not reformat the full file or rewrite unrelated fields.

### Creating New Tasks

New Obsidian tasks can be created in two ways:

- `inline`: append a new `- [ ] ...` line to the configured inbox note
- `tasknotes`: create a new TaskNotes Markdown file
- `auto`: follow the vault's detected import mode

This keeps creation aligned with the format already in use.

## What Gets Skipped

Mindwtr skips:

- `.obsidian/`
- `.trash/`
- hidden files/folders
- `node_modules/`
- unusually large Markdown files
- TaskNotes view/config files

## Deep Linking

Mindwtr opens source notes with Obsidian's URI scheme:

```text
obsidian://open?vault=VAULT_NAME&file=RELATIVE_PATH_WITHOUT_MD
```

This lets you review context in Obsidian without copying file paths manually.

## Current Limitations

- desktop only
- Dataview-style inline fields such as `[due:: ...]` are not parsed yet
- watcher-based refresh still keeps manual rescan as a fallback
- if TaskNotes files are present, Mindwtr intentionally suppresses generic inline checklist import in that scanned scope

## Planned Follow-ups

- optional Dataview compatibility
- mobile feasibility work
- possible Obsidian plugin in a separate repo

## See Also

- [[Data and Sync]]
- [[Calendar Integration]]
