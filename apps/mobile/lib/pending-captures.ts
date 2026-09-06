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
// appends JSON files to this directory; every task write happens here, through
// the normal store path, so revisions, save tracking, and sync merge behavior
// stay intact.
export const PENDING_CAPTURES_DIRECTORY = 'pending-captures';
export const ANDROID_QUICK_CAPTURE_SOURCE = 'android-quick-capture';
const ANDROID_QUICK_CAPTURE_RELEASE_CHECK = 'v1.2.9/android-quick-capture-dialog';

export type PendingCapture = {
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
};

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

export function parsePendingCapture(raw: string): PendingCapture | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const record = parsed as Record<string, unknown>;
    const id = trimOrUndefined(record.id);
    const title = trimOrUndefined(record.title);
    if (!id || !title) return null;

    const note = trimOrUndefined(record.note);
    const project = trimOrUndefined(record.project);
    const createdAt = trimOrUndefined(record.createdAt);
    const tagsRaw = trimOrUndefined(record.tags);
    const tags = tagsRaw ? tagsRaw.split(',').map((tag) => tag.trim()).filter(Boolean) : [];
    const dueDate = sanitizeStructuredDateInput(record.dueDate);
    const startDate = sanitizeStructuredDateInput(record.startDate);
    const source = trimOrUndefined(record.source);

    return {
        id,
        title,
        ...(note ? { note } : {}),
        tags,
        ...(project ? { project } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(dueDate ? { dueDate } : {}),
        ...(startDate ? { startDate } : {}),
        ...(source ? { source } : {}),
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
    addTask: (title: string, initialProps?: Partial<Task>) => Promise<unknown>;
    addProject: (title: string, color: string, initialProps?: Partial<Project>) => Promise<Project | null>;
    projects: Project[];
    areas: Area[];
    // Parse context, same as the in-app capture sheet: `@contexts`, `#tags` and
    // `%People` in a queued title only match what already exists if they are here.
    tasks: Task[];
    people: Person[];
    settings: AppData['settings'];
};

const isFailedResult = (result: unknown): boolean => (
    typeof result === 'object' && result !== null && (result as { success?: unknown }).success === false
);

// Parse a capture's title with the same quick-add grammar and options as the
// in-app capture sheet (quick-capture-sheet.tsx ~line 428), so a background
// Shortcut capture like `/due:friday @errands #personal +Project` behaves
// identically to typing it into the capture box (#895). The structured
// `project`/`tags` fields from the Shortcut still win over parsed tokens —
// same precedence as a surface's own picker beating a typed `+Project`.
async function assembleCaptureTask(
    capture: PendingCapture,
    { addProject, projects, areas, tasks, people, settings }: Omit<IngestDeps, 'addTask'>,
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

export async function ingestPendingCaptures({ addTask, addProject, projects, areas, tasks, people, settings }: IngestDeps): Promise<number> {
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

    let ingested = 0;
    for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
        const fileUri = `${dir}/${name}`;
        let capture: PendingCapture | null = null;
        try {
            capture = parsePendingCapture(await readAsStringAsync(fileUri));
        } catch (error) {
            void logError(error, { scope: 'shortcuts', extra: { message: 'Failed to read pending capture', name } });
            continue;
        }

        if (!capture) {
            // Only our own Swift intent writes here, so an unparsable file is
            // corruption, not a transient failure — retrying forever would
            // re-log on every foreground.
            void logWarn('Discarding malformed pending capture', { scope: 'shortcuts', extra: { name } });
            await deleteAsync(fileUri, { idempotent: true }).catch(() => undefined);
            continue;
        }

        const assembled = await assembleCaptureTask(capture, { addProject, projects, areas, tasks, people, settings });
        const result = assembled
            ? await addTask(assembled.title, assembled.props)
            : await addTask(capture.title, buildPendingCaptureTaskProps(capture, projects));
        if (isFailedResult(result)) continue;

        // Delete only after the store write resolved; a crash in between at
        // worst re-ingests one capture.
        await deleteAsync(fileUri, { idempotent: true }).catch(() => undefined);
        ingested += 1;
        if (capture.source === ANDROID_QUICK_CAPTURE_SOURCE) {
            void logInfo('Quick capture dialog item ingested', {
                scope: 'capture',
                extra: { releaseCheck: ANDROID_QUICK_CAPTURE_RELEASE_CHECK },
            });
        }
    }
    return ingested;
}
