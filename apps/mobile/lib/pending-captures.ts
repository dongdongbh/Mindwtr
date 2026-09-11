import {
    buildQuickAddParseOptions,
    isSelectableProjectForTaskAssignment,
    parseQuickAdd,
    prepareCaptureTask,
    safeParseDate,
    type Area,
    type AppData,
    type CaptureAssemblyInput,
    type Person,
    type Project,
    type Task,
} from '@mindwtr/core';

import { logError, logInfo, logWarn } from './app-log';
import { normalizeShortcutTags } from './capture-deeplink';
import { deleteAsync, documentDirectory, getInfoAsync, readAsStringAsync, readDirectoryAsync } from './file-system';

// Background Shortcuts captures (#845) and the Android quick-capture dialog
// (#1169, modules/android-widget PendingCaptureWriter.kt): native code only
// appends JSON files to this directory (with audio bytes in a sibling owned
// directory); every task write happens here, through the normal store path, so
// revisions, save tracking, and sync merge behavior stay intact.
export const PENDING_CAPTURES_DIRECTORY = 'pending-captures';
export const ANDROID_QUICK_CAPTURE_SOURCE = 'android-quick-capture';
export const ANDROID_CAPTURE_INTENT_SOURCE = 'android-capture-intent';
const ANDROID_QUICK_CAPTURE_RELEASE_CHECK = 'v1.3.0/android-quick-capture-dialog';
const ANDROID_CAPTURE_INTENT_RELEASE_CHECK = 'v1.3.0/android-capture-intent';
const ANDROID_WIDGET_CHECKOFF_RELEASE_CHECK = 'v1.3.0/android-widget-checkoff';

// A new task to add (the iOS Shortcut and the Android dialog; `kind` absent).
export type PendingCapture = {
    kind?: 'capture' | 'text';
    id: string;
    title: string;
    note?: string;
    tags: string[];
    project?: string;
    createdAt?: string;
    dueDate?: string;
    startDate?: string;
    // Which native writer queued the item; absent for the iOS Shortcut.
    source?: string;
    outboxRetried?: true;
};

// A check-off from the Android widget ring (#1173 phase 2): the task is
// completed through the normal store path when the app next runs.
export type PendingCompletion = {
    kind: 'complete';
    id: string;
    taskId: string;
    createdAt?: string;
    completedAt?: string;
    source?: string;
};

export type PendingAudioCapture = {
    kind: 'audio';
    id: string;
    audioPath: string;
    title?: string;
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

export type PendingQueueItem = PendingCapture | PendingCompletion | PendingAudioCapture | PendingDefer | PendingPomodoro;

const trimOrUndefined = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
};

// The Shortcut's "Due date"/"Start date" parameters are a native Date picker,
// so Swift always hands back a value with a time component even when the
// user only picked a day. Collapsing to the local calendar day here (same
// sanitization spirit as a deep link's task props: never trust the raw
// string, never fail the capture on garbage input) guarantees these fields
// stay date-only and never arm a due/start reminder, matching the v1
// guardrail that background captures don't schedule notifications (#755).
// ponytail: always drops any time component rather than trying to infer
// user intent from it; revisit if Shortcuts-sourced reminder times are ever
// requested.
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
    const hasOutboxRetryMarker = Object.prototype.hasOwnProperty.call(record, 'outboxRetried');
    if (hasOutboxRetryMarker && (
        record.outboxRetried !== true
        || source !== 'apple-watch'
        || (record.kind !== 'text' && record.kind !== 'audio')
    )) return null;
    const outboxRetried = record.outboxRetried === true ? true : undefined;
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
        return {
            kind: 'audio',
            id,
            audioPath,
            ...(title ? { title } : {}),
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

// The structured `project` field (an id or a title) is the Shortcut's own
// project picker, distinct from a parsed `+Project` token in the title. It
// never creates projects and silently drops unknown ones — the task still
// lands in the Inbox where processing catches it. (A parsed `+Project` token
// DOES create an unknown project, same as the in-app quick add — see
// ingestPendingCaptures.)
function resolveStructuredProjectId(capture: PendingCapture, projects: readonly Project[]): string | undefined {
    if (!capture.project) return undefined;
    const ref = capture.project.toLowerCase();
    const match = projects.find((project) => (
        project.id === capture.project || project.title.toLowerCase() === ref
    ));
    return match && isSelectableProjectForTaskAssignment(match) ? match.id : undefined;
}

export function buildPendingCaptureTaskProps(capture: PendingCapture, projects: Project[]): Partial<Task> {
    const props: Partial<Task> = { status: 'inbox' };
    if (capture.note) props.description = capture.note;

    const tags = normalizeShortcutTags(capture.tags);
    if (tags.length > 0) props.tags = tags;

    const projectId = resolveStructuredProjectId(capture, projects);
    if (projectId) props.projectId = projectId;

    if (capture.dueDate) props.dueDate = capture.dueDate;
    if (capture.startDate) props.startTime = capture.startDate;

    return props;
}

type IngestDeps = {
    addTask: (
        title: string,
        initialProps?: Partial<Task>,
        options?: { captureId: string },
    ) => Promise<unknown>;
    // Completes a widget check-off the way the task list's status change does.
    updateTask: (id: string, updates: Partial<Task>) => Promise<unknown>;
    addProject: (title: string, color: string, initialProps?: Partial<Project>) => Promise<Project | null>;
    projects: Project[];
    areas: Area[];
    // Parse context, same as the in-app capture sheet: `@contexts`, `#tags` and
    // `%People` in a queued title only match what already exists if they are here.
    tasks: Task[];
    people: Person[];
    settings: AppData['settings'];
    /** Fresh all-task state, including tombstones, for commands and capture replay checks. */
    getTasks?: () => Task[];
    flushPendingSave?: () => Promise<void>;
    transcribeAudio?: (audioPath: string, settings: AppData['settings']) => Promise<string | null>;
    applyPomodoroCommand?: (command: PendingPomodoro) => Promise<'applied' | 'already-applied' | 'stale'>;
};

const WATCH_CAPTURE_RELEASE_CHECK = 'v1.3.0/watch-capture';
const WATCH_AUDIO_READY_RELEASE_CHECK = 'v1.3.0/watch-audio-ready';
const WATCH_COMMAND_RELEASE_CHECK = 'v1.3.0/watch-command';
const WATCH_OUTBOX_RETRY_RELEASE_CHECK = 'v1.3.0/watch-outbox-retry';
const ANDROID_QUICK_CAPTURE_AUDIO_RELEASE_CHECK = 'v1.3.0/android-quick-capture-audio';
const APPLE_WATCH_SOURCE = 'apple-watch';
const QUICK_CAPTURE_AUDIO_DIRECTORY = 'quick-capture-audio';
const UUID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

function logWatchOutboxRetry(kind: 'text' | 'audio', capture: PendingCapture | PendingAudioCapture): void {
    if (capture.outboxRetried !== true) return;
    void logInfo('Watch outbox retry ingested', {
        scope: 'capture',
        extra: { releaseCheck: WATCH_OUTBOX_RETRY_RELEASE_CHECK, kind, outcome: 'created' },
    });
}

function hasRawDotSegment(fileUri: string): boolean {
    if (!/^file:/i.test(fileUri)) return false;
    const rawPath = fileUri.slice('file:'.length).split(/[?#]/, 1)[0];
    return rawPath.split('/').some((segment) => {
        try {
            const decoded = decodeURIComponent(segment);
            return decoded === '.' || decoded === '..';
        } catch {
            return true;
        }
    });
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

export function resolveSafeWatchAudioPath(audioPath: string, id: string): string | null {
    if (!documentDirectory || !UUID_PATTERN.test(id)) return null;
    try {
        const candidate = new URL(audioPath);
        if (
            candidate.protocol !== 'file:'
            || candidate.host !== ''
            || candidate.search !== ''
            || candidate.hash !== ''
        ) return null;
        const segments = decodeURIComponent(candidate.pathname).split('/').filter(Boolean);
        if (
            segments.at(-3) !== 'Documents'
            || segments.at(-2) !== 'watch-audio'
            || segments.at(-1) !== `${id}.wav`
        ) return null;
        const currentDocuments = documentDirectory.endsWith('/') ? documentDirectory : `${documentDirectory}/`;
        return new URL(`watch-audio/${id}.wav`, currentDocuments).href;
    } catch {
        return null;
    }
}

export function isSafeWatchAudioPath(audioPath: string, id: string): boolean {
    return resolveSafeWatchAudioPath(audioPath, id) !== null;
}

/**
 * Android's recorder and React Native share the current app files directory,
 * so unlike Watch delivery there is no container relocation to repair. Accept
 * only the canonical, current owned WAV URI for this capture UUID.
 */
export function resolveSafeAndroidQuickCaptureAudioPath(audioPath: string, id: string): string | null {
    if (!documentDirectory || !UUID_PATTERN.test(id) || hasRawDotSegment(audioPath)) return null;
    try {
        const currentDocuments = documentDirectory.endsWith('/') ? documentDirectory : `${documentDirectory}/`;
        const expected = new URL(`${QUICK_CAPTURE_AUDIO_DIRECTORY}/${id}.wav`, currentDocuments);
        const candidate = new URL(audioPath);
        if (
            candidate.protocol !== 'file:'
            || candidate.host !== ''
            // React Native's URL implementation omits these optional fields
            // for file URLs. Host and exact URI checks still reject authority.
            || Boolean(candidate.username)
            || Boolean(candidate.password)
            || candidate.search !== ''
            || candidate.hash !== ''
            || candidate.href !== expected.href
        ) return null;
        return expected.href;
    } catch {
        return null;
    }
}

export function isSafeAndroidQuickCaptureAudioPath(audioPath: string, id: string): boolean {
    return resolveSafeAndroidQuickCaptureAudioPath(audioPath, id) !== null;
}

function resolveSafePendingAudioPath(capture: PendingAudioCapture): string | null {
    if (capture.source === ANDROID_QUICK_CAPTURE_SOURCE) {
        return resolveSafeAndroidQuickCaptureAudioPath(capture.audioPath, capture.id);
    }
    // Watch payloads predating the source field remain valid and keep their
    // existing container-relocation behavior.
    if (!capture.source || capture.source === APPLE_WATCH_SOURCE) {
        return resolveSafeWatchAudioPath(capture.audioPath, capture.id);
    }
    return null;
}

const isFailedResult = (result: unknown): boolean => (
    typeof result === 'object' && result !== null && (result as { success?: unknown }).success === false
);

const resultId = (result: unknown): string | undefined => {
    if (typeof result !== 'object' || result === null) return undefined;
    return trimOrUndefined((result as { id?: unknown }).id);
};

// Parse a capture's title with the same quick-add grammar and options as the
// in-app capture sheet (quick-capture-sheet.tsx ~line 428), so a background
// Shortcut capture like `/due:friday @errands #personal +Project` behaves
// identically to typing it into the capture box (#895). The structured
// `project`/`tags` fields from the Shortcut still win over parsed tokens —
// same precedence as a surface's own picker beating a typed `+Project`.
async function assembleCaptureTask(
    capture: PendingCapture,
    { addProject, projects, areas, tasks, people, settings }: Omit<IngestDeps, 'addTask' | 'updateTask'>,
): Promise<{ title: string; props: Partial<Task> } | null> {
    try {
        // Relative dates (`/due:friday`, "tomorrow") resolve against the moment
        // the Shortcut ran, not the later drain — a capture queued Monday night
        // means that Monday's "tomorrow" even if the app first opens on Wednesday.
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
                status: 'inbox',
                ...(capture.note ? { description: capture.note } : {}),
            },
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

                // The Shortcut's own date pickers beat a parsed /due: or /start:
                // token in the title, same precedence as project/tags above.
                if (capture.dueDate) taskProps.dueDate = capture.dueDate;
                if (capture.startDate) taskProps.startTime = capture.startDate;
                return taskProps;
            },
        });

        // Never drop a capture: any parse/prepare failure (invalid date command,
        // empty title, project-create failure) falls back to the legacy verbatim
        // behavior. Background has no UI to surface parse errors.
        if (!prepared.success) return null;
        return { title: prepared.title, props: prepared.props };
    } catch (error) {
        // A throw anywhere above must not abort the drain loop for the captures
        // behind this one — fall back to the verbatim capture, same as a parse
        // failure.
        void logError(error, { scope: 'shortcuts', extra: { message: 'Failed to assemble pending capture' } });
        return null;
    }
}

// At-least-once: a task already done, archived, deleted or unknown is a no-op and the
// file still goes away. The success line is the phase-2 release check.
export async function applyPendingCompletion(
    completion: PendingCompletion,
    { updateTask, tasks, getTasks }: Pick<IngestDeps, 'updateTask' | 'tasks' | 'getTasks'>,
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
        const result = await updateTask(completion.taskId, { status: 'done' });
        if (isFailedResult(result)) return null;
    }
    return outcome;
}

async function applyPendingDefer(
    pending: PendingDefer,
    { updateTask, tasks, getTasks }: Pick<IngestDeps, 'updateTask' | 'tasks' | 'getTasks'>,
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

export async function ingestPendingCaptures({
    addTask,
    updateTask,
    addProject,
    projects,
    areas,
    tasks,
    people,
    settings,
    getTasks,
    flushPendingSave,
    transcribeAudio,
    applyPomodoroCommand,
}: IngestDeps): Promise<number> {
    if (!documentDirectory) return 0;
    const dir = `${documentDirectory}${PENDING_CAPTURES_DIRECTORY}`;

    let names: string[];
    try {
        const info = await getInfoAsync(dir);
        if (!info.exists) return 0;
        names = await readDirectoryAsync(dir);
    } catch (error) {
        void logError(error, { scope: 'shortcuts', extra: { message: 'Failed to read pending captures' } });
        return 0;
    }

    const entries: { capture: PendingQueueItem | null; fileUri: string; name: string }[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
        const fileUri = `${dir}/${name}`;
        try {
            entries.push({ capture: parsePendingCapture(await readAsStringAsync(fileUri)), fileUri, name });
        } catch (error) {
            void logError(error, { scope: 'shortcuts', extra: { message: 'Failed to read pending capture', name } });
        }
    }

    const isWatchCommand = (capture: PendingQueueItem | null) => (
        capture?.kind === 'defer'
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

    let ingested = 0;
    for (const { capture, fileUri, name } of orderedEntries) {
        if (!capture) {
            // Only our own Swift intent writes here, so an unparsable file is
            // corruption, not a transient failure — retrying forever would
            // re-log on every foreground.
            void logWarn('Discarding malformed pending capture', { scope: 'shortcuts', extra: { name } });
            await deleteAsync(fileUri, { idempotent: true }).catch(() => undefined);
            continue;
        }

        if (capture.kind === 'complete') {
            const outcome = await applyPendingCompletion(capture, { updateTask, tasks, getTasks });
            if (!outcome) continue;
            try {
                await flushPendingSave?.();
                await deleteAsync(fileUri, { idempotent: true });
            } catch {
                continue;
            }
            ingested += 1;
            if (capture.source === 'apple-watch') {
                void logInfo('Watch command ingested', {
                    scope: 'capture',
                    extra: { releaseCheck: WATCH_COMMAND_RELEASE_CHECK, kind: 'complete', outcome },
                });
            } else if (outcome === 'terminal') {
                void logInfo('Widget check-off ingested', {
                    scope: 'capture',
                    extra: { releaseCheck: 'v1.3.0/widget-terminal-preserved', outcome },
                });
            } else {
                void logInfo('Widget check-off ingested', {
                    scope: 'capture',
                    extra: { releaseCheck: ANDROID_WIDGET_CHECKOFF_RELEASE_CHECK, outcome },
                });
            }
            continue;
        }

        if (capture.kind === 'defer') {
            const outcome = await applyPendingDefer(capture, { updateTask, tasks, getTasks });
            if (!outcome) continue;
            try {
                await flushPendingSave?.();
                await deleteAsync(fileUri, { idempotent: true });
            } catch {
                continue;
            }
            ingested += 1;
            void logInfo('Watch command ingested', {
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
                await deleteAsync(fileUri, { idempotent: true });
            } catch {
                continue;
            }
            ingested += 1;
            void logInfo('Watch command ingested', {
                scope: 'capture',
                extra: { releaseCheck: WATCH_COMMAND_RELEASE_CHECK, kind: 'pomodoro', action: capture.action, outcome },
            });
            continue;
        }

        if (capture.kind === 'audio') {
            const isAndroidQuickCapture = capture.source === ANDROID_QUICK_CAPTURE_SOURCE;
            const normalizedCaptureId = capture.id.toLowerCase();
            const hasCanonicalAndroidQueueName = !isAndroidQuickCapture || name === `${capture.id}.json`;
            const resolvedAudioPath = hasCanonicalAndroidQueueName
                ? resolveSafePendingAudioPath(capture)
                : null;
            if (!resolvedAudioPath) {
                if (isAndroidQuickCapture) {
                    void logWarn('Discarding Android quick capture audio with invalid contract', {
                        scope: 'capture',
                        extra: { releaseCheck: ANDROID_QUICK_CAPTURE_AUDIO_RELEASE_CHECK, kind: 'audio', outcome: 'invalid-path' },
                    });
                } else {
                    void logWarn('Discarding Watch audio capture with invalid path', {
                        scope: 'capture',
                        extra: { releaseCheck: WATCH_CAPTURE_RELEASE_CHECK, kind: 'audio', outcome: 'invalid-path' },
                    });
                }
                await deleteAsync(fileUri, { idempotent: true }).catch(() => undefined);
                continue;
            }

            const currentTasks = getTasks?.() ?? tasks;
            const existingCaptureTask = isAndroidQuickCapture
                ? currentTasks.find((task) => task.id.toLowerCase() === normalizedCaptureId)
                : undefined;
            if (existingCaptureTask) {
                // A prior attempt may have durably created the task but crashed
                // before queue cleanup. Tombstones count too: deleting the task
                // must not make the same native capture reappear.
                let replayResult: unknown;
                try {
                    replayResult = await addTask(
                        existingCaptureTask.title?.trim() || capture.title || 'Audio capture',
                        undefined,
                        { captureId: normalizedCaptureId },
                    );
                } catch {
                    void logWarn('Android quick capture audio retained for retry', {
                        scope: 'capture',
                        extra: { releaseCheck: ANDROID_QUICK_CAPTURE_AUDIO_RELEASE_CHECK, kind: 'audio', outcome: 'task-save-failed' },
                    });
                    continue;
                }
                if (
                    isFailedResult(replayResult)
                    || resultId(replayResult)?.toLowerCase() !== normalizedCaptureId
                ) {
                    void logWarn('Android quick capture audio retained for retry', {
                        scope: 'capture',
                        extra: { releaseCheck: ANDROID_QUICK_CAPTURE_AUDIO_RELEASE_CHECK, kind: 'audio', outcome: 'task-save-failed' },
                    });
                    continue;
                }
                try {
                    await flushPendingSave?.();
                    await deleteAsync(fileUri, { idempotent: true });
                } catch {
                    void logWarn('Android quick capture audio retained for retry', {
                        scope: 'capture',
                        extra: { releaseCheck: ANDROID_QUICK_CAPTURE_AUDIO_RELEASE_CHECK, kind: 'audio', outcome: 'cleanup-failed' },
                    });
                    continue;
                }
                await deleteAsync(resolvedAudioPath, { idempotent: true }).catch(() => undefined);
                ingested += 1;
                void logInfo('Android quick capture audio ingested', {
                    scope: 'capture',
                    extra: { releaseCheck: ANDROID_QUICK_CAPTURE_AUDIO_RELEASE_CHECK, kind: 'audio', outcome: 'already-created' },
                });
                continue;
            }

            if (isAndroidQuickCapture) {
                void logInfo('Android quick capture audio ready for transcription', {
                    scope: 'capture',
                    extra: { releaseCheck: ANDROID_QUICK_CAPTURE_AUDIO_RELEASE_CHECK, kind: 'audio', outcome: 'validated' },
                });
            } else {
                void logInfo('Watch audio ready for transcription', {
                    scope: 'capture',
                    extra: { releaseCheck: WATCH_AUDIO_READY_RELEASE_CHECK, outcome: 'validated' },
                });
            }
            if (!transcribeAudio) continue;
            let transcript: string | null = null;
            try {
                transcript = await transcribeAudio(resolvedAudioPath, settings);
            } catch {
                if (isAndroidQuickCapture) {
                    void logWarn('Android quick capture audio retained for retry', {
                        scope: 'capture',
                        extra: { releaseCheck: ANDROID_QUICK_CAPTURE_AUDIO_RELEASE_CHECK, kind: 'audio', outcome: 'transcription-failed' },
                    });
                } else {
                    void logWarn('Watch audio capture retained for retry', {
                        scope: 'capture',
                        extra: { releaseCheck: WATCH_CAPTURE_RELEASE_CHECK, kind: 'audio', outcome: 'transcription-failed' },
                    });
                }
                continue;
            }
            if (!transcript) {
                if (isAndroidQuickCapture) {
                    void logWarn('Android quick capture audio retained for retry', {
                        scope: 'capture',
                        extra: { releaseCheck: ANDROID_QUICK_CAPTURE_AUDIO_RELEASE_CHECK, kind: 'audio', outcome: 'transcription-unavailable' },
                    });
                } else {
                    void logWarn('Watch audio capture retained for retry', {
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
                tags: [],
                createdAt: capture.createdAt,
                source: capture.source,
            };
            const activeTasks = currentTasks.filter((task) => !task.deletedAt && !task.purgedAt);
            const assembled = await assembleCaptureTask(textCapture, { addProject, projects, areas, tasks: activeTasks, people, settings });
            const title = assembled?.title ?? textCapture.title;
            const props = assembled?.props ?? buildPendingCaptureTaskProps(textCapture, projects);
            let result: unknown;
            if (isAndroidQuickCapture) {
                try {
                    result = await addTask(title, props, { captureId: normalizedCaptureId });
                } catch {
                    void logWarn('Android quick capture audio retained for retry', {
                        scope: 'capture',
                        extra: { releaseCheck: ANDROID_QUICK_CAPTURE_AUDIO_RELEASE_CHECK, kind: 'audio', outcome: 'task-save-failed' },
                    });
                    continue;
                }
            } else {
                // Preserve the existing Watch failure behavior; Android catches
                // locally so later text captures cannot be stranded behind it.
                result = await addTask(title, props);
            }
            if (
                isFailedResult(result)
                || (isAndroidQuickCapture && resultId(result)?.toLowerCase() !== normalizedCaptureId)
            ) {
                if (isAndroidQuickCapture) {
                    void logWarn('Android quick capture audio retained for retry', {
                        scope: 'capture',
                        extra: { releaseCheck: ANDROID_QUICK_CAPTURE_AUDIO_RELEASE_CHECK, kind: 'audio', outcome: 'task-save-failed' },
                    });
                }
                continue;
            }
            try {
                await flushPendingSave?.();
                await deleteAsync(fileUri, { idempotent: true });
            } catch {
                if (isAndroidQuickCapture) {
                    void logWarn('Android quick capture audio retained for retry', {
                        scope: 'capture',
                        extra: { releaseCheck: ANDROID_QUICK_CAPTURE_AUDIO_RELEASE_CHECK, kind: 'audio', outcome: 'cleanup-failed' },
                    });
                }
                continue;
            }
            // The queue must be gone before its WAV: otherwise a failed queue
            // delete can replay an item whose audio was already removed.
            await deleteAsync(resolvedAudioPath, { idempotent: true }).catch(() => undefined);
            ingested += 1;
            if (isAndroidQuickCapture) {
                void logInfo('Android quick capture audio ingested', {
                    scope: 'capture',
                    extra: { releaseCheck: ANDROID_QUICK_CAPTURE_AUDIO_RELEASE_CHECK, kind: 'audio', outcome: 'created' },
                });
            } else {
                void logInfo('Watch capture ingested', {
                    scope: 'capture',
                    extra: { releaseCheck: WATCH_CAPTURE_RELEASE_CHECK, kind: 'audio', outcome: 'created' },
                });
                logWatchOutboxRetry('audio', capture);
            }
            continue;
        }

        const assembled = await assembleCaptureTask(capture, { addProject, projects, areas, tasks, people, settings });
        const result = assembled
            ? await addTask(assembled.title, assembled.props)
            : await addTask(capture.title, buildPendingCaptureTaskProps(capture, projects));
        if (isFailedResult(result)) continue;

        // Delete only after the store write resolved; a crash in between at
        // worst re-ingests one capture.
        try {
            await flushPendingSave?.();
            await deleteAsync(fileUri, { idempotent: true });
        } catch {
            continue;
        }
        ingested += 1;
        if (capture.source === ANDROID_QUICK_CAPTURE_SOURCE) {
            void logInfo('Quick capture dialog item ingested', {
                scope: 'capture',
                extra: { releaseCheck: ANDROID_QUICK_CAPTURE_RELEASE_CHECK },
            });
        } else if (capture.source === ANDROID_CAPTURE_INTENT_SOURCE) {
            void logInfo('Android automation capture ingested', {
                scope: 'capture',
                extra: { releaseCheck: ANDROID_CAPTURE_INTENT_RELEASE_CHECK },
            });
        } else if (capture.source === 'apple-watch') {
            void logInfo('Watch capture ingested', {
                scope: 'capture',
                extra: { releaseCheck: WATCH_CAPTURE_RELEASE_CHECK, kind: 'text', outcome: 'created' },
            });
            logWatchOutboxRetry('text', capture);
        }
    }
    return ingested;
}
