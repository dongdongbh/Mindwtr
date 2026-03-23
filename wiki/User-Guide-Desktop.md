# User Guide: Desktop

The Mindwtr desktop app is built with [Tauri v2](https://tauri.app/), providing a lightweight, fast experience across Windows, macOS, and Linux.

## Overview

The desktop app features a sidebar navigation with all GTD views and a main content area.

---

## Interaction Patterns

- **Single click** toggles task details.
- **Double click** opens full edit mode.
- **Right click** opens context menus (projects, tasks).
- **Keyboard first**: global shortcuts and Vim/Emacs modes are optimized for desktop workflows.

## Focus Mode

Use Focus Mode to hide the sidebar and keep the list centered (800px max width).

- Toggle with **Ctrl+\\** (Windows/Linux) or **Cmd+\\** (macOS)
- Great for deep work or reviews

### System Tray

Mindwtr runs in the background to handle auto-sync.

- **Closing the window** minimizes the app to the system tray instead of quitting.
- **Click the tray icon** to show/hide the window.
- **Right-click the tray icon** to Quit the application completely.

## Views

### 📥 Inbox

Your capture zone. All new tasks land here before processing.

- **Add tasks** using the input field at the bottom
- **Quick-add syntax** is supported (see [[Getting Started]])
- **Process Inbox** using the clarify workflow

### 🎯 Focus

Your unified dashboard combining daily planning and next actions.

- **Today's Focus** — Up to 3 starred priority tasks for deep work.
- **Overdue** — Past due items.
- **Due Today** — Tasks due today.
- **Next Actions** — Ready tasks without due dates, filtered by context.
- **Review Due** — Items with tickler dates.

**Features:**
- **Context Filters**: Filter Next Actions by context (e.g., @home, @work) or tag.
- **Top 3 Only**: Toggle to hide everything except your top 3 focus tasks (Zen Mode).
- **Pomodoro (Optional)**: Enable in **Settings → GTD → Features → Pomodoro timer** to show a task-linked focus/break timer panel (15/3, 25/5, 50/10).

### 📁 Projects

Multi-step outcomes containing related tasks.

- **Sequential mode** — Only first incomplete task shows in the Next Actions list (Focus view)
- **Parallel mode** — All tasks show in the Next Actions list
- **Status** — Active, Waiting, Someday, Archived
- **Areas of Focus** — Group projects by higher-level areas (e.g., Work, Health) to keep your sidebar organized.
- **Project tags** — Tag projects and filter by tag
- **Support notes** — Add planning notes and reference material
- **Sections** — Optional task groupings inside a project (phases, milestones, sub-workstreams)
- **Review date** — Set tickler dates for project review
- **Complete/Archive** — Mark projects as done or archive them

### 🏷️ Contexts

Filter tasks by location or tool context:

- `@home`, `@work`, `@errands`, `@agendas`
- `@computer`, `@phone`, `@anywhere`

### 🏷️ Tags

Filter tasks by energy level, mode, or topic:

- Energy: `#focused`, `#lowenergy`, `#creative`
- Topic: `#health`, `#finance`

### ⏳ Waiting For

Track delegated items or tasks waiting on external events.

### 💭 Someday/Maybe

Incubate ideas you might want to pursue later.

### 🗓️ Calendar

Time-based view of tasks with due dates or start times.

### 📋 Board View

Kanban-style drag-and-drop board with columns:

- **Inbox** — Unprocessed items
- **Next Actions** — Ready to work on
- **Waiting For** — Delegated items
- **Someday/Maybe** — Deferred items
- **Done** — Completed tasks

### ✅ Done

Completed tasks.

### 📦 Archived

Archived tasks. You can restore or permanently delete items here.

### 📝 Weekly Review

Guided GTD review wizard with steps:

1. Process Inbox
2. Review Calendar
3. Follow up Waiting For
4. Review Projects
5. Review Someday/Maybe

See [[Weekly Review]] for detailed guidance.

---

## AI Assistant (Optional)

Enable in **Settings → AI assistant**:

- **Clarify** — turn vague tasks into concrete next actions
- **Break down** — generate checklist steps for big tasks
- **Review analysis** — highlight stale tasks during review
- **Copilot** — context/tag/time suggestions while typing

AI is optional and only runs when you request it.

---

## Reusable Lists

Use checklists as templates:

- **Duplicate task** — copy a master list (packing, travel prep)
- **Reset checklist** — uncheck everything for reuse (groceries)

---

## Task Editor (View + Edit)

- Click a task to open a **read-only view** of all details.
- Press **Edit** (or `e`) to switch to edit mode.
- The editor starts minimal. Use **More options** to reveal advanced fields.

---

## Calendar Integration

Mindwtr can overlay external calendars (ICS subscriptions) in the Calendar view.
Add an **ICS URL** in **Settings → Calendar**.

### 🔍 Global Search

Powerful search with operators to find anything instantly.

**Open:** Press `/` or `Ctrl/Cmd + K` or click the search icon.

#### Search Operators

| Operator   | Example            | Description                   |
| ---------- | ------------------ | ----------------------------- |
| `status:`  | `status:next`      | Filter by task status         |
| `-status:` | `-status:done`     | Exclude a status              |
| `context:` | `context:@home`    | Filter by context             |
| `tag:`     | `tag:#focused`     | Filter by tag                 |
| `project:` | `project:HomeReno` | Filter by project name or ID  |
| `due:`     | `due:today`        | Tasks due on date             |
| `due:<=`   | `due:<=7d`         | Tasks due within 7 days       |
| `start:`   | `start:>=tomorrow` | Tasks starting from date      |
| `created:` | `created:>=30d`    | Tasks created in last 30 days |
| `OR`       | `@home OR @work`   | Match either condition        |

**Date formats:** `today`, `tomorrow`, `7d` (7 days), `2w` (2 weeks), `1m` (1 month), `2025-01-15`

#### Saved Searches

Save frequently used searches for quick access:

1. Enter your search query with operators
2. Click **"Save Search"** button
3. Name your search (e.g., "Work tasks due soon")
4. Access from the **Saved Searches** section in the sidebar

**To delete a saved search:** Open the saved search, then click the trash icon.

---

## Quick Capture

### Global Hotkey

Capture tasks from anywhere on your desktop without switching windows:

1. Press the global hotkey (`Ctrl+Alt+M`)
2. Type your task with quick-add syntax
3. Press Enter to add to Inbox
4. Continue what you were doing

You can change or disable this shortcut in **Settings → General → Input → Global quick add shortcut**.
Available options follow platform conventions:
- macOS: `Ctrl+Option+M` (default), `Ctrl+Option+N`, `Ctrl+Option+Q`, or legacy `Cmd+Shift+A`
- Windows/Linux: `Ctrl+Alt+M` (default), `Ctrl+Alt+N`, `Ctrl+Alt+Q`, or legacy `Ctrl+Shift+A`
- Disabled (no system-wide Quick Add shortcut)

### Tray Icon

Click the system tray icon for instant capture:

- Quick-add input appears
- Use natural language syntax
- Task goes directly to Inbox

### Quick-Add Syntax

Mindwtr parses natural language when adding tasks:

| Syntax       | Example           | Result              |
| ------------ | ----------------- | ------------------- |
| `@context`   | `@home`           | Adds context        |
| `#tag`       | `#focused`        | Adds tag            |
| `+Project`   | `+HomeReno`       | Assigns to project  |
| `+Multi Word` | `+New Project`    | Assigns to "New Project" |
| `!Area`       | `Plan roadmap !Work` | Assigns to area       |
| `/area:<name>` | `/area:Personal` | Assigns to area (no spaces) |
| `/due:date`  | `/due:friday`     | Sets due date       |
| `/note:text` | `/note:call back` | Adds description    |
| `/status`    | `/next`, `/waiting`, `/someday`, `/done`, `/archived`, `/inbox` | Sets status |

**Date formats:** today, tomorrow, friday, next week, in 3 days, 2025-01-15

---

## Audio Capture & Transcription

Capture tasks using your voice with AI-powered transcription.

### Setup

1. Go to **Settings → AI Assistant**.
2. Enable **Speech to Text**.
3. Choose a **Provider**:
   - **OpenAI / Gemini**: Requires an API key (cloud-based).
   - **Offline (Whisper)**: Runs locally on your device. Click **Download** to fetch the model once.
4. Configure **Processing Mode**:
   - **Smart Parse**: Extracts dates (`tomorrow`), priorities, and projects from your speech.
   - **Transcript Only**: Transcribes text verbatim into the task.

### Using Audio Capture

- **Quick Add**: Toggle the capture mode to **Audio** (microphone icon) in the Quick Add bar.
- **Record**: Click the microphone to start recording. Speak your task naturally.
- **Finish**: Click stop to transcribe. The text will populate the input field.
- **Attachments**: Enable "Save audio attachments" in **Settings → General** to keep the original voice note.

---

## Notifications & Reminders

Mindwtr sends desktop notifications to keep you on track:

### Types of Notifications

- **Due date reminders** — Alerts when tasks are due
- **Start time alerts** — Reminds you when it's time to begin
- **Recurring task reminders** — Notifications for recurring items

### Settings

Configure notifications in Settings:
- Enable/disable notifications
- Set reminder lead time

**Platform notes:**
- **macOS** will prompt for notification permission the first time you enable it.
- **Linux** requires a running notification daemon (GNOME/KDE, etc.).

---

## Task Management

### Creating Tasks

1. Use the input field at the bottom of any list view
2. Use the global hotkey from anywhere
3. Click the tray icon for quick capture
4. Type your task title with quick-add syntax
5. Press Enter to add

### Editing Tasks

- Click on a task to open the edit panel
- Edit: title, status, contexts, tags, description, location
- Set: due date, start date, review date, time estimate, recurrence
- Manage checklist items
- Description markdown supports unordered lists and task checkboxes (`- item`, `[ ] item`, `[x] item`)
- Markdown checkbox lines can populate checklist items when you save
- Assign to a project

### Task Properties

| Property          | Description                                         |
| ----------------- | --------------------------------------------------- |
| **Status**        | inbox, next, waiting, someday, done, archived       |
| **Priority**      | low, medium, high, urgent                           |
| **Contexts**      | Location/tool tags (e.g., @home, @work)             |
| **Tags**          | Energy/mode tags (e.g., #focused, #lowenergy)       |
| **Due Date**      | When the task is due                                |
| **Start Date**    | When to start working on it                         |
| **Review Date**   | Tickler date for review                             |
| **Time Estimate** | 5min, 10min, 15min, 30min, 1hr, 2hr, 3hr, 4hr, 4hr+ |
| **Recurrence**    | daily, weekly, monthly, yearly + strategy           |
| **Checklist**     | Sub-items for multi-step tasks                      |
| **Description**   | Markdown-formatted notes with preview               |
| **Attachments**   | Files and links attached to the task                |
| **Location**      | Physical location                                   |
| **Project**       | Parent project assignment                           |
| **Section**       | Optional group within a project                     |

**Attachments:** The **Add link** field accepts both URLs and local file paths (e.g., `/home/user/doc.pdf`, `C:\Users\you\file.txt`, or `file://...`).
See [[Attachments]] for sync, cleanup, and audio notes.

### Recurring Tasks

When you complete a recurring task, Mindwtr automatically creates the next instance with updated dates.

- **Strict** (default): keeps a fixed schedule cadence.
  Example: every 5 days remains anchored to the planned cycle.
- **Repeat after completion**: shifts the next due date from completion time.
  Example: complete now, next is due 5 days later.

You can toggle this in the task editor recurrence field using **Repeat after completion**.


---

## Bulk Actions

Select multiple tasks to perform batch operations:

1. Click **"Select"** button in the list header
2. Click tasks to select/deselect them
3. Use the action bar to:
   - **Move** — Change status for all selected
   - **Assign Area** — Move all selected tasks under a specific area (or clear the area)
   - **Add Tag** — Add a tag to all selected
   - **Remove Tag** — Remove a tag from all selected tasks
   - **Add Context** — Add a context to all selected tasks
   - **Remove Context** — Remove a context from all selected tasks
   - **Delete** — Delete all selected
4. Click **"Done"** to exit selection mode

### Sorting

Use the sort dropdown to order tasks by:
- Default (status-based)
- Due date
- Start date
- Review date
- Title (alphabetical)
- Created (oldest/newest)

---

## Hierarchical Contexts & Tags

Organize with nested contexts and tags:

| Example          | Matches                         |
| ---------------- | ------------------------------- |
| `@work`          | `@work`, `@work/meetings`, etc. |
| `@work/meetings` | Only `@work/meetings`           |
| `#health`        | `#health`, `#health/diet`, etc. |

Filtering by a parent context includes all children.

---

## Keyboard Shortcuts

Mindwtr supports **Vim** and **Emacs** keybinding presets. Change in Settings.

See [[Desktop Keyboard Shortcuts]] for the complete list.

**Quick reference (Vim):**
- `/` — Open search
- `?` — Show shortcuts help
- `gi` — Go to Inbox
- `gn` — Go to Next
- `gf` — Go to Focus
- `j/k` — Move selection down/up
- `e` — Edit selected task
- `x` — Toggle done
- `dd` — Delete task

---

## Settings

Access Settings from the sidebar.

### General
- **Appearance**: Light, Dark, or System
- **Language**: English, Chinese, Spanish, Hindi, Arabic, German, Russian, Japanese, French, Portuguese, Korean, Italian, Turkish
- **Keyboard Shortcuts**: Vim or Emacs preset

### Notifications

**Task Reminders:**
- Enable/disable task notifications for due dates and start times

**Daily Digest:**
- **Morning Briefing** — Summary of due today, overdue, and focus tasks
- **Evening Review** — Prompt to review and wrap up the day
- Configure times (e.g., 9:00 AM, 8:00 PM)

**Weekly Review:**
- **Reminders** — Get a weekly notification to start your review
- **Review Day/Time** — Customize when you want to be reminded

### GTD
- **Auto-Archive** — Automatically move completed tasks to the Archive after a set number of days (default: 7 days)
- **Features** — Optional signals you can enable when needed:
  - **Priorities** — Show a priority flag on tasks
  - **Time Estimates** — Add a duration field for time blocking
- **Inbox Processing** — Keep guided inbox processing for teaching GTD, or switch the default to **Quick** mode for a compact one-screen flow
  - Choose whether to show the 2-minute shortcut, ask for project early, include contexts/tags, allow scheduling, and offer reference during processing
- **Task Editor Layout** — Choose which fields are shown by default, move fields between sections, and reorder them
  - You can move fields like **Due Date** into **Scheduling** and choose which sections expand by default
- **Manage** — Maintain your reusable metadata from one place
  - Edit **Areas**, **Contexts**, and **Tags** without hunting through individual tasks

### Data & Sync

**Sync Backend:**
- **File** — Sync via a shared JSON file (Dropbox, Google Drive, etc.)
- **WebDAV** — Sync to a WebDAV server (Nextcloud, ownCloud, etc.)

**Settings sync options:**
- Choose which preferences sync across devices (theme, language/date format, external calendar URLs, AI settings)
- API keys and local model paths are never synced

**Sync status:**
- Sidebar footer shows last sync time and online/offline status

For WebDAV, configure:
- Server URL (folder URL; Mindwtr stores `data.json` inside)
- Username and Password

See [[Data and Sync]] for detailed setup.

### About
- Version info
- Check for updates
- Links to website and GitHub

---

## See Also

- [[Desktop Installation]]
- [[Desktop Keyboard Shortcuts]]
- [[Data and Sync]]
