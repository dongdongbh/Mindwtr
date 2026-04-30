# Todoist Import

Mindwtr can import Todoist exports so you can migrate without rebuilding your system by hand.

Supported sources:

- a single Todoist **CSV** export
- a Todoist **ZIP** backup containing multiple project CSV files

Import is available on desktop and mobile from **Settings → Data → Import from Todoist**.

---

## What Gets Imported

Mindwtr maps Todoist exports into Mindwtr’s model with a GTD-first bias:

- Todoist projects become **Mindwtr projects**
- Todoist sections become **Mindwtr sections**
- Todoist subtasks become **checklist items**
- Todoist labels become **tags**
- Imported tasks are placed in **Inbox**

Keeping imported tasks in Inbox is intentional. It lets you process them in your own GTD flow instead of guessing organization rules during import.

---

## Supported Todoist Data

- task titles
- descriptions
- priorities
- due dates when they can be resolved safely
- sections
- notes/comments attached to tasks
- labels written in Todoist content (for example `@work`)

Todoist recurring schedules are not recreated as Mindwtr recurrences automatically. The task is imported once and the original Todoist recurrence text is preserved in the description so you can decide how to model it in Mindwtr.

---

## Import Flow

1. Open **Import from Todoist**
2. Choose a Todoist CSV or ZIP file
3. Review the preview summary
4. Confirm the import

Before import, Mindwtr saves a recovery snapshot of your current local data when supported.

After import:

- new projects are created as needed
- imported tasks appear in **Inbox**
- warnings are shown for recurring tasks, skipped rows, or unsupported archive entries

---

## Notes on ZIP Backups

Todoist ZIP backups usually contain one CSV per project. Mindwtr reads each CSV and imports each project separately.

Mindwtr skips:

- nested ZIP files
- non-CSV files inside the archive
- malformed Todoist rows it cannot parse safely

---

## Tips

- Start with a smaller Todoist project if you want to test the mapping first
- Keep the recovery snapshot until you verify the import looks right
- If you import the same export twice, you may duplicate tasks

See also [[Data and Sync]] and [[Backup and Restore]].
