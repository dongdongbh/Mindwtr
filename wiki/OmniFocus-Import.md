# OmniFocus Import

Mindwtr can import OmniFocus exports so you can migrate without rebuilding your system by hand.

## Supported Source Files

- an OmniFocus **CSV** export
- an OmniFocus **CSV UTF-16** export
- an Omni Automation / Shortcuts **ZIP** archive containing `OmniFocus.json` and `metadata.json`
- a single **JSON** file when your Shortcut already combines task data and metadata into one document

Import is available on desktop and mobile from **Settings → Data → Import from OmniFocus**.

## Recommended Source Format

If you only need a basic task migration, OmniFocus CSV still works.

If you want the best fidelity, prefer the Omni Automation JSON export over CSV. The JSON path can preserve repeat rules, folder metadata, and more hierarchy detail than OmniFocus CSV exposes.

For the Shortcut-based export, the best input is a ZIP file that contains:

- `OmniFocus.json`
- `metadata.json`

Mindwtr can auto-detect CSV, JSON, and ZIP files from the same import action.

## How Mindwtr Maps OmniFocus Data

Mindwtr maps OmniFocus exports into Mindwtr’s model with a GTD-first bias:

- OmniFocus folders become **Mindwtr areas** when metadata is available
- OmniFocus projects become **Mindwtr projects**
- OmniFocus standalone actions stay outside projects so you can process them later
- OmniFocus tags become **Mindwtr tags**
- OmniFocus contexts become **Mindwtr contexts** when the source format includes them
- OmniFocus notes are preserved in the imported description
- OmniFocus defer dates become **start dates**
- Supported due dates and completion state are preserved
- OmniFocus flags become a **high-priority hint**
- Simple one-level nested tasks can become **checklist items**
- Richer or deeper nested tasks are flattened into normal tasks with the original hierarchy preserved in the title and description
- Omni Automation repeat rules are mapped into **Mindwtr recurrence** when supported

Mindwtr does not currently have a separate OmniFocus-style planned date field. When OmniFocus includes a planned date or duration text, Mindwtr keeps that information in the imported description instead of dropping it.

## Supported OmniFocus Data

- folder names when metadata is available
- project names
- action titles
- notes
- tags
- contexts when the export includes them
- defer / start dates
- due dates
- completion status and completion date when available
- flagged state as a high-priority hint
- supported recurrence from Omni Automation JSON exports
- checklist conversion for simple nested tasks

## Import Steps

1. Open **Import from OmniFocus**
2. Export your data from OmniFocus:
   - use **CSV** if you only need the built-in export
   - use **Omni Automation / Shortcuts JSON** if you want recurrence, folders, and better hierarchy fidelity
3. If your Shortcut produces `OmniFocus.json` and `metadata.json` separately, place both files in one ZIP archive
4. Choose the CSV, JSON, or ZIP file in Mindwtr
5. Review the preview summary
6. Confirm the import

Mindwtr saves a recovery snapshot before importing so you can roll back if needed.

## Current Limits

- OmniFocus native `.ofocus` databases are not imported directly
- HTML and plain-text exports are not imported
- CSV exports remain lossy compared with the Omni Automation JSON export, especially for recurrence and nesting
- Planned dates and duration values are preserved as description text rather than mapped to dedicated fields
- Nested tasks with their own dates, notes, tags, or recurrence are flattened instead of converted into checklist items
- If you import only `OmniFocus.json` without matching metadata, some tag, folder, or project metadata may be missing

## Tips

- Start with a smaller OmniFocus export if you want to validate the mapping first
- If you use the Shortcut-based export, keep `OmniFocus.json` and `metadata.json` together in one ZIP for the cleanest import
- If you have both project actions and standalone inbox actions, Mindwtr preserves that split
- If recurrence matters, prefer the Omni Automation JSON / ZIP path instead of CSV
- Review imported high-priority tasks if you used OmniFocus flags heavily
- Keep the recovery snapshot until you verify the import looks right
