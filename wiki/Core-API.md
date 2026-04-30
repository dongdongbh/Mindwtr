# Core API

API documentation for the `@mindwtr/core` package.

---

## Installation

The core package is used internally by the desktop and mobile apps:

```typescript
import { 
    useTaskStore, 
    setStorageAdapter,
    parseQuickAdd,
    mergeAppData 
} from '@mindwtr/core';
```

---

## Types

### Task

```typescript
interface Task {
    id: string;                    // UUID
    title: string;                 // Task title
    status: TaskStatus;            // Current status
    taskMode?: 'task' | 'list';    // 'list' = checklist-first task
    priority?: TaskPriority;       // 'low' | 'medium' | 'high' | 'urgent'
    energyLevel?: TaskEnergyLevel; // 'low' | 'medium' | 'high'
    assignedTo?: string;           // Waiting-for person
    startTime?: string;            // ISO date string
    dueDate?: string;              // ISO date string
    recurrence?: Recurrence | RecurrenceRule;
    tags: string[];                // e.g., ['#focused']
    contexts: string[];            // e.g., ['@home', '@work']
    checklist?: ChecklistItem[];   // Sub-items
    description?: string;          // Notes
    attachments?: Attachment[];    // Files/Links
    location?: string;             // Physical location
    projectId?: string;            // Parent project ID
    sectionId?: string;            // Parent section ID
    areaId?: string;               // Parent area ID (optional direct grouping)
    isFocusedToday?: boolean;      // Today's priority
    pushCount?: number;            // Number of times due date was pushed later
    textDirection?: 'auto' | 'ltr' | 'rtl';
    timeEstimate?: TimeEstimate;   // '5min' | '10min' | '15min' | '30min' | '1hr' | '2hr' | '3hr' | '4hr' | '4hr+'
    reviewAt?: string;             // Tickler date
    completedAt?: string;          // When completed
    rev?: number;                  // Monotonic revision counter for sync
    revBy?: string;                // Device ID that issued `rev`
    createdAt: string;             // Creation timestamp
    updatedAt: string;             // Last update timestamp
    deletedAt?: string;            // Soft-delete timestamp
    purgedAt?: string;             // Permanently deleted (tombstone only)
    orderNum?: number;             // Manual sort order
}
```

### TaskStatus

```typescript
type TaskStatus = 
    | 'inbox' 
    | 'next' 
    | 'waiting' 
    | 'someday' 
    | 'reference'
    | 'done' 
    | 'archived';
```

### Recurrence

```typescript
type RecurrenceRule = 'daily' | 'weekly' | 'monthly' | 'yearly';
type RecurrenceStrategy = 'strict' | 'fluid';
type RecurrenceWeekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';
type RecurrenceByDay = RecurrenceWeekday | `${'1' | '2' | '3' | '4' | '-1'}${RecurrenceWeekday}`;

interface Recurrence {
    rule: RecurrenceRule;
    strategy?: RecurrenceStrategy;      // Defaults to 'strict'
    byDay?: RecurrenceByDay[];          // Weekly/monthly weekday pattern
    count?: number;                     // Total occurrences in the series, including the current task
    until?: string;                     // ISO date/datetime when the series should stop
    completedOccurrences?: number;      // Internal counter used to preserve COUNT across generated tasks
    rrule?: string;                     // Optional RFC 5545 fragment
}
```

- `strategy: 'strict'` keeps the planned cadence anchored to the schedule.
- `strategy: 'fluid'` means “repeat after completion”.
- `count` stops the series after the total number of occurrences has been created.
- `until` stops the series when the next generated task would land after the given date/time.
- `completedOccurrences` is internal sync-safe metadata; clients should preserve it when round-tripping recurrence objects.

### Project

```typescript
interface Project {
    id: string;
    title: string;
    status: 'active' | 'someday' | 'waiting' | 'archived';
    color: string;                 // Hex color code
    areaId?: string;               // Parent Area ID
    tagIds: string[];              // Associated tags
    order: number;                 // Sort order within area
    isSequential?: boolean;        // Show only first task in Next Actions
    isFocused?: boolean;           // Priority project (max 5)
    supportNotes?: string;         // Planning notes
    attachments?: Attachment[];    // Files/Links
    reviewAt?: string;             // Tickler date
    rev?: number;                  // Monotonic revision counter for sync
    revBy?: string;                // Device ID that issued `rev`
    createdAt: string;
    updatedAt: string;
    deletedAt?: string;
}
```

### Section

```typescript
interface Section {
    id: string;
    projectId: string;
    title: string;
    description?: string;
    order: number;                 // Sort order within project
    isCollapsed?: boolean;         // UI collapsed state
    rev?: number;                  // Monotonic revision counter for sync
    revBy?: string;                // Device ID that issued `rev`
    createdAt: string;
    updatedAt: string;
    deletedAt?: string;            // Soft-delete timestamp
}
```

### Area

```typescript
interface Area {
    id: string;
    name: string;
    color?: string;
    icon?: string;
    order: number;
    rev?: number;
    revBy?: string;
    createdAt?: string;
    updatedAt?: string;
    deletedAt?: string;            // Soft-delete tombstone for sync
}
```

### Attachment

```typescript
interface Attachment {
    id: string;
    kind: 'file' | 'link';
    title: string;
    uri: string;
    mimeType?: string;
    size?: number;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string;
}
```

### AppData

```typescript
interface AppData {
    tasks: Task[];
    projects: Project[];
    sections: Section[];
    areas: Area[];
    settings: {
        theme?: 'light' | 'dark' | 'system';
        language?: 'en' | 'zh' | 'system';
        // ... many other settings
        ai?: {
            enabled?: boolean;
            provider?: 'gemini' | 'openai' | 'anthropic';
            // ...
        };
    };
}
```

---

## Store

### useTaskStore

Zustand store hook for accessing state and actions.

```typescript
import { useTaskStore } from '@mindwtr/core';

function MyComponent() {
    const { tasks, projects, addTask, updateTask } = useTaskStore();
    // ...
}
```

### Store State

| Property    | Type                  | Description                     |
| ----------- | --------------------- | ------------------------------- |
| `tasks`     | `Task[]`              | All visible (non-deleted) tasks |
| `projects`  | `Project[]`           | All visible projects            |
| `areas`     | `Area[]`              | All areas                       |
| `settings`  | `AppData['settings']` | App settings                    |
| `isLoading` | `boolean`             | Loading state                   |
| `error`     | `string \| null`      | Error message                   |

### Store Actions

#### Task Operations

```typescript
// Create
addTask(title: string, initialProps?: Partial<Task>): Promise<void>;

// Update
updateTask(id: string, updates: Partial<Task>): Promise<void>;

// Move
moveTask(id: string, newStatus: TaskStatus): Promise<void>;

// Delete (Soft)
deleteTask(id: string): Promise<void>;

// Restore
restoreTask(id: string): Promise<void>;

// Duplicate
duplicateTask(id: string, asNextAction?: boolean): Promise<void>;

// Reset Checklist
resetTaskChecklist(id: string): Promise<void>;

// Batch Operations
batchUpdateTasks(updates: Array<{ id: string; updates: Partial<Task> }>): Promise<void>;
batchMoveTasks(ids: string[], newStatus: TaskStatus): Promise<void>;
batchDeleteTasks(ids: string[]): Promise<void>;
```

#### Project Operations

```typescript
// Create
addProject(title: string, color: string, initialProps?: Partial<Project>): Promise<Project>;

// Update
updateProject(id: string, updates: Partial<Project>): Promise<void>;

// Delete
deleteProject(id: string): Promise<void>;

// Toggle Focus
toggleProjectFocus(id: string): Promise<void>;

// Reorder
reorderProjects(orderedIds: string[], areaId?: string): Promise<void>;
reorderProjectTasks(projectId: string, orderedIds: string[], sectionId?: string | null): Promise<void>;
```

#### Area Operations

```typescript
// Create
addArea(name: string, initialProps?: Partial<Area>): Promise<void>;

// Update
updateArea(id: string, updates: Partial<Area>): Promise<void>;

// Delete
deleteArea(id: string): Promise<void>;

// Reorder
reorderAreas(orderedIds: string[]): Promise<void>;
```

#### Section Operations

```typescript
// Create
addSection(projectId: string, title: string, initialProps?: Partial<Section>): Promise<Section | null>;

// Update
updateSection(id: string, updates: Partial<Section>): Promise<void>;

// Delete
deleteSection(id: string): Promise<void>;
```

#### Tag Operations

```typescript
// Delete (from all tasks and projects)
deleteTag(tagId: string): Promise<void>;
```

#### Data Operations

```typescript
// Load
fetchData(): Promise<void>;

// Settings
updateSettings(updates: Partial<AppData['settings']>): Promise<void>;
```

---

## Storage Adapter

### setStorageAdapter

Configure the storage backend.

```typescript
import { setStorageAdapter } from '@mindwtr/core';

// Must be called before using the store
setStorageAdapter(myStorageAdapter);
```

### StorageAdapter Interface

```typescript
interface StorageAdapter {
    getData: () => Promise<AppData>;
    saveData: (data: AppData) => Promise<void>;
    queryTasks?: (options: TaskQueryOptions) => Promise<Task[]>;
}
```

---

## Quick-Add Parser

### parseQuickAdd

Parse natural language task input.

```typescript
import { parseQuickAdd } from '@mindwtr/core';

const result = parseQuickAdd(input: string, projects?: Project[]);
```

### Syntax

| Token        | Example            | Result                      |
| ------------ | ------------------ | --------------------------- |
| `@context`   | `@home`            | `contexts: ['@home']`       |
| `#tag`       | `#focused`         | `tags: ['#focused']`        |
| `+Project`   | `+HomeReno`        | `projectId: 'matching-id'`  |
| `!Area`      | `!Work`            | `areaId: 'matching-id'`     |
| `/area:<name>` | `/area:Personal` | `areaId: 'matching-id'`     |
| `/due:date`  | `/due:friday`      | `dueDate: 'ISO string'`     |
| `/note:text` | `/note:remember X` | `description: 'remember X'` |
| `/status`    | `/next`            | `status: 'next'` (supports `/inbox`, `/waiting`, `/someday`, `/done`, `/archived`) |

---

## Sync

### performSyncCycle

Execute a full sync cycle (read local -> read remote -> merge -> write back).

```typescript
import { performSyncCycle } from '@mindwtr/core';

const result = await performSyncCycle({
    readLocal: () => Promise<AppData>,
    readRemote: () => Promise<AppData | null>,
    writeLocal: (data) => Promise<void>,
    writeRemote: (data) => Promise<void>
});
```

### mergeAppData

Merge two AppData objects using Last-Write-Wins.

```typescript
import { mergeAppData } from '@mindwtr/core';

const merged = mergeAppData(localData: AppData, remoteData: AppData);
```

---

## Internationalization

### translations

Translation strings for all supported languages.

```typescript
import { translations, Language } from '@mindwtr/core';

translations.en['nav.inbox'];  // 'Inbox'
translations.zh['nav.inbox'];  // '收集箱'
```

---

## See Also

- [[Architecture]]
- [[Developer Guide]]
- [Contributing (Repository Guide)](https://github.com/dongdongbh/Mindwtr/blob/main/docs/CONTRIBUTING.md)
