# Markdown Links

Mindwtr supports internal Markdown links for cross-referencing tasks and projects inside notes.

## Supported Syntax

Use stable Mindwtr IDs instead of plain text titles:

```md
[[task:task-id|Quarterly review]]
[[project:project-id|Website launch]]
```

- `task:` links point to a task by ID.
- `project:` links point to a project by ID.
- The text after `|` is the label shown in the editor and preview.

Mindwtr also normalizes those tokens into regular Markdown links during rendering:

```md
[Quarterly review](mindwtr://task/task-id)
[Website launch](mindwtr://project/project-id)
```

## Creating Links

When editing a Markdown field on desktop, type `[[` and start searching.

- Search matches task and project titles.
- Inserted links always use the stable `[[task:...|label]]` or `[[project:...|label]]` token.
- Code spans and fenced code blocks are left untouched.

## Navigation Behavior

- Live task links open the right Mindwtr view and highlight the task.
- Live project links open the Projects view and select the project.
- External links still support `http`, `https`, `mailto`, and `tel`.

## Deleted Items

If the linked task or project has been deleted:

- Mindwtr renders the label with strike-through styling.
- Desktop shows a **Restore** action when the deleted item still exists as a tombstone in local data.
- If the tombstone is gone, the link stays as a non-interactive deleted label.

## Example

```md
Prepare launch notes for [[project:project-123|Website launch]]

- [ ] Draft intro copy
- [ ] Review [[task:task-456|homepage checklist]]
```

## Related Docs

- [[Obsidian Integration]]
- [[Core API]]
