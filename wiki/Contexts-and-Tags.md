# Contexts and Tags

Contexts help you see what you can do **right now** based on where you are, what tools you have, or what mental state you need.

---

## What Are Contexts?

In GTD, a context is a condition required to complete a task—typically a location, tool, or person.

When you filter by context, you see only tasks you can actually do in your current situation.

---

## Location Contexts (@)

Mindwtr includes these preset location contexts:

| Context     | Use When                                 |
| ----------- | ---------------------------------------- |
| `@home`     | Tasks that require being at home         |
| `@work`     | Tasks for the office/workplace           |
| `@errands`  | Tasks while out (shopping, appointments) |
| `@agendas`  | Discussion items for meetings or calls   |
| `@computer` | Tasks requiring a computer               |
| `@phone`    | Tasks requiring phone calls              |
| `@anywhere` | Tasks with no location requirement       |

### Examples

- `Call mom @phone`
- `Fix leaky faucet @home`
- `Buy office supplies @errands`
- `Deploy update @computer @work`

---

## Tags (#)

Mindwtr includes tags for filtering by mental state, mode, or topic:

| Tag          | Use When                          |
| ------------ | --------------------------------- |
| `#focused`   | Deep work requiring concentration |
| `#lowenergy` | Simple tasks for tired moments    |
| `#creative`  | Brainstorming or ideation         |
| `#routine`   | Repetitive/mechanical tasks       |

### Examples

- `Write proposal #focused @computer`
- `File receipts #lowenergy @home`
- `Brainstorm campaign ideas #creative`
- `Process expenses #routine @computer`

### Why Tags?

Your productivity varies throughout the day:
- **Morning:** High focus, tackle #focused tasks
- **After lunch:** Low energy, do #lowenergy or #routine tasks
- **Creative time:** When inspired, work on #creative tasks

---

## Using Contexts in Mindwtr

### Adding Contexts

**Quick-add syntax:**
```
Task title @context1 @context2
Research topic #focused @computer
```
Context and tag names accept Unicode letters and numbers (including CJK and accented characters).

**Edit task:**
1. Open task editor
2. Add contexts in the Contexts field (comma-separated)

### Filtering by Context

**Desktop:**
1. Go to **Next Actions** or **Contexts** view
2. Click a context chip to filter

**Mobile:**
1. Go to **Next Actions** tab or **Contexts** from drawer
2. Tap a context to filter

---

## Custom Contexts

You can create your own contexts:

- `@Bob` — Items to discuss with Bob
- `@waiting-on-vendor` — Waiting for vendor response
- `@car` — Things to do in the car
- `@morning` — Morning routine items

### Creating Custom Contexts

Simply type the new context when adding a task:
```
Review contract @legal
```

The context will be added and available for filtering.

### Managing Saved Contexts and Tags

When you want to clean up or rename reusable metadata:

- Open **Settings → Manage**
- Edit **Contexts**, **Tags**, and **Areas** from one place
- Use this to merge duplicates, standardize naming, or remove values you no longer use

### Bulk Editing Contexts

On desktop, you can update contexts across many tasks at once:

1. Enter **Select** mode in a list view
2. Choose the tasks you want to edit
3. Use **Add Context** or **Remove Context** in the bulk action bar

This is useful when you want to reclassify a whole batch of tasks after a weekly review or project planning pass.

---

## Hierarchical Contexts & Tags

Organize contexts with nested structure using slash notation:

| Syntax            | Example Task                |
| ----------------- | --------------------------- |
| `@work/meetings`  | Meeting prep @work/meetings |
| `@home/garage`    | Fix shelf @home/garage      |
| `#health/fitness` | Morning run #health/fitness |
| `#work/admin`     | File reports #work/admin    |

### Parent-Includes-Children Filtering

When you filter by a parent context, all children are included:

| Filter    | Shows                                        |
| --------- | -------------------------------------------- |
| `@work`   | `@work`, `@work/meetings`, `@work/calls`     |
| `#health` | `#health`, `#health/fitness`, `#health/diet` |

This allows high-level filtering while maintaining specific organization.

### Benefits

- **Organization**: Group related contexts without clutter
- **Flexibility**: Filter broadly or specifically
- **Backwards compatible**: Simple contexts still work normally

---

## Context Best Practices

### Start Simple

Begin with just a few contexts:
- @home
- @work
- @errands
- @computer

Add more only when needed.

### Be Consistent

Use the same spelling and format:
- ✓ `@home` (always)
- ✗ `@Home`, `@house`, `home`

### Combine Contexts

Tasks can have multiple contexts:
- `@computer @work` — Need computer at work
- `@phone @anywhere` — Phone call from anywhere
- `#focused @home` — Deep work at home

### Person Contexts

Add person contexts for agenda items:
```
Discuss project timeline @Sarah
Ask about budget @manager
```

When you see Sarah, search `@Sarah` to find all items.

---

## Context Workflow

### Morning Planning

1. Check where you'll be today
2. Filter Next Actions by relevant context
3. Pick your focus tasks

### Location Change

When you move locations:
1. Filter by new context (@work → @home)
2. See what you can do here
3. Pick the next task

### Surprise Interaction

When someone calls/visits unexpectedly:
1. Search for their name/context
2. Review agenda items
3. Address waiting-for items

---

## Contexts vs. Tags

In Mindwtr, both `@contexts` and `#tags` can filter tasks, but they answer different questions:

| Symbol | What it answers               | Typical use                          | Examples                   |
| ------ | ----------------------------- | ------------------------------------ | -------------------------- |
| `@`    | Where/with what can I do it?  | Location, tool, or person constraint | @home, @work, @phone       |
| `#`    | What is this about?           | Topic, energy, mode, or label        | #focused, #lowenergy       |

### Practical guidance

- Use **`@` contexts** for *execution filters* (the places/tools/people you need).
- Use **`#` tags** for *categorization* (energy level, topic, or grouping across projects).
- Both support **hierarchies** (e.g., `@work/meetings`, `#health/fitness`).

---

## See Also

- [[GTD Workflow in Mindwtr]]
- [[GTD Best Practices]]
- [[User Guide Desktop]]
- [[User Guide Mobile]]
