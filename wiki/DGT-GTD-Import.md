# DGT GTD Import

Mindwtr can import DGT GTD exports so you can migrate without rebuilding your system by hand.

Supported sources:

- a DGT GTD **JSON** export
- a DGT GTD **ZIP** archive containing the exported JSON file

Import is available on desktop and mobile from **Settings → Data → Import from DGT GTD**.

---

## What Gets Imported

Mindwtr maps DGT GTD exports into Mindwtr’s model with a GTD-first bias:

- DGT folders become **Mindwtr areas**
- DGT projects become **Mindwtr projects**
- DGT checklists become **checklist tasks**
- checklist items stay as **checklist items**
- DGT contexts become **contexts**
- DGT tags become **tags**

Tasks keep their mapped status when Mindwtr can represent it safely. Standalone DGT tasks can stay outside projects, so you can organize them afterward instead of forcing extra structure during import.

---

## Supported DGT Data

- task titles
- notes/descriptions
- priorities
- due dates
- checklist items
- folders, projects, contexts, and tags
- completed tasks
- supported repeat rules such as simple daily/weekly/monthly/yearly schedules and some interval-based repeats

Unsupported DGT repeat patterns are imported once and the original repeat text is preserved in the description so you can adjust the recurrence manually in Mindwtr.

---

## Import Flow

1. Open **Import from DGT GTD**
2. Choose a DGT GTD JSON or ZIP file
3. Review the preview summary
4. Confirm the import

Before import, Mindwtr saves a recovery snapshot of your current local data when supported.

After import:

- new areas and projects are created as needed
- standalone tasks stay available for later organization
- warnings are shown for lossy repeat mappings or skipped archive entries

---

## Notes on ZIP Exports

Mindwtr reads the first valid DGT JSON export inside the archive.

Mindwtr skips:

- nested ZIP files
- non-JSON files inside the archive
- malformed JSON files it cannot parse safely

---

## Tips

- Start with a smaller DGT GTD export if you want to validate the mapping first
- Keep the recovery snapshot until you verify the import looks right
- If you import the same export twice, you may duplicate tasks

See also [[Data and Sync]] and [[Backup and Restore]].
