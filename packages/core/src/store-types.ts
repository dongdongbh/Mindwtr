import type { NativePreparedTrashItemsPurge } from './native-host-contract-trash-purge';
import type { NativePreparedTrashItemsRestore } from './native-host-contract-trash-bulk-restore';
import type { ChecklistProjectConversion } from './checklist-project-conversion';
import type { ProjectTaskSummary } from './project-row-meta';
import type { FocusStarAction } from './focus-star';
import type { AppData, Area, Attachment, FilterCriteria, FocusGroupBy, Person, Project, ProjectFlowMode, SavedFilter, SavedSearch, Section, SortField, Task, TaskStatus } from './types';
import type { TaskQueryOptions } from './storage';
import type { TaskDateCoherenceIssue } from './task-date-coherence';
import type { TaskTokenUsage } from './task-token-usage';
import type { ProcessInboxPlan } from './process-inbox-plan';
import type { AreaOrderIntent } from './area-ordering';
import type { ProjectTaskOrderAnchor, ProjectTaskOrderIdentity } from './project-task-reorder';
import type { FocusControlState } from './focus-controls';
import type { PreparedProjectToSection, ProjectToSectionReceipt } from './project-to-section';
import type { FocusDateProjection } from './task-utils';


export type PreparedNativeSaveBoundary = { taskReference: Task[]; lastDataChangeAt: number;
    generation: number; failure: TaskStore['persistenceFailure'] };
export type PreparedAreaAuthority = { snapshot: AppData; state: Pick<TaskStore,
    '_allTasks' | '_allProjects' | '_allSections' | '_allAreas' | '_allPeople' | 'settings' | 'lastDataChangeAt'>;
    saveBoundary?: PreparedNativeSaveBoundary; rawSavedSnapshot?: AppData };


export type SelectedProjectAvailabilityWrite = {
    projectId: string; attachmentId: string; targetURI: string;

    outcome?: 'noop' | 'unrecoverable';
    before: Project; after: Project; rawBefore: unknown[]; rawAfter: unknown[];
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string;
};

export type StoreActionResult = {
    success: boolean;
    error?: string;
    id?: string;
    ids?: string[];

    reused?: boolean;
};


export type PreparedTaskEdit = {
    before: Task;
    changes: { [K in keyof Task]?: Exclude<Task[K], undefined> | null };
};
export type PreparedTaskEditResult = StoreActionResult & {
    outcome?: 'applied' | 'replayed';
    reason?: 'missing' | 'conflict' | 'invalid';
};


export type TaskFocusWitnessRow = Pick<Task, 'id' | 'status' | 'createdAt'> & {
    projectId: string | null; sectionId: string | null; startTime: string | null;
    dueDate: string | null; reviewAt: string | null; order: number | null; orderNum: number | null;
    isFocusedToday: boolean; recurrence: Task['recurrence'] | null;
};


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


export type PreparedFocusOrder = {

    version?: 1 | 2;
    request: { requestId: string; controls: FocusControlState; ids: string[]; expectedOrder: string };
    scope: { tasks: Task[] };
    effect: { tasks: Array<{ before: Task; after: Task }> };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    preparedAt: string;
    result: { ids: string[] };
};

export type FocusSavedFilterOperation = { type: 'save'; view?: 'contexts' } | { type: 'delete'; id: string }
    | { type: 'removeCriterion'; criterionId: string };
export type FocusSavedFilterRequest = { requestId: string; controls: FocusControlState;
    operation: FocusSavedFilterOperation; name: string | null; expected: string };
export type FocusSavedFilterResult = { controls: FocusControlState; id: string; view?: 'contexts' };
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

export type SavedSearchWriteOperation = { type: 'save'; query: string } | { type: 'delete'; id: string }
    | { type: 'sort'; id: string; sort: import('./types').TaskSortBy | null };
export type SavedSearchWriteRequest = { requestId: string; operation: SavedSearchWriteOperation;
    name: string | null; expected: string };
export type SavedSearchWriteResult = { id: string; existing: boolean; changed: boolean };

export type SavedSearchWriteScope = { savedSearchesPresent: boolean; savedSearches: SavedSearch[] | null;
    stampPresent: boolean; stamp: string | null };
export type PreparedSavedSearchWrite = { version: 1; request: SavedSearchWriteRequest;
    before: SavedSearchWriteScope; after: SavedSearchWriteScope; preparedAt: string;
    result: SavedSearchWriteResult };


export type PreparedProjectCreate = {
    project: Project;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    selectedArea: { id: string; name: string; color: string | null; deletedAt: null } | null;
    orderMax: number;
    defaultProjectFlowMode: string | null;
};


export type PreparedTaskToSection = {
    sourceBefore: Task;
    project: Project;
    sectionOrderMax: number;
    taskOrderMax: number;
    taskReminderDefault: string | null;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    tasks: Array<{ before: Task | null; after: Task }>;
    projects: [];
    sections: Array<{ before: null; after: Section }>;
    result: { projectId: string; sectionId: string };
};


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


export type PreparedProjectFocus = {
    scope: { project: Project; focusedProjectCount: number };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};


export type PreparedProjectRename = {
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

export type ProjectFlowAction = { kind: 'toggleType' }
    | { kind: 'setScope'; scope: 'project' | 'section' }
    | { kind: 'flowMode'; mode: ProjectFlowMode }
    | { kind: 'sectionFlow'; sectionId: string; sequential: boolean; expectedSection: Section };

type PreparedProjectFlowBase = {
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

export type PreparedProjectFlowV1 = PreparedProjectFlowBase & {
    version: 1;
    request: { projectId: string; action: Extract<ProjectFlowAction, { kind: 'toggleType' | 'setScope' }> };
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
};

export type PreparedProjectFlowV2 = PreparedProjectFlowBase & {
    version: 2;
    request: { projectId: string; action: Extract<ProjectFlowAction, { kind: 'flowMode' }> };
    scope: { project: Project; sections: Section[] };
    effect: { project: { before: Project; after: Project }; sections: Array<{ before: Section; after: Section }> };
};

export type PreparedProjectFlowV3 = PreparedProjectFlowBase & {
    version: 3;
    request: { projectId: string; action: Extract<ProjectFlowAction, { kind: 'sectionFlow' }> };
    scope: { project: Project; section: Section };
    effect: { section: { before: Section; after: Section } };
};

export type PreparedProjectFlow = PreparedProjectFlowV1 | PreparedProjectFlowV2 | PreparedProjectFlowV3;

export type PreparedProjectTaskSort = {
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};


export type PreparedProjectNotesWrite = {
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};


export type PreparedProjectTagsWrite = {
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};

export type ProjectAttachmentIntent = { kind: 'add'; text: string } | { kind: 'remove'; attachmentId: string };
export type ProjectFileRemoveIntent = Extract<ProjectAttachmentIntent, { kind: 'remove' }>;


export type PreparedProjectAttachmentWrite = {
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};


export type PreparedProjectFileRemoveWrite = PreparedProjectAttachmentWrite & { version: 2 };


export type PreparedProjectFileAddWrite = PreparedProjectAttachmentWrite & {
    version: 3 | 4;
    kind: 'project-file-add';
    attachment: Attachment;
};


export type PreparedProjectStatus = {
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};


export type PreparedTrashProjectRestore = {
    version?: 1 | 2;
    request: { requestId: string; projectId: string; projectRevision: string };
    scope: { project: Project; tasks: Task[]; sections: Section[]; area: Area | null };
    effect: { project: { before: Project; after: Project };
        tasks: { before: Task; after: Task }[]; sections: { before: Section; after: Section }[] };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
    result: { id: string };
};


export type PreparedProjectDelete = {
    request: { requestId: string; projectId: string; projectRevision: string; source?: 'archive' };
    scope: { project: Project; tasks: Task[]; sections: Section[] };
    effect: { project: { before: Project; after: Project };
        tasks: { before: Task; after: Task }[]; sections: { before: Section; after: Section }[] };
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string;
    result: { id: string; deletion: { message: string; undoLabel: string; undoEnabled: true } };
};


export type PreparedProjectDeleteUndo = {
    version?: 1 | 2;
    request: { requestId: string; deleteRequestId: string };
    delete: { request: PreparedProjectDelete['request']; prepared: PreparedProjectDelete & { version: 1 } };
    scope: { project: Project; tasks: Task[]; sections: Section[]; area: Area | null;
        linkedTasks: { id: string; row: Task | null }[] };
    effect: { project: { before: Project; after: Project };
        tasks: { before: Task; after: Task }[]; sections: { before: Section; after: Section }[] };
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string;
    result: { id: string };
};


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


export type PreparedProjectDate = {
    scope: { project: Project };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};


export type PreparedProjectCalendarReference = PreparedProjectDate;

export type PreparedProjectArea = {
    version?: 1 | 2;
    scope: { project: Project; selectedArea: { id: string; name: string; color?: string | null } | null; orderMax: number };
    effect: { project: { before: Project; after: Project } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};


export type PreparedProjectSectionCreate = {
    request: { requestId: string; projectId: string; title: string };
    scope: { project: Project; orderMax: number };
    section: Section;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    preparedAt: string;
};


export type PreparedProjectSectionRename = {
    scope: { project: Project };
    effect: { section: { before: Section; after: Section } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    preparedAt: string;
};


export type PreparedProjectSectionDelete = {
    scope: { project: Project; section: Section; tasks: Task[] };
    effect: { section: { before: Section; after: Section };
        tasks: Array<{ before: Task; after: Task }> };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    preparedAt: string;
};


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

export type PreparedProjectOrder = {
    request: { requestId: string; projectId: string; direction: 'up' | 'down'; tagFilter: string; order: string[] };
    scope: { neighbourId: string; projects: Project[] };
    effect: { projects: Array<{ before: Project; after: Project }> };
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


export type PreparedPersonCreate = {
    kind: 'fresh' | 'restored';
    scope: { person: Person | null };
    effect: { person: { before: Person | null; after: Person } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};


export type PreparedPersonDelete = {
    scope: { person: Person };
    effect: { person: { before: Person; after: Person } };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};


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


export type PreparedAreaCreate = {
    version?: 1 | 2;
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


export type PreparedAreaColor = {
    version?: 1 | 2;
    scope: { area: Area; projects: Project[] };
    effect: { area: { before: Area; after: Area }; projects: Array<{ before: Project; after: Project }> };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};


export type PreparedAreaRename = {
    version?: 1 | 2;
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


export type PreparedAreaOrder = {
    scope: { areas: Area[] };
    effect: { areas: Array<{ before: Area; after: Area }> };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};


export type PreparedAreaDelete = {
    version?: 1 | 2;
    scope: { area: Area; tasks: Task[]; liveProjects: Project[] };
    effect: { area: { before: Area; after: Area }; tasks: Array<{ before: Task; after: Task }>;
        projects?: Array<{ before: Project; after: Project }> };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
};


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


export type PreparedBoardMove = {
    deviceIdBefore: string;
    clock: { preparedLocalDay: string; preparedOffsetMinutes: number; boundaryOffsetMinutes: number;
        futureBoundary: string; dates: FocusDateProjection[] };
    scope: { projects: Project[]; sections: Section[]; areas: Area[];
        focused: TaskFocusWitnessRow[]; focusLimit: number };
};


export type PreparedBoardTask = {
    kind: 'duplicateTask' | 'trashTask' | 'restoreTask' | 'moveCard';
    move?: PreparedBoardMove;

    admitMove?: () => boolean;
    before: Task;
    after: Task;

    deviceIdBefore?: string | null;
    deviceIdToInitialize: string | null;

    respectReadOnly?: true;

    strictBefore?: true;
};


export type PreparedCalendarTask = {
    before: Task;
    after: Task;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
};


export type PreparedCalendarCreate = {
    task: Task;
    project: Project | null;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;

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


export type PreparedChecklistRawBefore = {
    tasks: Array<{ id: string; before: Task | null }>;
    projects: Array<{ id: string; before: Project | null }>;
    sections: Array<{ id: string; before: Section | null }>;
};
export type PreparedChecklistWriteOptions = { requireBefore?: boolean } | {
    requireBefore: true; authority: PreparedAreaAuthority; rawBefore: PreparedChecklistRawBefore;
    frozenTemporal?: { futureBoundary: string; dates: ReadonlyMap<string, FocusDateProjection> };
};


export type PersistenceFailure = {
    message: string;
    failedAt: string;
    retrying: boolean;
};


export type PreparedTrashItemsRestore = NativePreparedTrashItemsRestore;
export type PreparedTrashItemsPurge = NativePreparedTrashItemsPurge;

export interface TaskStore {
    tasks: Task[];
    projects: Project[];
    sections: Section[];
    areas: Area[];
    people: Person[];
    settings: AppData['settings'];
    isLoading: boolean;
    error: string | null;

    persistenceFailure: PersistenceFailure | null;

    editLockCount: number;

    lastDataChangeAt: number;

    highlightTaskId: string | null;
    highlightTaskAt: number | null;


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


    setArchiveRetentionDays: (days: number) => Promise<StoreActionResult>;


    runArchiveRetention: (options: { syncConfigured: boolean }) => Promise<StoreActionResult & {
        skipped?: 'off' | 'not-ready' | 'waiting-for-sync';
        purged?: { tasks: number; projects: number; sections: number };
    }>;


    fetchData: (options?: {
        silent?: boolean;
        preloadedData?: AppData;

        throwOnError?: boolean;


        recoveryLoad?: boolean;

        isResultStillRelevant?: () => boolean;
    }) => Promise<void>;

    seedGettingStarted: (options?: { language?: string; awaitSave?: boolean }) => Promise<StoreActionResult>;

    addTask: (
        title: string,
        initialProps?: Partial<Task>,
        options?: { captureId: string },
    ) => Promise<StoreActionResult>;

    addTasks: (items: Array<{
        title: string;
        initialProps?: Partial<Task>;
        captureId?: string;
    }>) => Promise<StoreActionResult>;
    commitPreparedVoiceRows: (prepared: Exclude<import('./native-voice-prepared').NativeVoicePrepared, { kind: 'settings' }>,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedVoiceSettings: (request: import('./native-voice-settings').NativeVoiceSettingsRequest,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    retryPreparedVoiceSnapshot: (authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedCapture: (input: {
        task: Task;
        project: Project | null;
        deviceIdToInitialize: string | null;
        deviceIdBefore?: string | null;
    }, options?: Extract<PreparedChecklistWriteOptions, { authority: PreparedAreaAuthority }>) => Promise<StoreActionResult>;

    commitPreparedCaptureLines: (input: {
        tasks: Task[];
        projects: Project[];
        deviceIdToInitialize: string | null;
    }) => Promise<StoreActionResult>;

    commitPreparedTaskEdit: (input: PreparedTaskEdit) => Promise<PreparedTaskEditResult>;
    commitPreparedTaskEdits: (input: PreparedTaskEdit[]) => Promise<PreparedTaskEditResult>;
    commitPreparedTaskDraftV2: (input: Pick<import('./native-host-contract-task-save').NativePreparedTaskDraftSaveV2,
        'deviceIdBefore' | 'deviceIdToInitialize' | 'effect'> & { request: { id: string } },
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedArchivedTaskRestore: (input: import('./native-host-contract-archive-task-restore').NativePreparedArchivedTaskRestore,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;

    commitPreparedArchivedTasksRestore: (input: Pick<import('./native-host-contract-archive-bulk-restore').NativePreparedArchivedTasksRestore,
        'request' | 'effect' | 'deviceIdBefore' | 'deviceIdToInitialize'>,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;

    commitPreparedTrashItemsRestore: (input: PreparedTrashItemsRestore,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;

    commitPreparedTrashItemsPurge: (input: PreparedTrashItemsPurge,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;

    commitPreparedReferenceTasksMove: (input: import('./native-host-contract-reference-bulk-status').NativeReferenceTasksMovePrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;

    commitPreparedInboxTasksMove: (input: import('./native-host-contract-inbox-bulk-status').NativeInboxTasksMovePrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectTasksMove: (input: import('./native-host-contract-project-bulk-status').NativeProjectTasksMovePrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedInboxTasksAddTag: (input: import('./native-host-contract-inbox-bulk-tag').NativeInboxTasksAddTagPrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectTasksAddTag: (input: import('./native-host-contract-project-bulk-tag').NativeProjectTasksAddTagPrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedInboxTasksRemoveTag: (input: import('./native-host-contract-inbox-bulk-remove-tag').NativeInboxTasksRemoveTagPrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectTasksRemoveTag: (input: import('./native-host-contract-project-bulk-remove-tag').NativeProjectTasksRemoveTagPrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedInboxTasksOrganize: (input: import('./native-host-contract-inbox-bulk-organize').NativeInboxTasksOrganizePrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectTasksOrganize: (input: import('./native-host-contract-project-bulk-organize').NativeProjectTasksOrganizePrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedReferenceTasksAddTag: (input: import('./native-host-contract-reference-bulk-tag').NativeReferenceTasksAddTagPrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;

    commitPreparedReferenceTasksRemoveTag: (input: import('./native-host-contract-reference-bulk-remove-tag').NativeReferenceTasksRemoveTagPrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedTaskChecklistMove: (input: {
        before: Task[]; after: Task[]; deviceIdBefore: string | null; deviceIdToInitialize: string | null;
        updateAt: string; frozenTemporal: { futureBoundary: string; dates: ReadonlyMap<string, FocusDateProjection> };
    }, authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedArchivedTasksMutation: (input: {
        operation: 'delete' | 'undo'; before: Task[]; after: Task[];
        deviceIdBefore: string | null; deviceIdToInitialize: string | null;
        frozenTemporal?: { at: string; futureBoundary: string; dates: ReadonlyMap<string, FocusDateProjection> };
    }, authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedTaskFocus: (input: PreparedTaskFocus & { request: { taskId: string; focused: boolean } }) => Promise<PreparedTaskEditResult>;
    commitPreparedFocusOrder: (input: PreparedFocusOrder) => Promise<PreparedTaskEditResult>;
    commitPreparedFocusSavedFilter: (input: PreparedFocusSavedFilter) => Promise<PreparedTaskEditResult>;
    commitPreparedSavedSearchWrite: (input: PreparedSavedSearchWrite) => Promise<PreparedTaskEditResult>;

    commitPreparedBoardTask: (input: PreparedBoardTask) => Promise<PreparedTaskEditResult>;

    commitPreparedBoardOrder: (input: import('./native-host-contract-board-order').NativePreparedBoardOrder,
        authority: PreparedAreaAuthority, admit: () => boolean) => Promise<PreparedTaskEditResult>;
    commitPreparedCalendarTask: (input: PreparedCalendarTask) => Promise<PreparedTaskEditResult>;
    commitPreparedCalendarCreate: (input: PreparedCalendarCreate) => Promise<PreparedTaskEditResult>;
    commitPreparedInboxEffect: (input: PreparedInboxEffect) => Promise<PreparedTaskEditResult>;
    commitPreparedChecklistEffect: (input: PreparedChecklistEffect, options?: PreparedChecklistWriteOptions) => Promise<PreparedTaskEditResult>;

    updateTask: (id: string, updates: Partial<Task>) => Promise<StoreActionResult>;

    cancelTask: (id: string) => Promise<StoreActionResult>;

    skipRecurringTaskOccurrence: (id: string) => Promise<StoreActionResult>;

    deleteTask: (id: string) => Promise<StoreActionResult>;

    restoreTask: (id: string) => Promise<StoreActionResult>;

    restoreTasks: (ids: string[]) => Promise<StoreActionResult>;

    purgeTask: (id: string) => Promise<StoreActionResult>;

    purgeTasks: (ids: string[]) => Promise<StoreActionResult>;

    purgeDeletedTasks: () => Promise<StoreActionResult>;

    duplicateTask: (id: string, asNextAction?: boolean, copyId?: string) => Promise<StoreActionResult>;

    convertTaskToSection: (id: string) => Promise<StoreActionResult>;
    commitPreparedTaskToSection: (input: PreparedTaskToSection) => Promise<PreparedTaskEditResult>;

    convertChecklistToProject: (command: ChecklistProjectConversion) => Promise<StoreActionResult>;
    undoChecklistToProject: (command: ChecklistProjectConversion) => Promise<StoreActionResult>;

    promoteTaskToProject: (id: string, options?: { title?: string; color?: string; areaId?: string }) => Promise<StoreActionResult>;

    moveTaskToChecklist: (sourceId: string, targetId: string) => Promise<StoreActionResult>;

    undoMoveTaskToChecklist: (sourceId: string, targetId: string) => Promise<StoreActionResult>;

    resetTaskChecklist: (id: string) => Promise<StoreActionResult>;

    moveTask: (id: string, newStatus: TaskStatus) => Promise<StoreActionResult>;

    batchUpdateTasks: (updates: Array<{ id: string; updates: Partial<Task> }>) => Promise<StoreActionResult>;

    batchMoveTasks: (ids: string[], newStatus: TaskStatus) => Promise<StoreActionResult>;

    batchDeleteTasks: (ids: string[]) => Promise<StoreActionResult>;

    reorderFocusedTasks: (orderedIds: string[]) => Promise<StoreActionResult>;

    queryTasks: (options: TaskQueryOptions) => Promise<Task[]>;


    getFocusStarAction: (task: Task, options?: { allowUnclarified?: boolean; promoteInbox?: boolean }) => FocusStarAction;

    setError: (error: string | null) => void;

    retryPersistence: () => Promise<void>;

    lockEditing: () => void;

    unlockEditing: () => void;


    addProject: (title: string, color: string, initialProps?: Partial<Project>) => Promise<Project | null>;

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

    commitPreparedProjectFileAvailability: (input: SelectedProjectAvailabilityWrite, authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectStatus: (input: PreparedProjectStatus & { request: { projectId: string; status: 'active' | 'waiting' | 'someday' } }) => Promise<PreparedTaskEditResult>;
    commitPreparedTrashProjectRestore: (input: PreparedTrashProjectRestore) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectDelete: (input: PreparedProjectDelete) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectDeleteUndo: (input: PreparedProjectDeleteUndo) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectDuplicate: (input: PreparedProjectDuplicate) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectLifecycle: (input: PreparedProjectLifecycle, options?: Extract<PreparedChecklistWriteOptions, { authority: PreparedAreaAuthority }>) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectDate: (input: PreparedProjectDate & { request: { projectId: string; field: 'startDate' | 'dueDate' | 'reviewAt'; value: string | null } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectCalendarReference: (input: PreparedProjectCalendarReference & { request: { projectId: string; value: Project['calendarReference'] } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectArea: (input: PreparedProjectArea & { request: { projectId: string; areaId: string | null; colorOverride?: string | null } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectSectionCreate: (input: PreparedProjectSectionCreate) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectSectionRename: (input: PreparedProjectSectionRename & { request: {
        projectId: string; sectionId: string; title: string } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectSectionDelete: (input: PreparedProjectSectionDelete & { request: {
        projectId: string; sectionId: string } }) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectSectionOrder: (input: PreparedProjectSectionOrder) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectTaskOrder: (input: PreparedProjectTaskOrder) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectOrder: (input: PreparedProjectOrder) => Promise<PreparedTaskEditResult>;
    commitPreparedAreaCreate: (input: PreparedAreaCreate & { request: { requestId: string; name: string; color: string; expectedAreaId: string } }, authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedInboxOrganizeDestinationCreate: (input: import('./native-host-contract-inbox-organize-create').NativeInboxOrganizeDestinationCreatePrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedProjectOrganizeDestinationCreate: (input: import('./native-host-contract-project-organize-create').NativeProjectOrganizeDestinationCreatePrepared,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedAreaColor: (input: PreparedAreaColor & { request: { requestId: string; areaId: string; color: string | null } }) => Promise<PreparedTaskEditResult>;
    commitPreparedAreaRename: (input: PreparedAreaRename & { request: { requestId: string; areaId: string; name: string; manageColor?: string };
        result: { id: string; areaId: string; name: string } }, authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedAreaOrder: (input: PreparedAreaOrder & { request: { requestId: string; intent: AreaOrderIntent; expectedAreas: unknown[] }; result: { orderedIds: string[] } }) => Promise<PreparedTaskEditResult>;
    commitPreparedAreaDelete: (input: PreparedAreaDelete & { request: { requestId: string; areaId: string;
        detachProjects?: true }; result: { areaId: string } }, authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedTaxonomy: (input: PreparedTaxonomy, authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;

    commitPreparedGeneralPreference: (input: import('./native-host-contract-general-preference').NativePreparedGeneralPreference,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;

    commitPreparedGtdWorkflow: (input: import('./native-host-contract-gtd-workflow').NativePreparedGtdWorkflow,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;

    commitPreparedAppLock: (request: import('./native-host-contract-app-lock').AppLockRequest,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    retryPreparedAppLockSnapshot: (authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;

    commitPreparedNotificationSetting: (request: import('./native-host-contract-notification-settings').NotificationSettingRequest,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    retryPreparedNotificationSettingSnapshot: (authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;

    commitPreparedAIRequestTimeout: (request: import('./native-ai-request-timeout').AIRequestTimeoutRequest,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    retryPreparedAIRequestTimeoutSnapshot: (authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    commitPreparedAITextConfiguration: (request: import('./native-ai-text-configuration-request').AITextConfigurationRequest
        | import('./native-ai-text-configuration-request').AITextConfigurationRequestV2,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    retryPreparedAITextConfigurationSnapshot: (authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    applyPreparedAIReasoningEffort: (request: import('./native-ai-reasoning-effort').AIReasoningEffortRequest,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    retryPreparedAIReasoningEffortSnapshot: (authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;

    applyPreparedAIGeminiThinkingBudget: (request: import('./native-ai-gemini-thinking-budget').AIGeminiThinkingBudgetRequest,
        authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;
    retryPreparedAIGeminiThinkingBudgetSnapshot: (authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;

    commitPreparedCalendarSubscriptionSetting: (prepared: import('./native-host-contract-calendar-subscription-settings').PreparedCalendarSubscriptionSetting,
        authority: PreparedAreaAuthority, legacyRaw: string | null) => Promise<PreparedTaskEditResult>;
    commitPreparedCalendarSubscriptionAdd: (prepared: import('./native-host-contract-calendar-subscription-add').PreparedCalendarSubscriptionAdd,
        authority: PreparedAreaAuthority, legacyRaw: string | null) => Promise<PreparedTaskEditResult>;
    retryPreparedCalendarSubscriptionSettingSnapshot: (authority: PreparedAreaAuthority) => Promise<PreparedTaskEditResult>;

    updateProject: (id: string, updates: Partial<Project>) => Promise<StoreActionResult>;

    setProjectFlowMode: (id: string, mode: ProjectFlowMode) => Promise<StoreActionResult>;

    cancelProject: (id: string) => Promise<StoreActionResult>;

    deleteProject: (id: string) => Promise<StoreActionResult>;

    restoreProject: (id: string) => Promise<StoreActionResult>;

    purgeProject: (id: string) => Promise<StoreActionResult>;

    purgeDeletedProjects: () => Promise<StoreActionResult>;

    duplicateProject: (id: string) => Promise<Project | null>;

    toggleProjectFocus: (id: string) => Promise<void>;

    convertProjectToSection: (command: PreparedProjectToSection) => Promise<
        { success: true; receipt: ProjectToSectionReceipt; sectionId: string; destinationProjectId: string }
        | { success: false; reason: 'conflict' | 'save-failed' | 'invalid'; error: string }>;

    undoProjectToSection: (receipt: ProjectToSectionReceipt) => Promise<
        { success: true; sourceProjectId: string }
        | { success: false; reason: 'conflict' | 'save-failed' | 'invalid'; error: string }>;


    addSection: (projectId: string, title: string, initialProps?: Partial<Section>) => Promise<Section | null>;

    updateSection: (id: string, updates: Partial<Section>) => Promise<StoreActionResult>;

    deleteSection: (id: string) => Promise<StoreActionResult>;

    reorderSections: (projectId: string, orderedIds: string[]) => Promise<void>;


    addArea: (name: string, initialProps?: Partial<Area>) => Promise<Area | null>;

    updateArea: (id: string, updates: Partial<Area>) => Promise<StoreActionResult>;

    deleteArea: (id: string) => Promise<StoreActionResult>;

    restoreArea: (id: string) => Promise<StoreActionResult>;

    reorderAreas: (orderedIds: string[]) => Promise<void>;

    reorderProjects: (orderedIds: string[], areaId?: string) => Promise<void>;

    reorderProjectTasks: (projectId: string, orderedIds: string[], sectionId?: string | null, movedTaskId?: string) => Promise<void>;

    reorderBoardTasks: (status: TaskStatus, orderedIds: string[], movedTaskId?: string) => Promise<void>;


    addPerson: (name: string, initialProps?: Partial<Person>) => Promise<Person | null>;
    commitPreparedPersonCreate: (input: PreparedPersonCreate & { request: { requestId: string; name: string; note: string; referenceLink: string; expectedPersonId: string } }) => Promise<PreparedTaskEditResult>;
    commitPreparedPersonEdit: (input: PreparedPersonEdit, authority: {
        snapshot: AppData; taskReference: Task[]; lastDataChangeAt: number; saveBoundary?: PreparedNativeSaveBoundary;
    }) => Promise<PreparedTaskEditResult>;
    commitPreparedPersonDelete: (input: PreparedPersonDelete & { request: { requestId: string; personId: string; expected: Person } }) => Promise<PreparedTaskEditResult>;

    updatePerson: (id: string, updates: Partial<Person>) => Promise<StoreActionResult>;

    renamePerson: (id: string, name: string, options?: { updateTasks?: boolean }) => Promise<StoreActionResult>;

    deletePerson: (id: string) => Promise<StoreActionResult>;

    restorePerson: (id: string) => Promise<StoreActionResult>;


    addTag: (name: string) => Promise<void>;

    deleteTag: (tagId: string) => Promise<void>;

    renameTag: (oldTagId: string, newTagId: string) => Promise<void>;


    addContext: (name: string) => Promise<void>;

    deleteContext: (context: string) => Promise<void>;

    renameContext: (oldContext: string, newContext: string) => Promise<void>;


    updateSettings: (updates: Partial<AppData['settings']>) => Promise<void>;

    persistSnapshot: () => Promise<void>;

    setHighlightTask: (id: string | null) => void;


    getDerivedState: () => DerivedState;


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

    sequentialSectionKeys: Set<string>;
    dateCoherenceIssuesByTaskId: Map<string, TaskDateCoherenceIssue[]>;
    focusedCount: number;
    focusedProjectCount: number;
};

export type DerivedCache = {
    taxonomyRef?: AppData['settings']['taxonomy'];
    visibleTasksRef: Task[];
    taskLookupRef: Map<string, Task>;
    projectLookupRef: Map<string, Project>;
    sectionsRef?: Section[];
    day: string;
    value: DerivedState;
};

export type SaveBaseState = Pick<TaskStore, '_allTasks' | '_allProjects' | '_allSections' | '_allAreas' | '_allPeople' | 'settings'>;
