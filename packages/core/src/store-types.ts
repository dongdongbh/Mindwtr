import type { ChecklistProjectConversion } from './checklist-project-conversion';
import type { ProjectTaskSummary } from './project-row-meta';
import type { FocusStarAction } from './focus-star';
import type { AppData, Area, Attachment, FilterCriteria, FocusGroupBy, Person, Project, SavedFilter, SavedSearch, Section, SortField, Task, TaskStatus } from './types';
import type { TaskQueryOptions } from './storage';
import type { TaskDateCoherenceIssue } from './task-date-coherence';
import type { TaskTokenUsage } from './task-token-usage';
import type { ProcessInboxPlan } from './process-inbox-plan';
import type { AreaOrderIntent } from './area-ordering';
import type { ProjectTaskOrderAnchor, ProjectTaskOrderIdentity } from './project-task-reorder';
import type { FocusControlState } from './focus-controls';
import type { PreparedProjectToSection, ProjectToSectionReceipt } from './project-to-section';

/** Per-call saved authority for the three prepared Area commands; never journaled. */
export type PreparedNativeSaveBoundary = { taskReference: Task[]; lastDataChangeAt: number;
    generation: number; failure: TaskStore['persistenceFailure'] };
export type PreparedAreaAuthority = { snapshot: AppData; state: Pick<TaskStore,
    '_allTasks' | '_allProjects' | '_allSections' | '_allAreas' | '_allPeople' | 'settings' | 'lastDataChangeAt'>;
    saveBoundary?: PreparedNativeSaveBoundary; rawSavedSnapshot?: AppData };

/** Invocation-local Project availability effect; never a journal or replay capability. */
export type SelectedProjectAvailabilityWrite = {
    projectId: string; attachmentId: string; targetURI: string;
    /** Closed private WebDAV variants; omitted for existing availability writes. */
    outcome?: 'noop' | 'unrecoverable';
    before: Project; after: Project; rawBefore: unknown[]; rawAfter: unknown[];
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string;
};

export type StoreActionResult = {
    success: boolean;
    error?: string;
    id?: string;
    ids?: string[];
    /** For promoteTaskToProject: true when an existing same-named project was reused instead of created. */
    reused?: boolean;
};

/** Internal native journal mutation. Null is an explicit clear, never omission. */
export type PreparedTaskEdit = {
    before: Task;
    changes: { [K in keyof Task]?: Exclude<Task[K], undefined> | null };
};
export type PreparedTaskEditResult = StoreActionResult & {
    outcome?: 'applied' | 'replayed';
    reason?: 'missing' | 'conflict' | 'invalid';
};

/** Compact fields consulted by the shared Focus eligibility and cap policy. */
export type TaskFocusWitnessRow = Pick<Task, 'id' | 'status' | 'createdAt'> & {
    projectId: string | null; sectionId: string | null; startTime: string | null;
    dueDate: string | null; reviewAt: string | null; order: number | null; orderNum: number | null;
    isFocusedToday: boolean; recurrence: Task['recurrence'] | null;
};

/** One frozen native task star; the complete changed Task is its durable receipt. */
export type PreparedTaskFocus = {
    scope: { task: Task; project: Project | null; sections: Section[]; area: Area | null;
        peers: TaskFocusWitnessRow[]; focused: TaskFocusWitnessRow[]; focusLimit: number };
    effect: { task: { before: Task; after: Task } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    preparedAt: string;
    preparedLocalDay: string;
    preparedOffsetMinutes: number;
    boundaryOffsetMinutes: number;
    futureBoundary: string;
    dates: import('./task-utils').FocusDateProjection[];
};

/** Frozen visible Focus rows and the sparse, stamped order change. */
export type PreparedFocusOrder = {
    request: { requestId: string; controls: FocusControlState; ids: string[]; expectedOrder: string };
    scope: { tasks: Task[] };
    effect: { tasks: Array<{ before: Task; after: Task }> };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    preparedAt: string;
    result: { ids: string[] };
};

export type FocusSavedFilterOperation = { type: 'save' } | { type: 'delete'; id: string }
    | { type: 'removeCriterion'; criterionId: string };
export type FocusSavedFilterRequest = { requestId: string; controls: FocusControlState;
    operation: FocusSavedFilterOperation; name: string | null; expected: string };
export type FocusSavedFilterResult = { controls: FocusControlState; id: string };
export type PreparedFocusSavedFilter = {
    version: 1;
    request: FocusSavedFilterRequest;
    scope: { before: SavedFilter | null; creation: {
        canSave: boolean; currentCriteria: FilterCriteria; effectiveSortBy: SortField;
        effectiveGroupBy: FocusGroupBy;
    } | null };
    after: SavedFilter;
    preparedAt: string;
    result: FocusSavedFilterResult;
};

export type SavedSearchWriteOperation = { type: 'save'; query: string } | { type: 'delete'; id: string };
export type SavedSearchWriteRequest = { requestId: string; operation: SavedSearchWriteOperation;
    name: string | null; expected: string };
export type SavedSearchWriteResult = { id: string; existing: boolean; changed: boolean };
/** Null denotes absence; the booleans preserve the distinction from an empty collection. */
export type SavedSearchWriteScope = { savedSearchesPresent: boolean; savedSearches: SavedSearch[] | null;
    stampPresent: boolean; stamp: string | null };
export type PreparedSavedSearchWrite = { version: 1; request: SavedSearchWriteRequest;
    before: SavedSearchWriteScope; after: SavedSearchWriteScope; preparedAt: string;
    result: SavedSearchWriteResult };

/** One frozen project-only creation. The full project row is its durable receipt. */
export type PreparedProjectCreate = {
    project: Project;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    selectedArea: { id: string; name: string; color: string | null; deletedAt: null } | null;
    orderMax: number;
    defaultProjectFlowMode: string | null;
};

/** One saved task move, with an optional new project, and complete written-row receipts. */
export type PreparedTaskPromotion = {
    sourceBefore: Task;
    sourceProject: Project | null;
    selectedArea: Area | null;
    selectedProject: Project | null;
    projectOrderMax: number | null;
    taskOrderMax: number | null;
    defaultProjectFlowMode: string | null;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    tasks: Array<{ before: Task; after: Task }>;
    projects: Array<{ before: null; after: Project }>;
    sections: [];
};

/** One frozen native Project Focus star change and its complete Project receipt. */
export type PreparedProjectFocus = {
    scope: { project: Project; focusedProjectCount: number };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

/** One frozen native Project title edit and its complete Project receipt. */
export type PreparedProjectRename = {
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

export type ProjectFlowAction = { kind: 'toggleType' }
    | { kind: 'setScope'; scope: 'project' | 'section' };

/** One frozen native Project type or sequential-scope change and its complete Project receipt. */
export type PreparedProjectFlow = {
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

/** One frozen synced Project task sort change; Task and Section rows are untouched. */
export type PreparedProjectTaskSort = {
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

/** One frozen native raw Project Notes edit and its complete Project receipt. */
export type PreparedProjectNotesWrite = {
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

/** One frozen native Project Tags edit and its complete Project receipt. */
export type PreparedProjectTagsWrite = {
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

export type ProjectAttachmentIntent = { kind: 'add'; text: string } | { kind: 'remove'; attachmentId: string };
export type ProjectFileRemoveIntent = Extract<ProjectAttachmentIntent, { kind: 'remove' }>;

/** One frozen native Project URL attachment change and its complete Project receipt. */
export type PreparedProjectAttachmentWrite = {
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

/** One frozen metadata-only Project file removal and its complete Project receipt. */
export type PreparedProjectFileRemoveWrite = PreparedProjectAttachmentWrite & { version: 2 };

/** Frozen Project file Add metadata; native publication proof grants byte authority separately. */
export type PreparedProjectFileAddWrite = PreparedProjectAttachmentWrite & {
    version: 3 | 4;
    kind: 'project-file-add';
    attachment: Attachment;
};

/** One frozen nonarchived Project status change and its complete Project receipt. */
export type PreparedProjectStatus = {
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

/** One frozen restore of a deleted Project and only its cascade-stamped children. */
export type PreparedTrashProjectRestore = {
    request: { requestId: string; projectId: string; projectRevision: string };
    scope: { project: Project; tasks: Task[]; sections: Section[]; area: Area | null };
    effect: { project: { before: Project; after: Project };
        tasks: { before: Task; after: Task }[]; sections: { before: Section; after: Section }[] };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
    result: { id: string };
};

/** Frozen Project Delete: section-linked inconsistent Tasks are part of the relevant scope. */
export type PreparedProjectDelete = {
    request: { requestId: string; projectId: string; projectRevision: string; source?: 'archive' };
    scope: { project: Project; tasks: Task[]; sections: Section[] };
    effect: { project: { before: Project; after: Project };
        tasks: { before: Task; after: Task }[]; sections: { before: Section; after: Section }[] };
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string;
    result: { id: string; deletion: { message: string; undoLabel: string; undoEnabled: true } };
};

/** Frozen Undo reads current Task content and the confirmed Delete relationship proof. */
export type PreparedProjectDeleteUndo = {
    request: { requestId: string; deleteRequestId: string };
    delete: { request: PreparedProjectDelete['request']; prepared: PreparedProjectDelete & { version: 1 } };
    scope: { project: Project; tasks: Task[]; sections: Section[]; area: Area | null;
        linkedTasks: { id: string; row: Task | null }[] };
    effect: { project: { before: Project; after: Project };
        tasks: { before: Task; after: Task }[]; sections: { before: Section; after: Section }[] };
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string;
    result: { id: string };
};

/** One RN-policy Project copy with frozen IDs and full source/order membership. */
export type PreparedProjectDuplicate = {
    version: 1;
    request: { requestId: string; projectId: string; projectRevision: string };
    scope: { project: Project; sections: Section[]; tasks: Task[];
        sameAreaProjects: Project[]; area: Area | null };
    ids: string[];
    effect: { project: Project; sections: Section[]; tasks: Task[] };
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string;
    result: { id: string; message: string };
};

/** One frozen RN Project Complete/Cancel/Reactivate transition and child-row receipt. */
export type PreparedProjectLifecycle = {
    version: 1;
    request: { requestId: string; projectId: string; projectRevision: string;
        action: 'complete' | 'cancel' | 'reactivate' };
    scope: { project: Project; tasks: Task[]; sections: Section[] };
    effect: { project: { before: Project; after: Project };
        tasks: { before: Task; after: Task }[]; sections: { before: Section; after: Section }[] };
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string;
    result: { id: string; status: 'archived' | 'active' };
};

/** One frozen Project date change and its complete Project receipt. */
export type PreparedProjectDate = {
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

/** One frozen Project Area assignment with its selected Area and destination-order witness. */
export type PreparedProjectArea = {
    scope: { project: Project; selectedArea: { id: string; name: string } | null; orderMax: number };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

/** Frozen parent/order witness and the new Section's complete receipt. */
export type PreparedProjectSectionCreate = {
    request: { requestId: string; projectId: string; title: string };
    scope: { project: Project; orderMax: number };
    section: Section;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    preparedAt: string;
};

/** Frozen parent and complete before/after Section rows for a native rename. */
export type PreparedProjectSectionRename = {
    scope: { project: Project };
    effect: { section: { before: Section; after: Section } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    preparedAt: string;
};

/** Frozen Section tombstone and every linked Task detach, including trashed Tasks. */
export type PreparedProjectSectionDelete = {
    scope: { project: Project; section: Section; tasks: Task[] };
    effect: { section: { before: Section; after: Section };
        tasks: Array<{ before: Task; after: Task }> };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    preparedAt: string;
};

/** Frozen complete live Section scope and sparse order effect for a native move. */
export type PreparedProjectSectionOrder = {
    request: { requestId: string; projectId: string; sectionId: string; direction: 'up' | 'down';
        expectedSections: Section[] };
    scope: { project: Project; sections: Section[] };
    effect: { sections: Array<{ before: Section; after: Section }> };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    preparedAt: string;
    result: { projectId: string; orderedIds: string[] };
};

export type PreparedProjectTaskOrder = {
    request: { requestId: string; projectId: string; taskId: string; after: ProjectTaskOrderAnchor;
        showCompleted: boolean; filters: Partial<import('./list-filter-state').ListFilterState>; expectedOrder: string };
    scope: { project: Project; tasks: Task[]; sections: Section[]; settings: AppData['settings'];
        items: ProjectTaskOrderIdentity[] };
    effect: { tasks: Array<{ before: Task; after: Task }> };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    preparedAt: string;
    result: { projectId: string; taskId: string; sectionId: string | null };
};

/** Frozen single-Person addition; restoring metadata never restores Tasks. */
export type PreparedPersonCreate = {
    kind: 'fresh' | 'restored';
    scope: { person: Person | null };
    effect: { person: { before: Person | null; after: Person } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

/** Frozen single-Person deletion; assignments and all other rows remain untouched. */
export type PreparedPersonDelete = {
    scope: { person: Person };
    effect: { person: { before: Person; after: Person } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

/** Frozen atomic final state of the existing metadata-then-rename Person editor. */
export type PreparedPersonEdit = {
    scope: import('./person-edit').PersonEditScope;
    effect: import('./person-edit').PersonEditEffect;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
    renameAt: string | null;
    result: import('./person-edit').PersonEditResult;
    request: { requestId: string; personId: string; expected: Person; name: string; note: string; referenceLink: string };
};

/** Frozen final rows for a native Area create or legacy tombstone restoration. */
export type PreparedAreaCreate = {
    kind: 'fresh' | 'restored';
    scope: { area: Area | null; projects: Project[]; sections: Section[]; tasks: Task[] };
    effect: {
        area: { before: Area | null; after: Area };
        projects: Array<{ before: Project; after: Project }>;
        sections: Array<{ before: Section; after: Section }>;
        tasks: Array<{ before: Task; after: Task }>;
    };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    orderMax: number;
    restoreAt: string;
    updateAt: string;
};

/** Frozen Area recolor and all linked Project rows the RN writer inspected. */
export type PreparedAreaColor = {
    scope: { area: Area; projects: Project[] };
    effect: { area: { before: Area; after: Area }; projects: Array<{ before: Project; after: Project }> };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

/** Frozen live Area resolution inventory and complete linked-row witnesses for rename/merge. */
export type PreparedAreaRename = {
    scope: { areas: Area[]; projects: Project[]; tasks: Task[] };
    effect: {
        areas: Array<{ before: Area; after: Area }>;
        projects: Array<{ before: Project; after: Project }>;
        tasks: Array<{ before: Task; after: Task }>;
    };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

/** Frozen order revision for every live Area, including unchanged numeric orders. */
export type PreparedAreaOrder = {
    scope: { areas: Area[] };
    effect: { areas: Array<{ before: Area; after: Area }> };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

/** Frozen native Area tombstone and directly linked detach rows. */
export type PreparedAreaDelete = {
    scope: { area: Area; tasks: Task[]; liveProjects: Project[] };
    effect: { area: { before: Area; after: Area }; tasks: Array<{ before: Task; after: Task }>;
        projects?: Array<{ before: Project; after: Project }> };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

/** Complete raw carrier scope and effects for one managed Context or Tag write. */
export type PreparedTaxonomy = {
    request: { requestId: string; kind: import('./taxonomy-policy').TaxonomyKind;
        action: import('./taxonomy-policy').TaxonomyAction; name: string; to: string | null;
        expected: import('./taxonomy-policy').TaxonomyScope };
    scope: import('./taxonomy-policy').TaxonomyScope;
    effect: import('./taxonomy-policy').TaxonomyEffect;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
    result: { kind: import('./taxonomy-policy').TaxonomyKind;
        action: import('./taxonomy-policy').TaxonomyAction; name: string; to: string | null };
};

/** Internal native Board journal: before is the source guard, after the sole written row. */
export type PreparedBoardTask = {
    kind: 'duplicateTask' | 'trashTask' | 'restoreTask';
    before: Task;
    after: Task;
    /** Restore binds the device stamp captured when its prepared effect was planned. */
    deviceIdBefore?: string | null;
    deviceIdToInitialize: string | null;
    /** Calendar and editor Delete refuse a newly archived parent inside the atomic commit. */
    respectReadOnly?: true;
    /** Archive Delete requires its saved preimage; only its exact UUID receipt can replay. */
    strictBefore?: true;
};

/** One frozen Calendar scheduling row; its complete after-row is the receipt. */
export type PreparedCalendarTask = {
    before: Task;
    after: Task;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
};

/** Native Calendar New task: the task row is the receipt, project is an atomic companion. */
export type PreparedCalendarCreate = {
    task: Task;
    project: Project | null;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    /** Event copy only: a fixed default Area's presence/deletion, including absence. */
    defaultAreaWitness?: { id: string; before: { deletedAt: string | null } | null } | null;
    intent: { props: Partial<Task>; projectToCreate: { name: string; color: string; areaId: string | null } | null };
    creation: {
        selectedProject: Project | null;
        areas: Area[];
        projectOrderMax: number | null;
        taskOrderMax: number | null;
        defaultAreaMode: string | null;
        defaultAreaId: string | null;
        defaultProjectFlowMode: string | null;
        focusCount: number;
        focusLimit: number;
        focusRequested: boolean;
        sequentialEmpty: boolean;
        focusEndOfTodayIso: string | null;
        focusEndOffsetMinutes: number | null;
        preparedOffsetMinutes: number;
        preparedLocalDay: string;
    };
};

/** One Process Inbox decision's complete atomic affected-row set. */
export type PreparedInboxEffect = {
    kind: 'decision' | 'skip' | 'projectCreate';
    tasks: Array<{ before: Task | null; after: Task }>;
    projects: Array<{ before: Project | null; after: Project }>;
    sections: Array<{ before: Section | null; after: Section }>;
    sourceBefore: Task;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    guards: {
        selectedProject: Project | null;
        selectedArea: Area | null;
        projectOrder: { areaId: string | null; max: number } | null;
        taskOrders: Array<{ projectId: string; max: number }>;
        reactivation: { projectId: string; taskIds: string[]; sectionIds: string[] } | null;
        recurringCandidate: Task | null;
        recurringDuplicate: Task | null;
        defaultScheduleTime: string | null;
        defaultProjectFlowMode: string | null;
        creationSettings: { defaultAreaMode: string | null; defaultAreaId: string | null;
            defaultProjectFlowMode: string | null } | null;
        plan: ProcessInboxPlan;
        focusCount: number | null;
        focusLimit: number | null;
        focusBoundary: string | null;
    };
};

/** A native checklist Save or Reset's complete, bounded atomic affected-row set. */
export type PreparedChecklistEffect = {
    tasks: Array<{ before: Task | null; after: Task }>;
    projects: Array<{ before: Project | null; after: Project }>;
    sections: Array<{ before: Section | null; after: Section }>;
    sourceBefore: Task;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    guards: {
        selectedProject: Project | null;
        selectedArea: Area | null;
        taskOrders: Array<{ projectId: string; max: number }>;
        reactivation: { projectId: string; taskIds: string[]; sectionIds: string[] } | null;
        recurringCandidate: Task | null;
        recurringDuplicate: Task | null;
        focusCount: number | null;
        focusLimit: number | null;
        focusBoundary: string | null;
        autoArchiveDays: number | null;
    };
};

/** Exact command-bound durable rows, including generated identifier absence. */
export type PreparedChecklistRawBefore = {
    tasks: Array<{ id: string; before: Task | null }>;
    projects: Array<{ id: string; before: Project | null }>;
    sections: Array<{ id: string; before: Section | null }>;
};
export type PreparedChecklistWriteOptions = { requireBefore?: boolean } | {
    requireBefore: true; authority: PreparedAreaAuthority; rawBefore: PreparedChecklistRawBefore;
};

/** Device-local recovery state for a snapshot that exhausted durable-save retries. */
export type PersistenceFailure = {
    message: string;
    failedAt: string;
    retrying: boolean;
};

/**
 * Core application state interface.
 *
 * IMPORTANT: `tasks` and `projects` contain only VISIBLE (non-deleted) items for UI.
 * The store internally tracks ALL items (including soft-deleted) for persistence.
 */
export interface TaskStore {
    tasks: Task[];
    projects: Project[];
    sections: Section[];
    areas: Area[];
    people: Person[];
    settings: AppData['settings'];
    isLoading: boolean;
    error: string | null;
    /** Ephemeral device-local state. This is deliberately excluded from AppData and sync. */
    persistenceFailure: PersistenceFailure | null;
    /** Number of active edit locks (prevents fetchData from clobbering in-progress edits). */
    editLockCount: number;
    /** Updated whenever tasks/projects change (not settings) */
    lastDataChangeAt: number;
    /** Ephemeral highlight task id for UI navigation */
    highlightTaskId: string | null;
    highlightTaskAt: number | null;

    // Internal: full data including tombstones (not exposed to UI)
    _allTasks: Task[];
    _allProjects: Project[];
    _allSections: Section[];
    _allAreas: Area[];
    _allPeople: Person[];
    _tasksById: Map<string, Task>;
    _projectsById: Map<string, Project>;
    _sectionsById: Map<string, Section>;
    _areasById: Map<string, Area>;
    _peopleById: Map<string, Person>;

    /** Set the synced Archive expiration policy; zero disables it. */
    setArchiveRetentionDays: (days: number) => Promise<StoreActionResult>;
    /** Expire eligible Archive records from the latest store state. */
    runArchiveRetention: () => Promise<StoreActionResult>;

    // Actions
    /** Load all data from storage, or apply an already-persisted snapshot without re-reading storage */
    fetchData: (options?: {
        silent?: boolean;
        preloadedData?: AppData;
        /** Re-throw storage failures after updating store error state. */
        throwOnError?: boolean;
        /** Exclusive native owner only: preserve adapter rows while resolving a durable journal.
         * Run a normal load before exposing UI to resume normalization and migrations. */
        recoveryLoad?: boolean;
        /** Skip applying or acknowledging the read when its owning lifecycle has ended. */
        isResultStillRelevant?: () => boolean;
    }) => Promise<void>;
    /** Add the shared Getting Started project/tasks when missing, localized to the given app language. */
    seedGettingStarted: (options?: { language?: string }) => Promise<StoreActionResult>;
    /** Add a new task */
    addTask: (
        title: string,
        initialProps?: Partial<Task>,
        options?: { captureId: string },
    ) => Promise<StoreActionResult>;
    /** Add multiple new tasks in a single store update */
    addTasks: (items: Array<{
        title: string;
        initialProps?: Partial<Task>;
        captureId?: string;
    }>) => Promise<StoreActionResult>;
    /** Internal prepared-capture commit; the native contract validates the journal envelope first. */
    commitPreparedCapture: (input: {
        task: Task;
        project: Project | null;
        deviceIdToInitialize: string | null;
        deviceIdBefore?: string | null;
    }, options?: Extract<PreparedChecklistWriteOptions, { authority: PreparedAreaAuthority }>) => Promise<StoreActionResult>;
    /** Internal prepared edit; native validates the journal before this atomic guarded overlay. */
    commitPreparedTaskEdit: (input: PreparedTaskEdit) => Promise<PreparedTaskEditResult>;
    /** Native one-task raw overlay; the calling contract validates its effect and guards. */
    commitPreparedTaskDraftV2: (input: Pick<import('./native-host-contract-task-save').NativePreparedTaskDraftSaveV2,
        'deviceIdBefore' | 'deviceIdToInitialize' | 'effect'> & { request: { id: string } },
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedArchivedTaskRestore: (input: import('./native-host-contract-archive-task-restore').NativePreparedArchivedTaskRestore,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    /** One guarded raw batch overlay; the contract validates complete scope and RN effect first. */
    commitPreparedArchivedTasksRestore: (input: Pick<import('./native-host-contract-archive-bulk-restore').NativePreparedArchivedTasksRestore,
        'request' | 'effect' | 'deviceIdBefore' | 'deviceIdToInitialize'>,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    /** Reference-only atomic batch, including all shared recurrence-created rows. */
    commitPreparedReferenceTasksMove: (input: import('./native-host-contract-reference-bulk-status').NativeReferenceTasksMovePrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    /** Reference Add tag's shared guarded raw batch; contract validates all selected members. */
    commitPreparedReferenceTasksAddTag: (input: import('./native-host-contract-reference-bulk-tag').NativeReferenceTasksAddTagPrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    /** Reference Remove tag's guarded raw batch, including unchanged selected noncarriers. */
    commitPreparedReferenceTasksRemoveTag: (input: import('./native-host-contract-reference-bulk-remove-tag').NativeReferenceTasksRemoveTagPrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    /** Selected-row raw Delete/Undo overlay; native validates the full effect and receipt guards. */
    commitPreparedArchivedTasksMutation: (input: {
        operation: 'delete' | 'undo'; before: Task[]; after: Task[];
        deviceIdBefore: string | null; deviceIdToInitialize: string | null;
    }, authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedTaskFocus: (input: PreparedTaskFocus & { request: { taskId: string; focused: boolean } }) => Promise<PreparedTaskEditResult>;
    commitPreparedFocusOrder: (input: PreparedFocusOrder) => Promise<PreparedTaskEditResult>;
    commitPreparedFocusSavedFilter: (input: PreparedFocusSavedFilter) => Promise<PreparedTaskEditResult>;
    commitPreparedSavedSearchWrite: (input: PreparedSavedSearchWrite) => Promise<PreparedTaskEditResult>;
    /** Native validates the action-specific envelope before this atomic guarded write. */
    commitPreparedBoardTask: (input: PreparedBoardTask) => Promise<PreparedTaskEditResult>;
    commitPreparedCalendarTask: (input: PreparedCalendarTask) => Promise<PreparedTaskEditResult>;
    commitPreparedCalendarCreate: (input: PreparedCalendarCreate) => Promise<PreparedTaskEditResult>;
    commitPreparedInboxEffect: (input: PreparedInboxEffect) => Promise<PreparedTaskEditResult>;
    commitPreparedChecklistEffect: (input: PreparedChecklistEffect, options?: PreparedChecklistWriteOptions) => Promise<PreparedTaskEditResult>;
    /** Update an existing task */
    updateTask: (id: string, updates: Partial<Task>) => Promise<StoreActionResult>;
    /** Archive a task as cancelled without completing it */
    cancelTask: (id: string) => Promise<StoreActionResult>;
    /** Skip one fixed-schedule occurrence without recording completion */
    skipRecurringTaskOccurrence: (id: string) => Promise<StoreActionResult>;
    /** Soft-delete a task */
    deleteTask: (id: string) => Promise<StoreActionResult>;
    /** Restore a soft-deleted task */
    restoreTask: (id: string) => Promise<StoreActionResult>;
    /** Restore multiple soft-deleted tasks in one store update */
    restoreTasks: (ids: string[]) => Promise<StoreActionResult>;
    /** Permanently remove a task from storage */
    purgeTask: (id: string) => Promise<StoreActionResult>;
    /** Permanently remove multiple soft-deleted tasks from storage in one store update */
    purgeTasks: (ids: string[]) => Promise<StoreActionResult>;
    /** Permanently remove all soft-deleted tasks from storage */
    purgeDeletedTasks: () => Promise<StoreActionResult>;
    /** Duplicate a task (useful for reusable lists/templates) */
    duplicateTask: (id: string, asNextAction?: boolean, copyId?: string) => Promise<StoreActionResult>;
    /** Convert a task into a section of its project; checklist items become tasks and the task is soft-deleted */
    convertTaskToSection: (id: string) => Promise<StoreActionResult>;
    /** Create or reuse a project from a task, then move the task into it */
    convertChecklistToProject: (command: ChecklistProjectConversion) => Promise<StoreActionResult>;
    undoChecklistToProject: (command: ChecklistProjectConversion) => Promise<StoreActionResult>;
    /** Create or reuse a project from a task, then move the task into it. */
    promoteTaskToProject: (id: string, options?: { title?: string; color?: string; areaId?: string }) => Promise<StoreActionResult>;
    /** Reset checklist items to unchecked */
    resetTaskChecklist: (id: string) => Promise<StoreActionResult>;
    /** Move task to a different status */
    moveTask: (id: string, newStatus: TaskStatus) => Promise<StoreActionResult>;
    /** Batch update multiple tasks */
    batchUpdateTasks: (updates: Array<{ id: string; updates: Partial<Task> }>) => Promise<StoreActionResult>;
    /** Batch move tasks to a status */
    batchMoveTasks: (ids: string[], newStatus: TaskStatus) => Promise<StoreActionResult>;
    /** Batch soft-delete tasks */
    batchDeleteTasks: (ids: string[]) => Promise<StoreActionResult>;
    /** Reorder Today's Focus by id list, assigning focusOrder 0..n-1 in one update */
    reorderFocusedTasks: (orderedIds: string[]) => Promise<StoreActionResult>;
    /** Query tasks using storage adapter when available */
    queryTasks: (options: TaskQueryOptions) => Promise<Task[]>;
    /** Resolve the Today's Focus star action for a task: eligibility, cap, label key, patch */
    getFocusStarAction: (task: Task, options?: { allowUnclarified?: boolean }) => FocusStarAction;
    /** Set or clear global error state */
    setError: (error: string | null) => void;
    /** Re-enqueue the authoritative in-memory snapshot and wait for a durable save. */
    retryPersistence: () => Promise<void>;
    /** Increment edit lock count */
    lockEditing: () => void;
    /** Decrement edit lock count */
    unlockEditing: () => void;

    // Project Actions
    /** Add a new project */
    addProject: (title: string, color: string, initialProps?: Partial<Project>) => Promise<Project | null>;
    /** Private native journal writer; the contract validates the frozen project first. */
    commitPreparedProjectCreate: (input: PreparedProjectCreate) => Promise<PreparedTaskEditResult>;
    commitPreparedTaskPromotion: (input: PreparedTaskPromotion & { request: { requestId: string; taskId: string; taskRevision: string; title: string }; result: { id: string; reused: boolean } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectFocus: (input: PreparedProjectFocus & { request: { projectId: string; focused: boolean } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectRename: (input: PreparedProjectRename & { request: { projectId: string; title: string } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectFlow: (input: PreparedProjectFlow & { request: { projectId: string; action: ProjectFlowAction } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectTaskSort: (input: PreparedProjectTaskSort & { request: { projectId: string; sortBy: import('./types').TaskSortBy } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectNotesWrite: (input: PreparedProjectNotesWrite & { request: { projectId: string; text: string } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectTagsWrite: (input: PreparedProjectTagsWrite & { request: { projectId: string; intent: import('./project-tags').ProjectTagsIntent } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectAttachmentWrite: (input: PreparedProjectAttachmentWrite & { request: { projectId: string; requestId: string; intent: ProjectAttachmentIntent }; result: { id: string; attachmentIds: string[] } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectFileRemoveWrite: (input: PreparedProjectFileRemoveWrite & { request: { projectId: string; requestId: string; intent: ProjectFileRemoveIntent }; result: { id: string; attachmentIds: string[] } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectFileAddWrite: (input: PreparedProjectFileAddWrite & { request: { projectId: string; requestId: string; version?: 2; sourceSha256?: string }; result: { id: string; attachmentIds: string[] } }, authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitSelectedProjectAvailability: (input: SelectedProjectAvailabilityWrite, authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    /** Private frozen ordinary availability; exact-after replay performs no write. */
    commitPreparedProjectFileAvailability: (input: SelectedProjectAvailabilityWrite, authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectStatus: (input: PreparedProjectStatus & { request: { projectId: string; status: 'active' | 'waiting' | 'someday' } }) => Promise<PreparedTaskEditResult>;
    commitPreparedTrashProjectRestore: (input: PreparedTrashProjectRestore) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectDelete: (input: PreparedProjectDelete) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectDeleteUndo: (input: PreparedProjectDeleteUndo) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectDuplicate: (input: PreparedProjectDuplicate) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectLifecycle: (input: PreparedProjectLifecycle, options?: Extract<PreparedChecklistWriteOptions, { authority: PreparedAreaAuthority }>) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectDate: (input: PreparedProjectDate & { request: { projectId: string; field: 'startDate' | 'dueDate' | 'reviewAt'; value: string | null } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectArea: (input: PreparedProjectArea & { request: { projectId: string; areaId: string | null } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectSectionCreate: (input: PreparedProjectSectionCreate) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectSectionRename: (input: PreparedProjectSectionRename & { request: {
        projectId: string; sectionId: string; title: string } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectSectionDelete: (input: PreparedProjectSectionDelete & { request: {
        projectId: string; sectionId: string } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectSectionOrder: (input: PreparedProjectSectionOrder) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectTaskOrder: (input: PreparedProjectTaskOrder) => Promise<PreparedTaskEditResult>;
    commitPreparedAreaCreate: (input: PreparedAreaCreate & { request: { requestId: string; name: string; color: string; expectedAreaId: string } }, authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedAreaColor: (input: PreparedAreaColor & { request: { requestId: string; areaId: string; color: string | null } }) => Promise<PreparedTaskEditResult>;
    commitPreparedAreaRename: (input: PreparedAreaRename & { request: { requestId: string; areaId: string; name: string; manageColor?: string };
        result: { id: string; areaId: string; name: string } }, authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedAreaOrder: (input: PreparedAreaOrder & { request: { requestId: string; intent: AreaOrderIntent; expectedAreas: unknown[] }; result: { orderedIds: string[] } }) => Promise<PreparedTaskEditResult>;
    commitPreparedAreaDelete: (input: PreparedAreaDelete & { request: { requestId: string; areaId: string;
        detachProjects?: true }; result: { areaId: string } }, authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedTaxonomy: (input: PreparedTaxonomy, authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    /** Four synced General preference fields, prepared against a saved scalar and sync-group stamp. */
    commitPreparedGeneralPreference: (input: import('./native-host-contract-general-preference').NativePreparedGeneralPreference,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    /** One GTD workflow scalar and its group stamp, applied against raw saved authority. */
    commitPreparedGtdWorkflow: (input: import('./native-host-contract-gtd-workflow').NativePreparedGtdWorkflow,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    /** One raw device-local security field, compared and queued against fresh durable authority. */
    commitPreparedAppLock: (request: import('./native-host-contract-app-lock').AppLockRequest,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    retryPreparedAppLockSnapshot: (authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    /** One device-local notification scalar, without a synced preference stamp. */
    commitPreparedNotificationSetting: (request: import('./native-host-contract-notification-settings').NotificationSettingRequest,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    retryPreparedNotificationSettingSnapshot: (authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    /** Existing subscription metadata, saved only in canonical synced SQL settings. */
    commitPreparedCalendarSubscriptionSetting: (prepared: import('./native-host-contract-calendar-subscription-settings').PreparedCalendarSubscriptionSetting,
        authority: PreparedAreaAuthority, legacyRaw: string | null) => Promise<PreparedTaskEditResult>;
    commitPreparedCalendarSubscriptionAdd: (prepared: import('./native-host-contract-calendar-subscription-add').PreparedCalendarSubscriptionAdd,
        authority: PreparedAreaAuthority, legacyRaw: string | null) => Promise<PreparedTaskEditResult>;
    retryPreparedCalendarSubscriptionSettingSnapshot: (authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    /** Update a project */
    updateProject: (id: string, updates: Partial<Project>) => Promise<StoreActionResult>;
    /** Archive a project as cancelled and cancel its unfinished child tasks */
    cancelProject: (id: string) => Promise<StoreActionResult>;
    /** Delete a project */
    deleteProject: (id: string) => Promise<StoreActionResult>;
    /** Restore a soft-deleted project and its cascaded children */
    restoreProject: (id: string) => Promise<StoreActionResult>;
    /** Permanently remove a soft-deleted project from Trash */
    purgeProject: (id: string) => Promise<StoreActionResult>;
    /** Permanently remove all soft-deleted projects from Trash */
    purgeDeletedProjects: () => Promise<StoreActionResult>;
    /** Duplicate a project with its sections/tasks (fresh task state) */
    duplicateProject: (id: string) => Promise<Project | null>;
    /** Toggle focus status of a project (max 5) */
    toggleProjectFocus: (id: string) => Promise<void>;
    /** Confirm one frozen project-to-section plan; success means the coordinated save is durable. */
    convertProjectToSection: (command: PreparedProjectToSection) => Promise<
        { success: true; receipt: ProjectToSectionReceipt; sectionId: string; destinationProjectId: string }
        | { success: false; reason: 'conflict' | 'save-failed' | 'invalid'; error: string }>;
    /** Reverse owned assignments while retaining subsequent unrelated Task edits. */
    undoProjectToSection: (receipt: ProjectToSectionReceipt) => Promise<
        { success: true; sourceProjectId: string }
        | { success: false; reason: 'conflict' | 'save-failed' | 'invalid'; error: string }>;

    // Section Actions
    /** Add a new section within a project */
    addSection: (projectId: string, title: string, initialProps?: Partial<Section>) => Promise<Section | null>;
    /** Update a section */
    updateSection: (id: string, updates: Partial<Section>) => Promise<StoreActionResult>;
    /** Delete a section and clear sectionId on child tasks */
    deleteSection: (id: string) => Promise<StoreActionResult>;
    /** Reorder sections within a project by id list */
    reorderSections: (projectId: string, orderedIds: string[]) => Promise<void>;

    // Area Actions
    /** Add a new area */
    addArea: (name: string, initialProps?: Partial<Area>) => Promise<Area | null>;
    /** Update an area */
    updateArea: (id: string, updates: Partial<Area>) => Promise<StoreActionResult>;
    /** Soft-delete an area and cascade matching tombstones to child projects/sections/tasks */
    deleteArea: (id: string) => Promise<StoreActionResult>;
    /** Restore a soft-deleted area and children from the same cascade */
    restoreArea: (id: string) => Promise<StoreActionResult>;
    /** Reorder areas by id list */
    reorderAreas: (orderedIds: string[]) => Promise<void>;
    /** Reorder projects within a specific area by id list */
    reorderProjects: (orderedIds: string[], areaId?: string) => Promise<void>;
    /** Reorder tasks within a project or section */
    reorderProjectTasks: (projectId: string, orderedIds: string[], sectionId?: string | null, movedTaskId?: string) => Promise<void>;
    /** Reorder tasks within a Board status column by id list */
    reorderBoardTasks: (status: TaskStatus, orderedIds: string[], movedTaskId?: string) => Promise<void>;

    // People Actions
    /** Add a new managed person for delegated tasks */
    addPerson: (name: string, initialProps?: Partial<Person>) => Promise<Person | null>;
    commitPreparedPersonCreate: (input: PreparedPersonCreate & { request: { requestId: string; name: string; note: string; referenceLink: string; expectedPersonId: string } }) => Promise<PreparedTaskEditResult>;
    commitPreparedPersonEdit: (input: PreparedPersonEdit, authority: {
        snapshot: AppData; taskReference: Task[]; lastDataChangeAt: number; saveBoundary?: PreparedNativeSaveBoundary;
    }) => Promise<PreparedTaskEditResult>;
    commitPreparedPersonDelete: (input: PreparedPersonDelete & { request: { requestId: string; personId: string; expected: Person } }) => Promise<PreparedTaskEditResult>;
    /** Update managed person metadata */
    updatePerson: (id: string, updates: Partial<Person>) => Promise<StoreActionResult>;
    /** Rename a person and optionally update exact task assignments */
    renamePerson: (id: string, name: string, options?: { updateTasks?: boolean }) => Promise<StoreActionResult>;
    /** Soft-delete a managed person without clearing task assignments */
    deletePerson: (id: string) => Promise<StoreActionResult>;
    /** Restore a soft-deleted managed person */
    restorePerson: (id: string) => Promise<StoreActionResult>;

    // Tag Actions
    /** Delete a tag from tasks and projects */
    deleteTag: (tagId: string) => Promise<void>;
    /** Rename a tag across all tasks and projects */
    renameTag: (oldTagId: string, newTagId: string) => Promise<void>;

    // Context Actions
    /** Delete a context from all tasks */
    deleteContext: (context: string) => Promise<void>;
    /** Rename a context across all tasks */
    renameContext: (oldContext: string, newContext: string) => Promise<void>;

    // Settings Actions
    /** Update application settings */
    updateSettings: (updates: Partial<AppData['settings']>) => Promise<void>;
    /** Persist current in-memory snapshot through the save queue */
    persistSnapshot: () => Promise<void>;
    /** Highlight a task in UI lists (non-persistent) */
    setHighlightTask: (id: string | null) => void;

    /** Derived state selector (cached by data references) */
    getDerivedState: () => DerivedState;
    /** Cheap focused-task count (cached by `tasks` array identity); prefer this
     *  over getDerivedState().focusedCount when nothing else derived is needed. */
    getFocusedCount: () => number;
}

export type DerivedState = {
    projectMap: Map<string, Project>;
    tasksById: Map<string, Task>;
    activeTasksByStatus: Map<TaskStatus, Task[]>;
    tasksByProjectId: Map<string, Task[]>;
    tasksByContext: Map<string, Task[]>;
    tasksByTag: Map<string, Task[]>;
    focusedTasks: Task[];
    projectTaskSummaryById: Map<string, ProjectTaskSummary>;
    allContexts: string[];
    allTags: string[];
    contextTokenUsage: TaskTokenUsage[];
    tagTokenUsage: TaskTokenUsage[];
    sequentialProjectIds: Set<string>;
    sequentialWithinSectionProjectIds: Set<string>;
    dateCoherenceIssuesByTaskId: Map<string, TaskDateCoherenceIssue[]>;
    focusedCount: number;
    focusedProjectCount: number;
};

export type DerivedCache = {
    visibleTasksRef: Task[];
    taskLookupRef: Map<string, Task>;
    projectLookupRef: Map<string, Project>;
    day: string;
    value: DerivedState;
};

export type SaveBaseState = Pick<TaskStore, '_allTasks' | '_allProjects' | '_allSections' | '_allAreas' | '_allPeople' | 'settings'>;
