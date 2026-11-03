


import { prepareCaptureTask, type CaptureAssemblyInput } from './capture';
import { normalizeShortcutTags } from './capture-deeplink';
import { safeParseDate } from './date';
import { getChecklistEditStatus } from './task-checklist-model';
import { runStoreCommand } from './store-write-gate';
import { resolveCaptureStatusForStart } from './store-helpers';
import { isSelectableProjectForTaskAssignment } from './project-utils';
import { buildQuickAddParseOptions, parseQuickAdd } from './quick-add';
import type { AppData, Area, Person, Project, Task } from './types';
import { generateDeterministicUUID } from './uuid';

export const PENDING_CAPTURES_DIRECTORY = 'pending-captures';
export const ANDROID_QUICK_CAPTURE_SOURCE = 'android-quick-capture';
export const ANDROID_CAPTURE_INTENT_SOURCE = 'android-capture-intent';
const ANDROID_WIDGET_CHECKOFF_RELEASE_CHECK = 'v1.3.0/android-widget-checkoff';
type CaptureStatus = 'inbox' | 'next' | 'waiting' | 'someday';
const captureStatus = (value: unknown): CaptureStatus | undefined => (
    value === 'inbox' || value === 'next' || value === 'waiting' || value === 'someday' ? value : undefined
);
type CaptureDestination = { defaultStatus?: CaptureStatus; status?: CaptureStatus };


export type PendingCapture = CaptureDestination & {
    kind?: 'capture' | 'text';
    id: string;
    title: string;
    note?: string;
    tags: string[];
    project?: string;
    createdAt?: string;
    dueDate?: string;
    startDate?: string;

    source?: string;
    outboxRetried?: true;
};


export type PendingCompletion = {
    kind: 'complete';
    id: string;
    taskId: string;
    createdAt?: string;
    completedAt?: string;
    source?: string;
};

export type PendingAudioCapture = CaptureDestination & {
    kind: 'audio';
    id: string;
    audioPath: string;
    title?: string;
    note?: string;
    createdAt?: string;
    source?: string;
    outboxRetried?: true;
};

export type PendingDefer = {
    kind: 'defer';
    id: string;
    taskId: string;
    startDate: string;
    createdAt?: string;
    source?: string;
};

export type PendingPomodoro = {
    kind: 'pomodoro';
    id: string;
    action: 'start' | 'pause' | 'reset';
    taskId?: string;
    createdAt?: string;
    source?: string;
};

export type PendingChecklist = {
    kind: 'checklist';
    id: string;
    taskId: string;
    taskCreatedAt: string;
    itemId: string;
    itemTitle: string;
    isCompleted: boolean;
    createdAt: string;
    source: 'apple-watch';
};

export type PendingQueueItem = PendingChecklist | PendingCapture | PendingCompletion | PendingAudioCapture | PendingDefer | PendingPomodoro;

const trimOrUndefined = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
};


function sanitizeStructuredDateInput(raw: unknown): string | undefined {
    const trimmed = trimOrUndefined(raw);
    if (!trimmed) return undefined;
    const parsed = safeParseDate(trimmed);
    if (!parsed) return undefined;
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function isValidDateOnly(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(year, month - 1, day);
    return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

export function parsePendingCapture(raw: string): PendingQueueItem | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const record = parsed as Record<string, unknown>;
    const id = trimOrUndefined(record.id);
    if (!id) return null;
    const createdAt = trimOrUndefined(record.createdAt);
    const source = trimOrUndefined(record.source);

    const defaultStatus = captureStatus(record.defaultStatus);
    const status = captureStatus(record.status);
    const destination: CaptureDestination = {
        ...(defaultStatus ? { defaultStatus } : {}),
        ...(status ? { status } : {}),
    };
    const hasOutboxRetryMarker = Object.prototype.hasOwnProperty.call(record, 'outboxRetried');
    if (hasOutboxRetryMarker && (
        record.outboxRetried !== true
        || source !== 'apple-watch'
        || (record.kind !== 'text' && record.kind !== 'audio')
    )) return null;
    const outboxRetried = record.outboxRetried === true ? true : undefined;
    if (record.kind === 'checklist') {
        const validId = (value: unknown): value is string => typeof value === 'string'
            && value.length > 0 && value.length <= 512 && value.trim() === value;
        if (source !== 'apple-watch' || !UUID_PATTERN.test(id)
            || !createdAt || !safeParseDate(createdAt)
            || !validId(record.taskId) || !validId(record.itemId)
            || typeof record.taskCreatedAt !== 'string' || !safeParseDate(record.taskCreatedAt)
            || typeof record.itemTitle !== 'string' || record.itemTitle.length > 8000
            || typeof record.isCompleted !== 'boolean') return null;
        return { kind: 'checklist', id, taskId: record.taskId, taskCreatedAt: record.taskCreatedAt,
            itemId: record.itemId, itemTitle: record.itemTitle, isCompleted: record.isCompleted, createdAt, source };
    }
    if (record.kind === 'complete') {
        const taskId = trimOrUndefined(record.taskId);
        if (!taskId) return null;
        const completedAt = trimOrUndefined(record.completedAt);
        return {
            kind: 'complete',
            id,
            taskId,
            ...(createdAt ? { createdAt } : {}),
            ...(completedAt ? { completedAt } : {}),
            ...(source ? { source } : {}),
        };
    }
    if (record.kind === 'audio') {
        const audioPath = trimOrUndefined(record.audioPath);
        if (!audioPath) return null;
        const title = trimOrUndefined(record.title);
        const note = trimOrUndefined(record.note);
        return {
            kind: 'audio',
            id,
            audioPath,
            ...destination,
            ...(title ? { title } : {}),
            ...(note ? { note } : {}),
            ...(createdAt ? { createdAt } : {}),
            ...(source ? { source } : {}),
            ...(outboxRetried ? { outboxRetried } : {}),
        };
    }
    if (record.kind === 'defer') {
        const taskId = trimOrUndefined(record.taskId);
        const startDate = trimOrUndefined(record.startDate);
        if (!taskId || !startDate || !isValidDateOnly(startDate)) return null;
        return { kind: 'defer', id, taskId, startDate, ...(createdAt ? { createdAt } : {}), ...(source ? { source } : {}) };
    }
    if (record.kind === 'pomodoro') {
        const taskId = trimOrUndefined(record.taskId);
        const action = record.action;
        if (action !== 'start' && action !== 'pause' && action !== 'reset') return null;
        return { kind: 'pomodoro', id, action, ...(taskId ? { taskId } : {}), ...(createdAt ? { createdAt } : {}), ...(source ? { source } : {}) };
    }
    if (record.kind !== undefined && record.kind !== 'capture' && record.kind !== 'text') return null;
    const title = trimOrUndefined(record.title);
    if (!title) return null;

    const note = trimOrUndefined(record.note);
    const project = trimOrUndefined(record.project);
    const tagsRaw = trimOrUndefined(record.tags);
    const tags = tagsRaw ? tagsRaw.split(',').map((tag) => tag.trim()).filter(Boolean) : [];
    const dueDate = sanitizeStructuredDateInput(record.dueDate);
    const startDate = sanitizeStructuredDateInput(record.startDate);

    return {
        ...(record.kind === 'capture' || record.kind === 'text' ? { kind: record.kind } : {}),
        id,
        title,
        ...destination,
        ...(note ? { note } : {}),
        tags,
        ...(project ? { project } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(dueDate ? { dueDate } : {}),
        ...(startDate ? { startDate } : {}),
        ...(source ? { source } : {}),
        ...(outboxRetried ? { outboxRetried } : {}),
    };
}


function resolveStructuredProjectId(capture: PendingCapture, projects: readonly Project[]): string | undefined {
    if (!capture.project) return undefined;
    const ref = capture.project.toLowerCase();
    const match = projects.find((project) => (
        project.id === capture.project || project.title.toLowerCase() === ref
    ));
    return match && isSelectableProjectForTaskAssignment(match) ? match.id : undefined;
}

export function buildPendingCaptureTaskProps(capture: PendingCapture, projects: Project[]): Partial<Task> {

    const props: Partial<Task> = {
        status: capture.status ?? resolveCaptureStatusForStart({ startTime: capture.startDate }, capture.defaultStatus ?? 'inbox'),
    };
    if (capture.note) props.description = capture.note;

    const tags = normalizeShortcutTags(capture.tags);
    if (tags.length > 0) props.tags = tags;

    const projectId = resolveStructuredProjectId(capture, projects);
    if (projectId) props.projectId = projectId;

    if (capture.dueDate) props.dueDate = capture.dueDate;
    if (capture.startDate) props.startTime = capture.startDate;

    return props;
}


export type PendingCaptureStoreDeps = {
    addTask: (
        title: string,
        initialProps?: Partial<Task>,
        options?: { captureId: string },
    ) => Promise<unknown>;

    updateTask: (id: string, updates: Partial<Task>) => Promise<unknown>;
    addProject: (title: string, color: string, initialProps?: Partial<Project>) => Promise<Project | null>;
    projects: Project[];
    areas: Area[];


    tasks: Task[];
    people: Person[];
    settings: AppData['settings'];

    getTasks?: () => Task[];

    getProjects?: () => Project[];

    flushPendingSave?: () => Promise<void>;
    applyPomodoroCommand?: (command: PendingPomodoro) => Promise<'applied' | 'already-applied' | 'stale'>;
};


export type PendingCaptureQueuePort = {

    list(): Promise<string[] | null>;
    read(name: string): Promise<string>;

    delete(name: string): Promise<void>;
};


export type PendingCaptureAudioPort = {

    resolvePath(capture: PendingAudioCapture): string | null;

    transcribe?: (audioPath: string, settings: AppData['settings']) => Promise<string | null>;

    delete(audioPath: string): Promise<void>;
};


export type PendingCaptureRecordPort = {
    read(): Promise<string | null>;
    write(value: string): Promise<void>;
};


export const PENDING_CAPTURE_LAST_APPLIED_STORAGE_KEY = 'mindwtr:pending-captures:last-applied:v1';
const LAST_APPLIED_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
type LastApplied = { tapMs: number; id: string; at: number; outcome?: string };

type PendingCaptureLogContext = { scope: string; force?: boolean; extra?: Record<string, unknown> };


export type PendingCaptureLog = {
    info(message: string, context: PendingCaptureLogContext): unknown;
    warn(message: string, context: PendingCaptureLogContext): unknown;
    error(error: unknown, context: PendingCaptureLogContext): unknown;
};

export type PendingCaptureDrainDeps = PendingCaptureStoreDeps & {

    settleWatchChecklist?: (id: string, outcome: string) => Promise<void>;
    queue: PendingCaptureQueuePort;
    lastApplied: PendingCaptureRecordPort;
    log: PendingCaptureLog;

    audio?: PendingCaptureAudioPort;


    audioOnly?: boolean;


    onUnfinished?: (state: 'owed' | 'queued') => void;
};

const WATCH_CAPTURE_RELEASE_CHECK = 'v1.3.0/watch-capture';
const WATCH_AUDIO_READY_RELEASE_CHECK = 'v1.3.0/watch-audio-ready';
const WATCH_COMMAND_RELEASE_CHECK = 'v1.3.0/watch-command';
const WATCH_OUTBOX_RETRY_RELEASE_CHECK = 'v1.3.0/watch-outbox-retry';
const WATCH_AUDIO_ONCE_RELEASE_CHECK = 'v1.3.3/watch-audio-capture-once';
const STALE_QUEUED_COMMAND_RELEASE_CHECK = 'v1.3.3/stale-queued-command-skipped';
const UUID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

function logWatchOutboxRetry(log: PendingCaptureLog, kind: 'text' | 'audio', capture: PendingCapture | PendingAudioCapture): void {
    if (capture.outboxRetried !== true) return;
    void log.info('Watch outbox retry ingested', {
        scope: 'capture',
        extra: { releaseCheck: WATCH_OUTBOX_RETRY_RELEASE_CHECK, kind, outcome: 'created' },
    });
}

function logAndroidCaptureDestination(log: PendingCaptureLog, capture: PendingCapture | PendingAudioCapture, status: unknown, replayed: boolean): void {
    if (capture.source !== ANDROID_QUICK_CAPTURE_SOURCE) return;
    void log.info('Android quick capture destination ingested', {
        scope: 'capture', force: true,
        extra: {
            releaseCheck: 'v1.3.7/android-widget-capture-status',
            kind: capture.kind === 'audio' ? 'audio' : 'text',
            destination: captureStatus(status) ?? 'other',
            selection: capture.status ? 'explicit' : 'default',
            outcome: replayed ? 'already-created' : 'created',
        },
    });
}

const isFailedResult = (result: unknown): boolean => (
    typeof result === 'object' && result !== null && (result as { success?: unknown }).success === false
);

const resultId = (result: unknown): string | undefined => {
    if (typeof result !== 'object' || result === null) return undefined;
    return trimOrUndefined((result as { id?: unknown }).id);
};


async function assembleCaptureTask(
    capture: PendingCapture,
    { addProject, projects, areas, tasks, people, settings }: Pick<PendingCaptureStoreDeps, 'addProject' | 'projects' | 'areas' | 'tasks' | 'people' | 'settings'>,
    log: PendingCaptureLog,
): Promise<{ title: string; props: Partial<Task> } | null> {
    try {


        const capturedAt = capture.createdAt ? new Date(capture.createdAt) : null;
        const now = capturedAt && !Number.isNaN(capturedAt.getTime()) ? capturedAt : new Date();
        const parsed = parseQuickAdd(capture.title, projects, now, areas,
            buildQuickAddParseOptions(settings, { tasks, people }));

        const input: CaptureAssemblyInput = {
            parsed,
            rawInput: capture.title,
            fallbackTitle: capture.title,
            projects,
            initialProps: {
                status: capture.defaultStatus ?? 'inbox',
                ...(capture.note ? { description: capture.note } : {}),
            },
            extraProps: capture.status ? { status: capture.status } : undefined,
            suppressDetectedDate: false,
        };

        const prepared = await prepareCaptureTask(input, { addProject }, {
            transformProps: (props) => {
                const taskProps = { ...props };
                const structuredProjectId = resolveStructuredProjectId(capture, projects);
                if (structuredProjectId) taskProps.projectId = structuredProjectId;

                const structuredTags = normalizeShortcutTags(capture.tags);
                if (structuredTags.length > 0) {
                    taskProps.tags = Array.from(new Set([...(taskProps.tags ?? []), ...structuredTags]));
                }


                if (capture.dueDate) taskProps.dueDate = capture.dueDate;
                if (capture.startDate) taskProps.startTime = capture.startDate;
                return taskProps;
            },
        });


        if (!prepared.success) return null;
        return { title: prepared.title, props: prepared.props };
    } catch (error) {


        void log.error(error, { scope: 'shortcuts', extra: { message: 'Failed to assemble pending capture' } });
        return null;
    }
}


function resolveQueuedCompletedAt(completion: PendingCompletion): string | undefined {
    const raw = completion.completedAt ?? completion.createdAt;
    if (!raw) return undefined;
    const parsed = safeParseDate(raw);
    if (!parsed || parsed.getTime() > Date.now()) return undefined;
    return parsed.toISOString();
}


export async function applyPendingCompletion(
    completion: PendingCompletion,
    { updateTask, tasks, getTasks }: Pick<PendingCaptureStoreDeps, 'updateTask' | 'tasks' | 'getTasks'>,
): Promise<'completed' | 'already-done' | 'terminal' | 'missing' | null> {
    const task = (getTasks?.() ?? tasks).find((candidate) => candidate.id === completion.taskId);
    const outcome = !task || task.deletedAt || task.purgedAt
        ? 'missing'
        : task.status === 'done'
            ? 'already-done'
            : task.status === 'archived'
                ? 'terminal'
                : 'completed';
    if (outcome === 'completed') {
        const completedAt = resolveQueuedCompletedAt(completion);
        const result = await updateTask(completion.taskId, { status: 'done', ...(completedAt ? { completedAt } : {}) });
        if (isFailedResult(result)) return null;
    }
    return outcome;
}

async function applyPendingDefer(
    pending: PendingDefer,
    { updateTask, tasks, getTasks }: Pick<PendingCaptureStoreDeps, 'updateTask' | 'tasks' | 'getTasks'>,
): Promise<'deferred' | 'already-deferred' | 'terminal' | 'missing' | null> {
    const task = (getTasks?.() ?? tasks).find((candidate) => candidate.id === pending.taskId);
    const outcome = !task || task.deletedAt
        ? 'missing'
        : task.status === 'done' || task.status === 'archived'
            ? 'terminal'
            : task.startTime === pending.startDate
                ? 'already-deferred'
                : 'deferred';
    if (outcome === 'deferred') {
        const result = await updateTask(pending.taskId, { startTime: pending.startDate });
        if (isFailedResult(result)) return null;
    }
    return outcome;
}


export function applyPendingChecklist(
    command: PendingChecklist,
    deps: Pick<PendingCaptureStoreDeps, 'tasks' | 'getTasks' | 'projects' | 'getProjects' | 'updateTask'>,
): Promise<string | null> {
    return runStoreCommand(() => applyPendingChecklistNow(command, deps));
}

async function applyPendingChecklistNow(
    command: PendingChecklist,
    deps: Pick<PendingCaptureStoreDeps, 'tasks' | 'getTasks' | 'projects' | 'getProjects' | 'updateTask'>,
): Promise<string | null> {
    const task = (deps.getTasks?.() ?? deps.tasks).find((entry) => entry.id === command.taskId);
    if (!task || task.deletedAt || task.purgedAt || task.createdAt !== command.taskCreatedAt) return 'missing';
    const items = task.checklist ?? [];
    const matches = items.filter((item) => item.id === command.itemId && item.title === command.itemTitle);
    if (matches.length !== 1) return 'changed';

    if (matches[0].isCompleted === command.isCompleted) return 'applied';
    const project = (deps.getProjects?.() ?? deps.projects).find((entry) => entry.id === task.projectId);
    if (task.status === 'archived' || task.status === 'reference'
        || (task.status === 'done' && (task.taskMode !== 'list' || task.recurrence))
        || (project && (project.deletedAt || project.status === 'archived'))) return 'terminal';
    const checklist = items.map((item) => item === matches[0] ? { ...item, isCompleted: command.isCompleted } : item);
    const status = getChecklistEditStatus({ taskMode: task.taskMode, status: task.status, checklist });
    const result = await deps.updateTask(task.id, { checklist, ...(status !== task.status ? { status } : {}) });
    return isFailedResult(result) ? null : 'applied';
}


export async function drainPendingCaptureQueue(deps: PendingCaptureDrainDeps): Promise<number> {
    const {
        addTask,
        updateTask,
        addProject,
        projects,
        areas,
        tasks,
        people,
        settings,
        getTasks,
        getProjects,
        flushPendingSave,
        applyPomodoroCommand,
        queue,
        lastApplied,
        log,
        audio,
        audioOnly,
        onUnfinished,
    } = deps;


    const captureAddProject = (captureId: string | undefined): PendingCaptureStoreDeps['addProject'] => (
        captureId === undefined ? addProject : async (title, color, props) => {
            const id = generateDeterministicUUID(`${captureId}:project:${title.trim().toLowerCase()}`);
            const own = (getProjects?.() ?? projects).find((project) => project.id === id);
            if (own) return isSelectableProjectForTaskAssignment(own) ? own : null;
            return addProject(title, color, { ...props, id });
        }
    );

    let names: string[];
    try {
        const listed = await queue.list();
        if (!listed) return 0;
        names = listed;
    } catch (error) {
        void log.error(error, { scope: 'shortcuts', extra: { message: 'Failed to read pending captures' } });
        onUnfinished?.('queued');
        return 0;
    }

    const entries: { capture: PendingQueueItem | null; name: string }[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
        try {
            entries.push({ capture: parsePendingCapture(await queue.read(name)), name });
        } catch (error) {
            void log.error(error, { scope: 'shortcuts', extra: { message: 'Failed to read pending capture', name } });
            onUnfinished?.('queued');
        }
    }

    const isWatchCommand = (capture: PendingQueueItem | null) => (
        capture?.kind === 'checklist'
        || capture?.kind === 'defer'
        || capture?.kind === 'pomodoro'
        || (capture?.kind === 'complete' && capture.source === 'apple-watch')
    );
    const watchCommands = entries
        .filter((entry) => isWatchCommand(entry.capture))
        .sort((left, right) => {
            const leftMs = left.capture?.createdAt ? Date.parse(left.capture.createdAt) : Number.POSITIVE_INFINITY;
            const rightMs = right.capture?.createdAt ? Date.parse(right.capture.createdAt) : Number.POSITIVE_INFINITY;
            const normalizedLeftMs = Number.isFinite(leftMs) ? leftMs : Number.POSITIVE_INFINITY;
            const normalizedRightMs = Number.isFinite(rightMs) ? rightMs : Number.POSITIVE_INFINITY;
            return normalizedLeftMs - normalizedRightMs || left.name.localeCompare(right.name);
        });
    let nextWatchCommand = 0;
    const orderedEntries = entries.map((entry) => (
        isWatchCommand(entry.capture) ? watchCommands[nextWatchCommand++] : entry
    ));


    const tapTimeOf = (command: PendingCompletion | PendingDefer): number => (
        safeParseDate(command.createdAt ?? (command.kind === 'complete' ? command.completedAt : undefined))?.getTime() ?? Number.NaN
    );
    const readLastApplied = async (): Promise<Map<string, LastApplied> | null> => {
        let raw: string | null;
        try {
            raw = await lastApplied.read();
        } catch (error) {
            void log.error(error, { scope: 'capture', extra: { message: 'Failed to read the applied-command record' } });
            return null;
        }
        const record = new Map<string, LastApplied>();
        try {
            const parsed: unknown = raw ? JSON.parse(raw) : {};
            for (const [taskId, entry] of Object.entries(parsed && typeof parsed === 'object' ? parsed : {})) {
                const { tapMs, id, at, outcome } = (entry ?? {}) as Partial<LastApplied>;
                if (Number.isFinite(tapMs) && typeof id === 'string' && Number.isFinite(at)) record.set(taskId, {
                    tapMs: tapMs!, id, at: at!, ...(typeof outcome === 'string' ? { outcome } : {}),
                });
            }
        } catch {

        }
        return record;
    };
    let appliedRecord: Promise<Map<string, LastApplied> | null> | null = null;
    const skipOf = (command: PendingCompletion | PendingDefer, record: Map<string, LastApplied>): 'stale' | 'replayed' | null => {
        const last = record.get(command.taskId);
        if (!last) return null;
        if (last.id === command.id) return 'replayed';
        const tapMs = tapTimeOf(command);
        return !Number.isNaN(tapMs) && tapMs < last.tapMs ? 'stale' : null;
    };
    const remember = async (command: PendingCompletion | PendingDefer, record: Map<string, LastApplied>): Promise<void> => {
        const tapMs = tapTimeOf(command);
        const last = record.get(command.taskId);
        if (Number.isNaN(tapMs) || (last && tapMs < last.tapMs)) return;
        const now = Date.now();
        record.set(command.taskId, { tapMs, id: command.id, at: now });
        for (const [taskId, entry] of record) {

            if (!taskId.startsWith('["watch-checklist",') && now - entry.at > LAST_APPLIED_KEEP_MS) record.delete(taskId);
        }
        await lastApplied.write(JSON.stringify(Object.fromEntries(record)));
    };
    const logSkip = (kind: 'complete' | 'defer', outcome: 'stale' | 'replayed') => {
        void log.info('Queued command skipped', {
            scope: 'capture',
            extra: { releaseCheck: STALE_QUEUED_COMMAND_RELEASE_CHECK, kind, outcome },
        });
    };

    let ingested = 0;
    for (const { capture, name } of orderedEntries) {
        if (audioOnly && capture?.kind !== 'audio') continue;
        if (!capture) {


            void log.warn('Discarding malformed pending capture', { scope: 'shortcuts', extra: { name } });
            await queue.delete(name).catch(() => undefined);
            continue;
        }

        if (capture.kind === 'checklist') {

            if (!deps.settleWatchChecklist || !flushPendingSave) { onUnfinished?.('queued'); continue; }
            const record = await (appliedRecord ??= readLastApplied());
            if (!record) { onUnfinished?.('queued'); continue; }
            const target = JSON.stringify(['watch-checklist', capture.taskId, capture.taskCreatedAt, capture.itemId, capture.itemTitle]);
            const previous = record.get(target);
            const tapMs = Date.parse(capture.createdAt);
            const stale = previous && (tapMs < previous.tapMs || (tapMs === previous.tapMs && capture.id < previous.id));
            let outcome = previous?.id === capture.id ? previous.outcome ?? 'applied' : stale ? 'stale' : undefined;
            try {
                if (!outcome) {
                    outcome = await applyPendingChecklist(capture, deps) ?? undefined;
                    if (!outcome) { onUnfinished?.('queued'); continue; }
                }
                await flushPendingSave();
                if (!stale) {
                    record.set(target, { tapMs, id: capture.id, at: Date.now(), outcome });
                    await lastApplied.write(JSON.stringify(Object.fromEntries(record)));
                }
                await deps.settleWatchChecklist(capture.id, outcome);
                await queue.delete(name);
                ingested += 1;
                void log.info('Watch checklist command settled', {
                    scope: 'capture', extra: { releaseCheck: 'v1.3.5/watch-checklist', outcome },
                });
            } catch {

                onUnfinished?.('owed');
                break;
            }
            continue;
        }

        if (capture.kind === 'complete') {
            const record = await (appliedRecord ??= readLastApplied());
            if (!record) { onUnfinished?.('queued'); continue; }
            const skip = skipOf(capture, record);
            const outcome = skip ?? await applyPendingCompletion(capture, { updateTask, tasks, getTasks });
            if (!outcome) { onUnfinished?.('queued'); continue; }
            try {
                await flushPendingSave?.();
            } catch {
                onUnfinished?.('owed');
                continue;
            }


            const recorded = outcome === 'completed' || outcome === 'already-done'
                ? await remember(capture, record).then(() => true, () => false)
                : true;
            try {
                await queue.delete(name);
            } catch {
                onUnfinished?.('owed');
                continue;
            }
            if (!recorded) {
                onUnfinished?.('owed');
                continue;
            }
            ingested += 1;
            if (skip) {
                logSkip('complete', skip);
            } else if (capture.source === 'apple-watch') {
                void log.info('Watch command ingested', {
                    scope: 'capture',
                    extra: { releaseCheck: WATCH_COMMAND_RELEASE_CHECK, kind: 'complete', outcome },
                });
            } else if (outcome === 'terminal') {
                void log.info('Widget check-off ingested', {
                    scope: 'capture',
                    extra: { releaseCheck: 'v1.3.0/widget-terminal-preserved', outcome },
                });
            } else {
                void log.info('Widget check-off ingested', {
                    scope: 'capture',
                    extra: { releaseCheck: ANDROID_WIDGET_CHECKOFF_RELEASE_CHECK, outcome },
                });
            }
            continue;
        }

        if (capture.kind === 'defer') {
            const record = await (appliedRecord ??= readLastApplied());
            if (!record) { onUnfinished?.('queued'); continue; }
            const skip = skipOf(capture, record);
            const outcome = skip ?? await applyPendingDefer(capture, { updateTask, tasks, getTasks });
            if (!outcome) { onUnfinished?.('queued'); continue; }
            try {
                await flushPendingSave?.();
            } catch {
                onUnfinished?.('owed');
                continue;
            }


            const recorded = outcome === 'deferred' || outcome === 'already-deferred'
                ? await remember(capture, record).then(() => true, () => false)
                : true;
            try {
                await queue.delete(name);
            } catch {
                onUnfinished?.('owed');
                continue;
            }
            if (!recorded) {
                onUnfinished?.('owed');
                continue;
            }
            ingested += 1;
            if (skip) {
                logSkip('defer', skip);
                continue;
            }
            void log.info('Watch command ingested', {
                scope: 'capture',
                extra: { releaseCheck: WATCH_COMMAND_RELEASE_CHECK, kind: 'defer', outcome },
            });
            continue;
        }

        if (capture.kind === 'pomodoro') {
            if (!applyPomodoroCommand) continue;
            const outcome = await applyPomodoroCommand(capture).catch(() => null);
            if (!outcome) continue;
            try {
                await queue.delete(name);
            } catch {
                continue;
            }
            ingested += 1;
            void log.info('Watch command ingested', {
                scope: 'capture',
                extra: { releaseCheck: WATCH_COMMAND_RELEASE_CHECK, kind: 'pomodoro', action: capture.action, outcome },
            });
            continue;
        }

        if (capture.kind === 'audio') {
            if (!audio) continue;
            const isAndroidQuickCapture = capture.source === ANDROID_QUICK_CAPTURE_SOURCE;
            const normalizedCaptureId = capture.id.toLowerCase();
            const hasCanonicalAndroidQueueName = !isAndroidQuickCapture || name === `${capture.id}.json`;
            const resolvedAudioPath = hasCanonicalAndroidQueueName
                ? audio.resolvePath(capture)
                : null;
            if (!resolvedAudioPath) {
                if (isAndroidQuickCapture) {
                    void log.warn('Discarding Android quick capture audio with invalid contract', {
                        scope: 'capture',
                        extra: { kind: 'audio', outcome: 'invalid-path' },
                    });
                } else {
                    void log.warn('Discarding Watch audio capture with invalid path', {
                        scope: 'capture',
                        extra: { releaseCheck: WATCH_CAPTURE_RELEASE_CHECK, kind: 'audio', outcome: 'invalid-path' },
                    });
                }
                await queue.delete(name).catch(() => undefined);
                continue;
            }

            const currentTasks = getTasks?.() ?? tasks;


            const captureId = isAndroidQuickCapture || UUID_PATTERN.test(capture.id) ? normalizedCaptureId : undefined;
            const existingCaptureTask = captureId
                ? currentTasks.find((task) => task.id.toLowerCase() === captureId)
                : undefined;
            if (existingCaptureTask) {


                let replayResult: unknown;
                try {
                    replayResult = await addTask(
                        existingCaptureTask.title?.trim() || capture.title || 'Audio capture',
                        undefined,
                        { captureId: normalizedCaptureId },
                    );
                } catch (error) {
                    if (!isAndroidQuickCapture) throw error;
                    void log.warn('Android quick capture audio retained for retry', {
                        scope: 'capture',
                        extra: { kind: 'audio', outcome: 'task-save-failed' },
                    });
                    continue;
                }
                if (
                    isFailedResult(replayResult)
                    || resultId(replayResult)?.toLowerCase() !== normalizedCaptureId
                ) {
                    if (isAndroidQuickCapture) {
                        void log.warn('Android quick capture audio retained for retry', {
                            scope: 'capture',
                            extra: { kind: 'audio', outcome: 'task-save-failed' },
                        });
                    }
                    continue;
                }
                try {
                    await flushPendingSave?.();
                    await queue.delete(name);
                } catch {
                    if (isAndroidQuickCapture) {
                        void log.warn('Android quick capture audio retained for retry', {
                            scope: 'capture',
                            extra: { kind: 'audio', outcome: 'cleanup-failed' },
                        });
                    }
                    continue;
                }
                await audio.delete(resolvedAudioPath).catch(() => undefined);
                ingested += 1;
                logAndroidCaptureDestination(log, capture, existingCaptureTask.status, true);
                if (isAndroidQuickCapture) {
                    void log.info('Android quick capture audio ingested', {
                        scope: 'capture',
                        extra: { kind: 'audio', outcome: 'already-created' },
                    });
                } else {
                    void log.info('Watch capture ingested', {
                        scope: 'capture',
                        extra: { releaseCheck: WATCH_AUDIO_ONCE_RELEASE_CHECK, kind: 'audio', outcome: 'already-created' },
                    });
                    logWatchOutboxRetry(log, 'audio', capture);
                }
                continue;
            }

            if (isAndroidQuickCapture) {
                void log.info('Android quick capture audio ready for transcription', {
                    scope: 'capture',
                    extra: { kind: 'audio', outcome: 'validated' },
                });
            } else {
                void log.info('Watch audio ready for transcription', {
                    scope: 'capture',
                    extra: { releaseCheck: WATCH_AUDIO_READY_RELEASE_CHECK, outcome: 'validated' },
                });
            }
            if (!audio.transcribe) continue;
            let transcript: string | null = null;
            try {
                transcript = await audio.transcribe(resolvedAudioPath, settings);
            } catch {
                if (isAndroidQuickCapture) {
                    void log.warn('Android quick capture audio retained for retry', {
                        scope: 'capture',
                        extra: { kind: 'audio', outcome: 'transcription-failed' },
                    });
                } else {
                    void log.warn('Watch audio capture retained for retry', {
                        scope: 'capture',
                        extra: { releaseCheck: WATCH_CAPTURE_RELEASE_CHECK, kind: 'audio', outcome: 'transcription-failed' },
                    });
                }
                continue;
            }
            if (!transcript) {
                if (isAndroidQuickCapture) {
                    void log.warn('Android quick capture audio retained for retry', {
                        scope: 'capture',
                        extra: { kind: 'audio', outcome: 'transcription-unavailable' },
                    });
                } else {
                    void log.warn('Watch audio capture retained for retry', {
                        scope: 'capture',
                        extra: { releaseCheck: WATCH_CAPTURE_RELEASE_CHECK, kind: 'audio', outcome: 'transcription-unavailable' },
                    });
                }
                continue;
            }
            const textCapture: PendingCapture = {
                kind: 'text',
                id: capture.id,
                title: capture.title ? `${capture.title} ${transcript}` : transcript,
                ...(capture.note ? { note: capture.note } : {}),
                tags: [],
                createdAt: capture.createdAt,
                source: capture.source,
                ...(capture.defaultStatus ? { defaultStatus: capture.defaultStatus } : {}),
                ...(capture.status ? { status: capture.status } : {}),
            };
            const activeTasks = currentTasks.filter((task) => !task.deletedAt && !task.purgedAt);
            const assembled = await assembleCaptureTask(textCapture, { addProject: captureAddProject(captureId), projects, areas, tasks: activeTasks, people, settings }, log);
            const title = assembled?.title ?? textCapture.title;
            const props = assembled?.props ?? buildPendingCaptureTaskProps(textCapture, projects);
            let result: unknown;
            if (isAndroidQuickCapture) {
                try {
                    result = await addTask(title, props, { captureId: normalizedCaptureId });
                } catch {
                    void log.warn('Android quick capture audio retained for retry', {
                        scope: 'capture',
                        extra: { kind: 'audio', outcome: 'task-save-failed' },
                    });
                    continue;
                }
            } else {


                result = await addTask(title, props, ...(captureId ? [{ captureId }] : []));
            }
            if (
                isFailedResult(result)
                || (captureId && resultId(result)?.toLowerCase() !== captureId)
            ) {
                if (isAndroidQuickCapture) {
                    void log.warn('Android quick capture audio retained for retry', {
                        scope: 'capture',
                        extra: { kind: 'audio', outcome: 'task-save-failed' },
                    });
                }
                continue;
            }
            try {
                await flushPendingSave?.();
                await queue.delete(name);
            } catch {
                if (isAndroidQuickCapture) {
                    void log.warn('Android quick capture audio retained for retry', {
                        scope: 'capture',
                        extra: { kind: 'audio', outcome: 'cleanup-failed' },
                    });
                }
                continue;
            }


            await audio.delete(resolvedAudioPath).catch(() => undefined);
            ingested += 1;
            logAndroidCaptureDestination(log, capture, props.status, false);
            if (isAndroidQuickCapture) {
                void log.info('Android quick capture audio ingested', {
                    scope: 'capture',
                    ...(capture.note ? { force: true } : {}),
                    extra: { kind: 'audio', outcome: 'created', ...(capture.note ? { releaseCheck: 'v1.3.7/quick-capture-description' } : {}) },
                });
            } else {
                void log.info('Watch capture ingested', {
                    scope: 'capture',
                    extra: { releaseCheck: WATCH_CAPTURE_RELEASE_CHECK, kind: 'audio', outcome: 'created' },
                });
                logWatchOutboxRetry(log, 'audio', capture);
            }
            continue;
        }


        const captureId = UUID_PATTERN.test(capture.id) ? capture.id.toLowerCase() : undefined;
        const storedTask = captureId ? (getTasks?.() ?? tasks).find((task) => task.id.toLowerCase() === captureId) : undefined;
        const stored = storedTask !== undefined;
        let destination = storedTask?.status;
        if (!stored) {
            const assembled = await assembleCaptureTask(capture, { addProject: captureAddProject(captureId), projects, areas, tasks, people, settings }, log);
            destination = (assembled?.props ?? buildPendingCaptureTaskProps(capture, projects)).status;
            const captureOptions: [{ captureId: string }?] = captureId ? [{ captureId }] : [];
            const result = assembled
                ? await addTask(assembled.title, assembled.props, ...captureOptions)
                : await addTask(capture.title, buildPendingCaptureTaskProps(capture, projects), ...captureOptions);


            if (
                isFailedResult(result)
                || (captureId && resultId(result)?.toLowerCase() !== captureId)
            ) {
                onUnfinished?.('queued');
                continue;
            }
        }


        try {
            await flushPendingSave?.();
            await queue.delete(name);
        } catch {
            onUnfinished?.('owed');
            continue;
        }
        ingested += 1;
        logAndroidCaptureDestination(log, capture, destination, stored);
        if (capture.source === ANDROID_QUICK_CAPTURE_SOURCE) {
            void log.info('Quick capture dialog item ingested', {
                scope: 'capture',
                ...(capture.note && !stored ? { force: true, extra: { releaseCheck: 'v1.3.7/quick-capture-description', kind: 'text', outcome: 'created' } } : {}),
            });
        } else if (capture.source === ANDROID_CAPTURE_INTENT_SOURCE) {
            void log.info('Android automation capture ingested', {
                scope: 'capture',
            });
        } else if (capture.source === 'apple-watch') {
            void log.info('Watch capture ingested', {
                scope: 'capture',
                extra: { releaseCheck: WATCH_CAPTURE_RELEASE_CHECK, kind: 'text', outcome: 'created' },
            });
            logWatchOutboxRetry(log, 'text', capture);
        }
    }
    return ingested;
}
