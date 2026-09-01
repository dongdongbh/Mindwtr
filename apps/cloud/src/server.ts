#!/usr/bin/env bun
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { basename, join } from 'path';
import {
    applyTaskUpdates,
    areSyncPayloadsEqual,
    buildHttpRemoteFileFingerprint,
    compactPurgedProjectSectionTombstone,
    compactPurgedProjectTombstone,
    filterNotDeleted,
    filterProjectsBySearch,
    filterTasksBySearch,
    generateUUID,
    getNextProjectOrder,
    getTaskOrder,
    isTaskFinished,
    mergeAppDataWithStats,
    normalizeTaskUpdate,
    buildQuickAddParseOptions,
    parseQuickAdd,
    repairMergedSyncReferences,
    resolveCaptureStatusForStart,
    type Area,
    type AppData,
    type Project,
    type Section,
    type Task,
    type TaskStatus,
} from '@mindwtr/core';
import {
    getAuthFailureRateKey,
    getAuthFailureTokenRateKey,
    normalizeAllowedAuthTokens,
    parseBoolEnv,
    parseTrustedProxyIps,
    resolveAllowedAuthTokensFromEnv,
    tokenToKey,
    type AllowedAuthTokenInput,
} from './server-auth';
import {
    CLOUD_API_REV_BY,
    corsOrigin,
    createInternalServerErrorResponse,
    errorResponse,
    jsonResponse,
    logError,
    logFailureWarn,
    logInfo,
    logWarn,
    LIST_MAX_LIMIT,
    MAX_AREA_NAME_LENGTH,
    MAX_TASK_QUICK_ADD_LENGTH,
    MAX_TASK_TITLE_LENGTH,
    normalizeRevision,
    parseArgs,
    parsePagination,
    preflightResponse,
    UUID_PATTERN,
} from './server-config';
import { resolveCloudRuntimeConfig } from './server-runtime-config';
import {
    abandonPreparedFilePublication,
    createRequestAbortError,
    createWriteLockRunner,
    ensureWritableDir,
    isBodyReadError,
    isRequestAbortError,
    readData,
    readJsonBody,
    probeExistingWritableDir,
    prepareFilePublicationSafely,
    resolveAttachmentPath,
    throwIfRequestAborted,
    type PreparedFilePublication,
} from './server-storage';
import {
    appendPendingRemoteAttachmentDeletes,
    collectPendingRemoteDeletesForProjectPurge,
    handleAttachmentPathRequest,
    handleOrphanAttachmentGcRequest,
} from './server-attachments';
import {
    asStatus,
    pickTaskList,
    validateAppData,
    validateEntityProps,
} from './server-validation';
import {
    dataMetadataResponse,
    getDataFileMetadata,
    isTrustedValidatedDataFile,
    jsonFileResponse,
    loadAppDataOrError,
    rememberValidatedDataFile,
    writeCloudData,
} from './server-data-cache';
import { createRateLimiter } from './server-rate-limit';
import { normalizeRequestPathname, withNamespace, type ServerConfig } from './server-request';
import {
    CALENDAR_FEED_PATH_PREFIX,
    calendarFeedResponse,
    findCalendarFeedNamespace,
    parseCalendarFeedPathToken,
    pruneOrphanedCalendarFeeds,
    readCalendarFeed,
    revokeCalendarFeed,
    rotateCalendarFeed,
    type CalendarFeedRecord,
} from './server-calendar-feed';

const NAMESPACE_ADMISSION_LOCK_KEY = '__namespace_admission__';
const createEmptyCloudData = (): AppData => ({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    people: [],
    settings: {},
});

const generateRequestId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export type CloudRequestCompletion = {
    requestId: string;
    method: string;
    route: string;
    status: number;
    elapsedMs: number;
};

export const shouldLogCloudRequest = (
    completion: CloudRequestCompletion,
    logAllRequests: boolean,
    slowRequestMs: number,
): boolean => (
    logAllRequests
    || completion.status >= 400
    || completion.elapsedMs >= slowRequestMs
);

const STATIC_CLOUD_ROUTES = new Set([
    '/',
    '/health',
    '/ready',
    '/v1/areas',
    '/v1/attachments/orphans',
    '/v1/calendar/feed',
    '/v1/data',
    '/v1/projects',
    '/v1/search',
    '/v1/sections',
    '/v1/tasks',
]);

export function canonicalCloudRoute(pathname: string): string {
    if (STATIC_CLOUD_ROUTES.has(pathname)) return pathname;
    const taskActionMatch = pathname.match(/^\/v1\/tasks\/[^/]+\/(complete|archive)$/);
    if (taskActionMatch) return `/v1/tasks/:id/${taskActionMatch[1]}`;
    if (/^\/v1\/tasks\/[^/]+$/.test(pathname)) return '/v1/tasks/:id';
    if (/^\/v1\/projects\/[^/]+$/.test(pathname)) return '/v1/projects/:id';
    if (/^\/v1\/sections\/[^/]+$/.test(pathname)) return '/v1/sections/:id';
    if (/^\/v1\/areas\/[^/]+$/.test(pathname)) return '/v1/areas/:id';
    if (/^\/v1\/calendar\/[^/]+\.ics$/.test(pathname)) return '/v1/calendar/:token';
    if (pathname.startsWith('/v1/attachments/')) return '/v1/attachments/:path';
    return 'unmatched';
}

const attachRequestId = (response: Response, requestId: string): void => {
    response.headers.set('X-Request-Id', requestId);
    if (!response.headers.has('Access-Control-Allow-Origin')) return;
    const exposedHeaders = (response.headers.get('Access-Control-Expose-Headers') ?? '')
        .split(',')
        .map((header) => header.trim())
        .filter(Boolean);
    if (!exposedHeaders.some((header) => header.toLowerCase() === 'x-request-id')) {
        exposedHeaders.push('X-Request-Id');
        response.headers.set('Access-Control-Expose-Headers', exposedHeaders.join(', '));
    }
};

const emptyCorsResponse = (status: number): Response => {
    const headers = new Headers({
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET,HEAD,PUT,POST,PATCH,DELETE,OPTIONS',
    });
    return new Response(null, { status, headers });
};

const normalizeStoredAppData = (data: AppData): AppData => ({
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    sections: Array.isArray(data.sections) ? data.sections : [],
    areas: Array.isArray(data.areas) ? data.areas : [],
    people: Array.isArray(data.people) ? data.people : [],
    settings: isRecord(data.settings) ? data.settings : {},
});

const validateStoredAppData = (
    filePath: string,
    rawData: unknown,
): AppData | { error: Response } => {
    if (isTrustedValidatedDataFile(filePath)) {
        return normalizeStoredAppData(rawData as AppData);
    }
    const validated = validateAppData(rawData);
    if (!validated.ok) {
        logFailureWarn('Stored cloud data failed validation', {
            failureClass: 'validation',
            failureCode: 'stored_data_invalid',
        });
        return { error: errorResponse('Stored data failed validation', 500) };
    }
    rememberValidatedDataFile(filePath);
    return normalizeStoredAppData(validated.data);
};

const loadExistingDataForMerge = (filePath: string): AppData | { error: Response } => {
    if (!existsSync(filePath)) return { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
    const rawData = readData(filePath);
    if (!rawData) {
        logFailureWarn('Stored cloud data failed validation', {
            failureClass: 'validation',
            failureCode: 'stored_data_invalid_json',
        });
        return { error: errorResponse('Stored data failed validation', 500) };
    }
    return validateStoredAppData(filePath, rawData);
};

type BunServer = {
    port: number;
    stop?: (closeIdleConnections?: boolean) => void | Promise<void>;
};

type BunRuntime = {
    serve: (options: {
        hostname: string;
        port: number;
        fetch: (req: Request) => Response | Promise<Response>;
    }) => BunServer;
};

const getBunRuntime = (): BunRuntime | undefined => (
    (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun
);

const IS_MAIN_MODULE = !!getBunRuntime() && (import.meta as ImportMeta & { main?: boolean }).main === true;

function decodePathParam(rawValue: string): string | null {
    try {
        return decodeURIComponent(rawValue);
    } catch {
        return null;
    }
}

function parseTaskRouteId(rawValue: string): string | null {
    const decoded = decodePathParam(rawValue);
    if (!decoded) return null;
    return UUID_PATTERN.test(decoded) ? decoded : null;
}

function parseEntityRouteId(rawValue: string): string | null {
    const decoded = decodePathParam(rawValue);
    const trimmed = decoded?.trim() ?? '';
    if (!trimmed || trimmed.length > 200 || trimmed.includes('/')) return null;
    return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PROJECT_STATUSES = new Set<Project['status']>(['active', 'someday', 'waiting', 'archived']);

function asProjectStatus(value: unknown): Project['status'] | null {
    return PROJECT_STATUSES.has(value as Project['status']) ? value as Project['status'] : null;
}

function readObjectBody(body: unknown): Record<string, unknown> | null {
    return isRecord(body) ? body : null;
}

function nextOrder(items: Array<{ order?: number }>): number {
    return items.reduce((maxOrder, item) => (
        typeof item.order === 'number' && Number.isFinite(item.order)
            ? Math.max(maxOrder, item.order)
            : maxOrder
    ), -1) + 1;
}

function parseSearchPaginationValue(searchParams: URLSearchParams, name: string, fallback: number): number | { error: string } {
    const raw = searchParams.get(name);
    if (raw == null) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || (name.toLowerCase().includes('limit') && parsed <= 0)) {
        return { error: `Invalid ${name}` };
    }
    const value = Math.floor(parsed);
    return name.toLowerCase().includes('limit') ? Math.min(LIST_MAX_LIMIT, value) : value;
}

/**
 * Parses an optional boolean query param. Accepts `1`/`0` (the convention `all` and `deleted`
 * already use) and `true`/`false`, and reports anything else as an error rather than silently
 * treating it as false — `?isFocusedToday=yes` should not quietly return the whole list.
 */
function parseBooleanQueryParam(searchParams: URLSearchParams, name: string): boolean | undefined | { error: string } {
    const raw = searchParams.get(name);
    if (raw == null) return undefined;
    const normalized = raw.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') return true;
    if (normalized === '0' || normalized === 'false') return false;
    return { error: `Invalid ${name}` };
}

type FinalizeCloudDataForWriteOptions = {
    rejectInvalidBeforeRepair?: boolean;
};

const FINALIZE_REJECT_INVALID_REST_WRITE: FinalizeCloudDataForWriteOptions = {
    rejectInvalidBeforeRepair: true,
};

function finalizeCloudDataForWrite(
    data: AppData,
    nowIso: string,
    options: FinalizeCloudDataForWriteOptions = {},
): AppData | { error: Response } {
    if (options.rejectInvalidBeforeRepair) {
        const initialValidation = validateAppData(data);
        if (!initialValidation.ok) {
            return { error: errorResponse(initialValidation.error, 400) };
        }
    }
    const repaired = repairMergedSyncReferences(data, nowIso);
    const validated = validateAppData(repaired);
    if (!validated.ok) {
        return { error: errorResponse(validated.error, 400) };
    }
    return repaired;
}

// Mirrors the store's stampNewRecurringFollowUp (packages/core/src/store-tasks.ts):
// a follow-up is a fresh task, so it needs a reserved project order (missing sorts
// as +Infinity in compareTasksByProjectOrder, dumping it below its siblings) and a
// zeroed push count, same as every other task-creation path.
// Mirrors core's stampNewRecurringFollowUp: the next occurrence inherits the
// completed instance's place (that instance leaves the active list, and a series
// only ever has one active instance) and only reserves a fresh order when the
// completed task had none.
const stampRecurringFollowUp = (task: Task, completedTask: Task, existingTasks: Task[]): Task => {
    const order = getTaskOrder(completedTask) ?? getNextProjectOrder(task.projectId, existingTasks);
    return { ...task, pushCount: 0, order, orderNum: order };
};

type CloudEntity = {
    id: string;
    deletedAt?: string;
    updatedAt: string;
    rev?: number;
    revBy?: string;
};
type EntityCollectionKey = 'tasks' | 'projects' | 'sections' | 'areas';
type EntityItemKey = 'task' | 'project' | 'section' | 'area';

type EntityRouteDefinition<T extends CloudEntity> = {
    path: string;
    collectionKey: EntityCollectionKey;
    itemKey: EntityItemKey;
    listKey: EntityCollectionKey;
    label: string;
    invalidIdMessage: string;
    /** Defaults to parseEntityRouteId. Tasks override it to keep requiring a UUID. */
    parseId?: (rawValue: string) => string | null;
    /** Defaults to {} (repair-then-validate). Tasks pass FINALIZE_REJECT_INVALID_REST_WRITE. */
    finalizeOptions?: FinalizeCloudDataForWriteOptions;
    listItems: (data: AppData, url: URL) => T[] | Response;
    createEntity: (body: Record<string, unknown>, data: AppData, nowIso: string) => T | Response;
    canPatchDeletedEntity?: (body: Record<string, unknown>) => boolean;
    patchEntity: (body: Record<string, unknown>, existing: T, data: AppData, nowIso: string) => T | Response;
};

type EntityRouteContext = {
    assertStorageRoot: () => void;
    key: string;
    filePath: string;
    maxBodyBytes: number;
    signal: AbortSignal;
    withWriteLock: ReturnType<typeof createWriteLockRunner>;
};

type EntityBodyResult =
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; response: Response };

const isResponse = (value: unknown): value is Response => value instanceof Response;

const readEntityObjectBody = async (
    req: Request,
    maxBodyBytes: number,
    signal: AbortSignal
): Promise<EntityBodyResult> => {
    const body = await readJsonBody(req, maxBodyBytes, signal);
    if (isBodyReadError(body)) {
        const err = body.__mindwtrError;
        return {
            ok: false,
            response: errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413),
        };
    }
    const bodyRecord = readObjectBody(body);
    if (!bodyRecord) return { ok: false, response: errorResponse('Invalid JSON body') };
    return { ok: true, body: bodyRecord };
};

const getEntityCollection = <T extends CloudEntity>(data: AppData, route: EntityRouteDefinition<T>): T[] =>
    data[route.collectionKey] as unknown as T[];

const handleEntityRoute = async <T extends CloudEntity>(
    route: EntityRouteDefinition<T>,
    req: Request,
    pathname: string,
    url: URL,
    context: EntityRouteContext
): Promise<Response | null> => {
    if (req.method === 'GET' && pathname === route.path) {
        throwIfRequestAborted(context.signal);
        const pagination = parsePagination(url.searchParams);
        if ('error' in pagination) return errorResponse(pagination.error, 400);
        const dataResult = loadAppDataOrError(context.filePath);
        if ('error' in dataResult) return dataResult.error;
        const data = dataResult;
        const items = route.listItems(data, url);
        if (isResponse(items)) return items;
        const total = items.length;
        return jsonResponse({
            [route.listKey]: items.slice(pagination.offset, pagination.offset + pagination.limit),
            total,
            limit: pagination.limit,
            offset: pagination.offset,
        });
    }

    if (req.method === 'POST' && pathname === route.path) {
        const bodyResult = await readEntityObjectBody(req, context.maxBodyBytes, context.signal);
        if (!bodyResult.ok) return bodyResult.response;

        return await context.withWriteLock(context.key, async () => {
            throwIfRequestAborted(context.signal);
            const dataResult = loadAppDataOrError(context.filePath);
            if ('error' in dataResult) return dataResult.error;
            const data = dataResult;
            const nowIso = new Date().toISOString();
            const entity = route.createEntity(bodyResult.body, data, nowIso);
            if (isResponse(entity)) return entity;
            getEntityCollection(data, route).push(entity);
            const finalized = finalizeCloudDataForWrite(data, nowIso, route.finalizeOptions);
            if ('error' in finalized) return finalized.error;
            throwIfRequestAborted(context.signal);
            writeCloudData(context.filePath, finalized, {
                assertStorageRoot: context.assertStorageRoot,
            });
            const savedEntity = getEntityCollection(finalized, route).find((item) => item.id === entity.id) ?? entity;
            return jsonResponse({ [route.itemKey]: savedEntity }, { status: 201 });
        });
    }

    const entityMatch = pathname.match(new RegExp(`^${route.path}/([^/]+)$`));
    if (!entityMatch) return null;
    const parseId = route.parseId ?? parseEntityRouteId;
    const entityId = parseId(entityMatch[1]);
    if (!entityId) return errorResponse(route.invalidIdMessage, 400);

    if (req.method === 'GET') {
        const dataResult = loadAppDataOrError(context.filePath);
        if ('error' in dataResult) return dataResult.error;
        const data = dataResult;
        const entity = getEntityCollection(data, route).find((item) => item.id === entityId && !item.deletedAt);
        if (!entity) return errorResponse(`${route.label} not found`, 404);
        return jsonResponse({ [route.itemKey]: entity });
    }

    if (req.method === 'PATCH') {
        const bodyResult = await readEntityObjectBody(req, context.maxBodyBytes, context.signal);
        if (!bodyResult.ok) return bodyResult.response;

        return await context.withWriteLock(context.key, async () => {
            throwIfRequestAborted(context.signal);
            const dataResult = loadAppDataOrError(context.filePath);
            if ('error' in dataResult) return dataResult.error;
            const data = dataResult;
            const collection = getEntityCollection(data, route);
            const idx = collection.findIndex((item) => (
                item.id === entityId
                && (!item.deletedAt || route.canPatchDeletedEntity?.(bodyResult.body))
            ));
            if (idx < 0) return errorResponse(`${route.label} not found`, 404);
            const nowIso = new Date().toISOString();
            const updated = route.patchEntity(bodyResult.body, collection[idx], data, nowIso);
            if (isResponse(updated)) return updated;
            collection[idx] = updated;
            const finalized = finalizeCloudDataForWrite(data, nowIso, route.finalizeOptions);
            if ('error' in finalized) return finalized.error;
            throwIfRequestAborted(context.signal);
            writeCloudData(context.filePath, finalized, {
                assertStorageRoot: context.assertStorageRoot,
            });
            const entity = getEntityCollection(finalized, route).find((item) => item.id === entityId);
            return jsonResponse({ [route.itemKey]: entity });
        });
    }

    if (req.method === 'DELETE') {
        return await context.withWriteLock(context.key, async () => {
            throwIfRequestAborted(context.signal);
            const dataResult = loadAppDataOrError(context.filePath);
            if ('error' in dataResult) return dataResult.error;
            const data = dataResult;
            const collection = getEntityCollection(data, route);
            const idx = collection.findIndex((item) => item.id === entityId && !item.deletedAt);
            if (idx < 0) return errorResponse(`${route.label} not found`, 404);
            const nowIso = new Date().toISOString();
            const existing = collection[idx];
            collection[idx] = {
                ...existing,
                deletedAt: nowIso,
                updatedAt: nowIso,
                rev: normalizeRevision(existing.rev) + 1,
                revBy: CLOUD_API_REV_BY,
            };
            const finalized = finalizeCloudDataForWrite(data, nowIso, route.finalizeOptions);
            if ('error' in finalized) return finalized.error;
            throwIfRequestAborted(context.signal);
            writeCloudData(context.filePath, finalized, {
                assertStorageRoot: context.assertStorageRoot,
            });
            return jsonResponse({ ok: true });
        });
    }

    return null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- The route table is heterogeneous; each route owns its entity type.
const ENTITY_ROUTES: Array<EntityRouteDefinition<any>> = [
    {
        path: '/v1/tasks',
        collectionKey: 'tasks',
        itemKey: 'task',
        listKey: 'tasks',
        label: 'Task',
        invalidIdMessage: 'Invalid task id',
        parseId: parseTaskRouteId,
        finalizeOptions: FINALIZE_REJECT_INVALID_REST_WRITE,
        listItems: (data, url): Task[] | Response => {
            const query = url.searchParams.get('query') || '';
            const includeAll = url.searchParams.get('all') === '1';
            const includeDeleted = url.searchParams.get('deleted') === '1';
            const rawStatus = url.searchParams.get('status');
            const status = asStatus(rawStatus);
            if (rawStatus !== null && status === null) {
                return errorResponse('Invalid task status');
            }
            const isFocusedToday = parseBooleanQueryParam(url.searchParams, 'isFocusedToday');
            if (isFocusedToday !== undefined && typeof isFocusedToday === 'object') {
                return errorResponse(isFocusedToday.error);
            }
            return pickTaskList(data, { includeDeleted, includeCompleted: includeAll, status, query, isFocusedToday });
        },
        createEntity: (bodyRecord, data, nowIso): Task | Response => {
            const input = typeof bodyRecord.input === 'string' ? bodyRecord.input : '';
            const rawTitle = typeof bodyRecord.title === 'string' ? bodyRecord.title : '';
            const rawInitialProps = readObjectBody(bodyRecord.props) ?? {};
            const validatedInitialProps = validateEntityProps('task', 'create', rawInitialProps);
            if (!validatedInitialProps.ok) {
                return errorResponse(validatedInitialProps.error, 400);
            }
            const initialProps = validatedInitialProps.props;
            if (input.trim().length > MAX_TASK_QUICK_ADD_LENGTH) {
                return errorResponse(`Quick-add input too long (max ${MAX_TASK_QUICK_ADD_LENGTH} characters)`, 400);
            }

            const parsed = input
                ? parseQuickAdd(
                    input,
                    data.projects,
                    new Date(nowIso),
                    data.areas,
                    buildQuickAddParseOptions(data.settings, { tasks: data.tasks, people: data.people }),
                )
                : { title: rawTitle, props: {} };
            const title = (parsed.title || rawTitle || input).trim();
            if (!title) return errorResponse('Missing task title');
            if (title.length > MAX_TASK_TITLE_LENGTH) {
                return errorResponse(`Task title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
            }

            const props: Partial<Task> = {
                ...parsed.props,
                ...initialProps,
            };

            const rawStatus = props.status;
            const parsedStatus = asStatus(rawStatus);
            if (rawStatus !== undefined && parsedStatus === null) {
                return errorResponse('Invalid task status', 400);
            }
            // Mirrors the store's create-side promotion (addTasks): a
            // start date at capture is a clarify decision, so a task
            // created with a start date and no explicit status enters
            // as Next rather than Inbox.
            const status = resolveCaptureStatusForStart(props, parsedStatus || 'inbox');
            const tags = Array.isArray(props.tags) ? props.tags : [];
            const contexts = Array.isArray(props.contexts) ? props.contexts : [];
            const {
                id: _id,
                title: _title,
                createdAt: _createdAt,
                updatedAt: _updatedAt,
                status: _status,
                tags: _tags,
                contexts: _contexts,
                ...restProps
            } = props;
            // Mirrors core's addTasks: an explicit order/orderNum in props wins, otherwise a
            // task landing in a project reserves the next slot instead of sorting below every
            // sibling (missing order is +Infinity in compareTasksByProjectOrder).
            const hasExplicitOrder = Object.prototype.hasOwnProperty.call(props, 'order')
                || Object.prototype.hasOwnProperty.call(props, 'orderNum');
            const task: Task = {
                id: generateUUID(),
                title,
                ...restProps,
                status,
                tags,
                contexts,
                rev: 1,
                revBy: CLOUD_API_REV_BY,
                createdAt: nowIso,
                updatedAt: nowIso,
            } as Task;
            if (!hasExplicitOrder && task.projectId) {
                const order = getNextProjectOrder(task.projectId, data.tasks);
                task.order = order;
                task.orderNum = order;
            }
            if (isTaskFinished(status) && !task.completedAt) {
                task.completedAt = nowIso;
            }
            return task;
        },
        patchEntity: (bodyRecord, existing: Task, data, nowIso): Task | Response => {
            const validatedPatch = validateEntityProps('task', 'patch', bodyRecord);
            if (!validatedPatch.ok) {
                return errorResponse(validatedPatch.error, 400);
            }
            const updates = validatedPatch.props;
            if (typeof updates.title === 'string' && updates.title.length > MAX_TASK_TITLE_LENGTH) {
                return errorResponse(`Task title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
            }
            const rawStatus = updates.status;
            if (rawStatus !== undefined && asStatus(rawStatus) === null) {
                return errorResponse('Invalid task status', 400);
            }
            // Applies the same store invariants the apps get (inbox
            // start-date promotion, star/status promotion+demotion,
            // boardOrder/focusOrder clearing) before the shared core
            // completion/recurrence logic in applyTaskUpdates runs, so
            // REST writes obey the same rules as the desktop/mobile store.
            const normalizedUpdates = normalizeTaskUpdate(existing, updates);
            const { updatedTask, nextRecurringTask } = applyTaskUpdates(
                existing,
                {
                    ...normalizedUpdates,
                    rev: normalizeRevision(existing.rev) + 1,
                    revBy: CLOUD_API_REV_BY,
                },
                nowIso,
            );
            if (nextRecurringTask) data.tasks.push(stampRecurringFollowUp(nextRecurringTask, existing, data.tasks));
            return updatedTask;
        },
    },
    {
        path: '/v1/projects',
        collectionKey: 'projects',
        itemKey: 'project',
        listKey: 'projects',
        label: 'Project',
        invalidIdMessage: 'Invalid project id',
        listItems: (data, url) => (
            url.searchParams.get('deleted') === '1' ? data.projects : filterNotDeleted(data.projects)
        ),
        createEntity: (bodyRecord, data, nowIso): Project | Response => {
            const rawProps = isRecord(bodyRecord.props) ? bodyRecord.props : {};
            const validatedProps = validateEntityProps('project', 'create', rawProps);
            if (!validatedProps.ok) return errorResponse(validatedProps.error, 400);
            const title = typeof bodyRecord.title === 'string' ? bodyRecord.title.trim() : '';
            if (!title) return errorResponse('Missing project title');
            if (title.length > MAX_TASK_TITLE_LENGTH) {
                return errorResponse(`Project title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
            }
            const props = validatedProps.props as Record<string, unknown>;
            if (props.areaId !== undefined && typeof props.areaId !== 'string') return errorResponse('Invalid area id', 400);
            const areaId = typeof props.areaId === 'string' ? props.areaId.trim() : '';
            if (areaId && !data.areas.some((area) => area.id === areaId && !area.deletedAt)) {
                return errorResponse('Area not found', 404);
            }
            const rawStatus = props.status;
            const status = rawStatus === undefined ? 'active' : asProjectStatus(rawStatus);
            if (!status) return errorResponse('Invalid project status', 400);
            const rawOrder = props.order;
            const rawTagIds = props.tagIds;
            const {
                status: _status,
                color: rawColor,
                order: _order,
                tagIds: _tagIds,
                areaId: _areaId,
                ...restProps
            } = props;
            return {
                id: generateUUID(),
                title,
                ...restProps,
                areaId: areaId || undefined,
                status,
                color: typeof rawColor === 'string' && rawColor.trim() ? rawColor : '#6B7280',
                order: typeof rawOrder === 'number' && Number.isFinite(rawOrder) ? rawOrder : nextOrder(data.projects),
                tagIds: Array.isArray(rawTagIds) ? rawTagIds.filter((item): item is string => typeof item === 'string') : [],
                createdAt: nowIso,
                updatedAt: nowIso,
                rev: 1,
                revBy: CLOUD_API_REV_BY,
            };
        },
        canPatchDeletedEntity: isProjectPurgePatch,
        patchEntity: (bodyRecord, existing: Project, data, nowIso): Project | Response => {
            const validatedPatch = validateEntityProps('project', 'patch', bodyRecord);
            if (!validatedPatch.ok) return errorResponse(validatedPatch.error, 400);
            const updates = validatedPatch.props;
            const purgingProject = isProjectPurgePatch(bodyRecord);
            if (typeof updates.title === 'string' && !updates.title.trim()) return errorResponse('Missing project title');
            if (typeof updates.title === 'string' && updates.title.length > MAX_TASK_TITLE_LENGTH) {
                return errorResponse(`Project title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
            }
            if (updates.status !== undefined && !asProjectStatus(updates.status)) return errorResponse('Invalid project status', 400);
            if (updates.areaId !== undefined && updates.areaId !== null && typeof updates.areaId !== 'string') {
                return errorResponse('Invalid area id', 400);
            }
            if (typeof updates.areaId === 'string' && updates.areaId.trim() === '') return errorResponse('Invalid area id', 400);
            const areaId = updates.areaId === null
                ? null
                : typeof updates.areaId === 'string'
                    ? updates.areaId.trim()
                    : undefined;
            if (areaId && !data.areas.some((area) => area.id === areaId && !area.deletedAt)) {
                return errorResponse('Area not found', 404);
            }
            const updatedProject = {
                ...existing,
                ...updates,
                title: typeof updates.title === 'string' ? updates.title.trim() : existing.title,
                areaId: areaId !== undefined ? areaId ?? undefined : existing.areaId,
                updatedAt: nowIso,
                rev: normalizeRevision(existing.rev) + 1,
                revBy: CLOUD_API_REV_BY,
            };
            if (!purgingProject) return updatedProject;

            const pendingDeletes = collectPendingRemoteDeletesForProjectPurge(updatedProject, data);
            data.settings = appendPendingRemoteAttachmentDeletes(data.settings, pendingDeletes);
            const purgedAt = updates.purgedAt as string;
            data.sections = data.sections.map((section) => (
                section.projectId === updatedProject.id
                    ? compactPurgedProjectSectionTombstone({
                        ...section,
                        rev: normalizeRevision(section.rev) + 1,
                        revBy: CLOUD_API_REV_BY,
                    }, purgedAt)
                    : section
            ));
            return compactPurgedProjectTombstone({
                ...updatedProject,
                deletedAt: typeof updatedProject.deletedAt === 'string' ? updatedProject.deletedAt : nowIso,
                purgedAt,
            });
        },
    },
    {
        path: '/v1/sections',
        collectionKey: 'sections',
        itemKey: 'section',
        listKey: 'sections',
        label: 'Section',
        invalidIdMessage: 'Invalid section id',
        listItems: (data, url) => {
            let sections = url.searchParams.get('deleted') === '1' ? data.sections : filterNotDeleted(data.sections);
            const projectId = url.searchParams.get('projectId');
            if (projectId) sections = sections.filter((section) => section.projectId === projectId);
            return sections;
        },
        createEntity: (bodyRecord, data, nowIso): Section | Response => {
            const rawProps = isRecord(bodyRecord.props) ? bodyRecord.props : {};
            const validatedProps = validateEntityProps('section', 'create', rawProps);
            if (!validatedProps.ok) return errorResponse(validatedProps.error, 400);
            const title = typeof bodyRecord.title === 'string' ? bodyRecord.title.trim() : '';
            const projectId = typeof bodyRecord.projectId === 'string' ? bodyRecord.projectId.trim() : '';
            if (!title) return errorResponse('Missing section title');
            if (title.length > MAX_TASK_TITLE_LENGTH) {
                return errorResponse(`Section title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
            }
            if (!projectId) return errorResponse('Missing project id');
            if (!data.projects.some((project) => project.id === projectId && !project.deletedAt)) {
                return errorResponse('Project not found', 404);
            }
            const props = validatedProps.props as Record<string, unknown>;
            const rawOrder = props.order;
            const { order: _order, ...restProps } = props;
            return {
                id: generateUUID(),
                projectId,
                title,
                ...restProps,
                order: typeof rawOrder === 'number' && Number.isFinite(rawOrder)
                    ? rawOrder
                    : nextOrder(data.sections.filter((item) => item.projectId === projectId)),
                createdAt: nowIso,
                updatedAt: nowIso,
                rev: 1,
                revBy: CLOUD_API_REV_BY,
            };
        },
        patchEntity: (bodyRecord, existing: Section, data, nowIso): Section | Response => {
            const validatedPatch = validateEntityProps('section', 'patch', bodyRecord);
            if (!validatedPatch.ok) return errorResponse(validatedPatch.error, 400);
            const updates = validatedPatch.props;
            if (typeof updates.title === 'string' && !updates.title.trim()) return errorResponse('Missing section title');
            if (typeof updates.title === 'string' && updates.title.length > MAX_TASK_TITLE_LENGTH) {
                return errorResponse(`Section title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
            }
            if (updates.projectId !== undefined && typeof updates.projectId !== 'string') {
                return errorResponse('Invalid project id', 400);
            }
            const projectId = typeof updates.projectId === 'string' ? updates.projectId.trim() : existing.projectId;
            if (!projectId) return errorResponse('Missing project id');
            if (!data.projects.some((project) => project.id === projectId && !project.deletedAt)) {
                return errorResponse('Project not found', 404);
            }
            return {
                ...existing,
                ...updates,
                projectId,
                title: typeof updates.title === 'string' ? updates.title.trim() : existing.title,
                updatedAt: nowIso,
                rev: normalizeRevision(existing.rev) + 1,
                revBy: CLOUD_API_REV_BY,
            };
        },
    },
    {
        path: '/v1/areas',
        collectionKey: 'areas',
        itemKey: 'area',
        listKey: 'areas',
        label: 'Area',
        invalidIdMessage: 'Invalid area id',
        listItems: (data, url) => (
            url.searchParams.get('deleted') === '1' ? data.areas : filterNotDeleted(data.areas)
        ),
        createEntity: (bodyRecord, data, nowIso): Area | Response => {
            const rawProps = isRecord(bodyRecord.props) ? bodyRecord.props : {};
            const validatedProps = validateEntityProps('area', 'create', rawProps);
            if (!validatedProps.ok) return errorResponse(validatedProps.error, 400);
            const name = typeof bodyRecord.name === 'string' ? bodyRecord.name.trim() : '';
            if (!name) return errorResponse('Missing area name');
            if (name.length > MAX_AREA_NAME_LENGTH) {
                return errorResponse(`Area name too long (max ${MAX_AREA_NAME_LENGTH} characters)`, 400);
            }
            const props = validatedProps.props as Record<string, unknown>;
            const rawOrder = props.order;
            const { order: _order, ...restProps } = props;
            return {
                id: generateUUID(),
                name,
                ...restProps,
                order: typeof rawOrder === 'number' && Number.isFinite(rawOrder) ? rawOrder : nextOrder(data.areas),
                createdAt: nowIso,
                updatedAt: nowIso,
                rev: 1,
                revBy: CLOUD_API_REV_BY,
            };
        },
        patchEntity: (bodyRecord, existing: Area, _data, nowIso): Area | Response => {
            const validatedPatch = validateEntityProps('area', 'patch', bodyRecord);
            if (!validatedPatch.ok) return errorResponse(validatedPatch.error, 400);
            const updates = validatedPatch.props;
            if (typeof updates.name === 'string' && !updates.name.trim()) return errorResponse('Missing area name');
            if (typeof updates.name === 'string' && updates.name.length > MAX_AREA_NAME_LENGTH) {
                return errorResponse(`Area name too long (max ${MAX_AREA_NAME_LENGTH} characters)`, 400);
            }
            return {
                ...existing,
                ...updates,
                name: typeof updates.name === 'string' ? updates.name.trim() : existing.name,
                updatedAt: nowIso,
                rev: normalizeRevision(existing.rev) + 1,
                revBy: CLOUD_API_REV_BY,
            };
        },
    },
];

const describeCalendarFeed = (record: CalendarFeedRecord | null) => (
    record
        ? { createdAt: record.createdAt, path: `${CALENDAR_FEED_PATH_PREFIX}${record.token}.ics`, token: record.token }
        : null
);

export function resolveServerMergeTimestamp(..._dataSets: AppData[]): string {
    return new Date().toISOString();
}

function isProjectPurgePatch(bodyRecord: Record<string, unknown>): boolean {
    return typeof bodyRecord.purgedAt === 'string' && bodyRecord.purgedAt.trim().length > 0;
}

type CloudServerOptions = {
    port?: number;
    host?: string;
    dataDir?: string;
    windowMs?: number;
    maxPerWindow?: number;
    maxAttachmentPerWindow?: number;
    maxBodyBytes?: number;
    maxAttachmentBytes?: number;
    requestTimeoutMs?: number;
    allowedAuthTokens?: AllowedAuthTokenInput;
    trustProxyHeaders?: boolean;
    trustedProxyIps?: Set<string> | null;
    maxAnyTokenNamespaces?: number;
    logAllRequests?: boolean;
    slowRequestMs?: number;
    requestCompletionSink?: (record: CloudRequestCompletion) => void;
    attachmentPathResolver?: typeof resolveAttachmentPath;
};

type CloudServerHandle = {
    stop: () => void;
    port: number;
};

class CloudStorageUnavailableError extends Error {}

export async function startCloudServer(options: CloudServerOptions = {}): Promise<CloudServerHandle> {
    const flags = parseArgs(process.argv.slice(2));
    const runtimeConfig = resolveCloudRuntimeConfig(process.env, {
        port: options.port ?? flags.port,
        rateWindowMs: options.windowMs,
        rateMax: options.maxPerWindow,
        attachmentRateMax: options.maxAttachmentPerWindow,
        maxBodyBytes: options.maxBodyBytes,
        maxAttachmentBytes: options.maxAttachmentBytes,
        anyTokenMaxNamespaces: options.maxAnyTokenNamespaces,
        requestTimeoutMs: options.requestTimeoutMs,
        slowRequestMs: options.slowRequestMs,
    });
    const port = runtimeConfig.port;
    const host = String(options.host ?? flags.host ?? process.env.HOST ?? '0.0.0.0');
    const dataDir = String(options.dataDir ?? process.env.MINDWTR_CLOUD_DATA_DIR ?? join(process.cwd(), 'data'));
    const attachmentPathResolver = options.attachmentPathResolver ?? resolveAttachmentPath;

    const windowMs = runtimeConfig.rateWindowMs;
    const maxPerWindow = runtimeConfig.rateMax;
    const maxAttachmentPerWindow = runtimeConfig.attachmentRateMax;
    const maxBodyBytes = runtimeConfig.maxBodyBytes;
    const maxAttachmentBytes = runtimeConfig.maxAttachmentBytes;
    const allowedAuthTokens = normalizeAllowedAuthTokens(
        options.allowedAuthTokens === undefined
            ? resolveAllowedAuthTokensFromEnv(process.env)
            : options.allowedAuthTokens
    );
    const trustProxyHeaders = options.trustProxyHeaders ?? parseBoolEnv(process.env.MINDWTR_CLOUD_TRUST_PROXY_HEADERS);
    const trustedProxyIps = options.trustedProxyIps ?? parseTrustedProxyIps(process.env.MINDWTR_CLOUD_TRUSTED_PROXY_IPS);
    const maxAnyTokenNamespaces = runtimeConfig.anyTokenMaxNamespaces;
    let assertStorageRoot: () => void = () => undefined;
    const withWriteLock = createWriteLockRunner(dataDir, () => assertStorageRoot());
    const rateLimitCleanupMs = runtimeConfig.rateCleanupMs;
    const requestTimeoutMs = runtimeConfig.requestTimeoutMs;
    const logAllRequests = options.logAllRequests
        ?? parseBoolEnv(process.env.MINDWTR_CLOUD_LOG_ALL_REQUESTS);
    const slowRequestMs = runtimeConfig.slowRequestMs;
    const requestCompletionSink = options.requestCompletionSink ?? ((record: CloudRequestCompletion) => {
        const context = { ...record };
        if (record.status >= 400 || record.elapsedMs >= slowRequestMs) {
            logWarn('request completed', context);
        } else {
            logInfo('request completed', context);
        }
    });
    const rateLimiter = createRateLimiter({ windowMs, maxKeys: runtimeConfig.rateMaxKeys });

    const getRequestIpAddress = (req: Request): string | null => {
        const bunServer = server as { requestIP?: (request: Request) => { address?: string | null } | null };
        if (typeof bunServer.requestIP !== 'function') return null;
        return bunServer.requestIP(req)?.address ?? null;
    };

    const unauthorizedResponse = (req: Request, token?: string | null): Response => {
        const authRateKey = getAuthFailureRateKey(req, {
            trustProxyHeaders,
            trustedProxyIps,
            requestIpAddress: getRequestIpAddress(req),
        });
        const authRateLimitKeys = [
            authRateKey,
            getAuthFailureTokenRateKey({
                token,
                authHeader: req.headers.get('authorization'),
            }),
        ].filter((key): key is string => Boolean(key));
        for (const key of authRateLimitKeys) {
            const authRateLimitResponse = rateLimiter.check(key, runtimeConfig.authFailureRateMax);
            if (authRateLimitResponse) {
                return authRateLimitResponse;
            }
        }
        return errorResponse('Unauthorized', 401);
    };

    const baseServerConfig: ServerConfig = {
        allowedAuthTokens,
        dataDir,
        maxAnyTokenNamespaces,
        rateLimiter,
        maxPerWindow,
        unauthorizedResponse,
        initializeNamespace: (filePath) => {
            if (!existsSync(filePath)) {
                writeCloudData(filePath, createEmptyCloudData(), { assertStorageRoot });
            }
        },
        runWithNamespaceAdmission: (handler, signal) => (
            withWriteLock(NAMESPACE_ADMISSION_LOCK_KEY, handler, signal)
        ),
    };
    // GET creates the initial empty document when the token has no namespace, so
    // it needs the same atomic admission section as PUT. Existing namespaces skip
    // the global admission lock in withNamespace.
    const dataServerConfig: ServerConfig = {
        ...baseServerConfig,
        guardMethods: (method) => method === 'PUT' || method === 'GET',
    };
    const calendarFeedServerConfig: ServerConfig = {
        ...baseServerConfig,
        // Feed rotation is valid only after a real sync document exists. It
        // checks quota under admission but must not reserve an empty namespace.
        initializeNamespace: () => undefined,
    };
    const attachmentServerConfig: ServerConfig = { ...baseServerConfig, maxPerWindow: maxAttachmentPerWindow };
    // /v1/attachments/orphans previously checked "is this POST or DELETE" *before*
    // ever consulting the namespace guard, so an unsupported method (e.g. PATCH)
    // fell straight through to 405 regardless of cap state; only guard POST/DELETE
    // here so that stays true and the guard-response fix stays scoped to the two
    // write methods this route actually supports.
    const orphansServerConfig: ServerConfig = {
        ...attachmentServerConfig,
        guardMethods: (method) => method === 'POST' || method === 'DELETE',
        initializeNamespace: () => undefined,
    };
    // /v1/attachments/:path only ever guarded PUT (the only method that can create a
    // new file). DELETE was never guarded pre-refactor; kept that way here rather
    // than folding it into the default non-GET guard, since extending the cap to
    // DELETE is a real behavior change this task did not ask for and isn't flagged
    // as one of the routes with a missing-guard bug.
    const attachmentPathServerConfig: ServerConfig = { ...attachmentServerConfig, guardMethods: (method) => method === 'PUT' };

    const cleanupTimer = setInterval(() => {
        rateLimiter.prune(Date.now());
    }, rateLimitCleanupMs);
    if (typeof cleanupTimer.unref === 'function') {
        cleanupTimer.unref();
    }

    const usingLegacyTokenVar = options.allowedAuthTokens === undefined
        && !String(process.env.MINDWTR_CLOUD_AUTH_TOKENS || '').trim()
        && !String(process.env.MINDWTR_CLOUD_AUTH_TOKENS_FILE || '').trim()
        && (
            String(process.env.MINDWTR_CLOUD_TOKEN || '').trim().length > 0
            || String(process.env.MINDWTR_CLOUD_TOKEN_FILE || '').trim().length > 0
        );
    if (usingLegacyTokenVar) {
        logWarn('MINDWTR_CLOUD_TOKEN is deprecated; use MINDWTR_CLOUD_AUTH_TOKENS instead');
    }
    if (allowedAuthTokens) {
        logInfo('token auth allowlist enabled', { allowedTokens: String(allowedAuthTokens.size) });
    } else {
        logInfo('token namespace mode enabled by explicit opt-in', {
            hint: 'set MINDWTR_CLOUD_AUTH_TOKENS to enforce a strict token allowlist',
            maxNamespaces: String(maxAnyTokenNamespaces),
        });
    }
    if (trustProxyHeaders) {
        if (trustedProxyIps.size > 0) {
            logWarn('trusting proxy IP headers for auth failure rate limiting', {
                trustedProxyIps: String(trustedProxyIps.size),
                hint: 'only requests from MINDWTR_CLOUD_TRUSTED_PROXY_IPS can supply forwarded client IP headers',
            });
        } else {
            logWarn('MINDWTR_CLOUD_TRUST_PROXY_HEADERS is enabled but no trusted proxy IPs are configured; forwarded IP headers will be ignored', {
                hint: 'set MINDWTR_CLOUD_TRUSTED_PROXY_IPS to the exact reverse-proxy source IPs',
            });
        }
    }
    if (!ensureWritableDir(dataDir)) {
        throw new Error('Cloud data directory is not writable');
    }
    const initialDataDirRealPath = realpathSync(dataDir);
    const initialDataDirStat = statSync(initialDataDirRealPath);
    const isOriginalDataDirectory = (): boolean => {
        try {
            const currentRealPath = realpathSync(dataDir);
            const currentStat = statSync(currentRealPath);
            return currentStat.isDirectory()
                && currentRealPath === initialDataDirRealPath
                && currentStat.dev === initialDataDirStat.dev
                && currentStat.ino === initialDataDirStat.ino
                // ext4 hands the freed inode straight back to the next directory
                // created, so a data dir removed and recreated between checks can
                // return with the original dev+ino. The birth timestamp only
                // survives on the original directory; skip it on filesystems
                // that do not report one.
                && (initialDataDirStat.birthtimeMs <= 0
                    || currentStat.birthtimeMs === initialDataDirStat.birthtimeMs);
        } catch {
            return false;
        }
    };
    assertStorageRoot = () => {
        if (!isOriginalDataDirectory()) {
            throw new CloudStorageUnavailableError('Cloud storage is unavailable');
        }
    };
    logInfo('cloud data directory ready');
    if (allowedAuthTokens) {
        const { pruned: prunedFeedCount, failed: failedFeedCount } = pruneOrphanedCalendarFeeds(
            dataDir,
            allowedAuthTokens.keys
        );
        if (prunedFeedCount > 0) {
            // Count only, no paths - the namespace key is a token digest (#952's
            // privacy ratchet already treats it as sensitive elsewhere).
            logInfo('pruned orphaned calendar feed sidecars', { count: String(prunedFeedCount) });
        }
        if (failedFeedCount > 0) {
            logWarn('failed to prune some orphaned calendar feed sidecars', { count: String(failedFeedCount) });
        }
    }
    logInfo('cloud server listening', { port: String(port) });

    const bunRuntime = getBunRuntime();
    if (!bunRuntime) {
        throw new Error('Mindwtr Cloud requires the Bun runtime.');
    }

    const server = bunRuntime.serve({
        hostname: host,
        port,
        async fetch(req: Request) {
            const requestId = generateRequestId();
            const requestStartedAt = performance.now();
            let requestRoute = 'unmatched';
            const requestAbortController = new AbortController();
            const withRequestWriteLock = Object.assign(
                <T>(key: string, handler: () => Promise<T>) => (
                    withWriteLock(key, handler, requestAbortController.signal)
                ),
                { getPendingLockCount: withWriteLock.getPendingLockCount },
            );
            const requestTimeout = setTimeout(() => {
                requestAbortController.abort(createRequestAbortError('Request timed out', 408));
            }, requestTimeoutMs);
            try {
                const response = await (async (): Promise<Response> => {
                    try {
                        throwIfRequestAborted(requestAbortController.signal);

                        const url = new URL(req.url);
                        const pathname = normalizeRequestPathname(url);
                        requestRoute = canonicalCloudRoute(pathname);

                        if (req.method === 'OPTIONS') return preflightResponse();

                if (req.method === 'GET' && pathname === '/health') {
                    return jsonResponse({ ok: true });
                }

                if (req.method === 'GET' && pathname === '/ready') {
                    const ready = isOriginalDataDirectory()
                        && probeExistingWritableDir(dataDir)
                        && isOriginalDataDirectory();
                    return jsonResponse({ ok: ready }, ready ? {} : { status: 503 });
                }

                // Every route below can read or mutate the configured storage
                // tree. Refuse the request before auth, admission, lock, or path
                // helpers can observe a missing or same-path replacement root.
                if (!isOriginalDataDirectory()) {
                    return errorResponse('Cloud storage unavailable', 503);
                }

                if (
                    pathname === '/v1/tasks'
                    || pathname === '/v1/projects'
                    || pathname === '/v1/sections'
                    || pathname === '/v1/areas'
                    || pathname === '/v1/search'
                    || pathname.startsWith('/v1/tasks/')
                    || pathname.startsWith('/v1/projects/')
                    || pathname.startsWith('/v1/sections/')
                    || pathname.startsWith('/v1/areas/')
                ) {
                    const groupResponse = await withNamespace(req, url, baseServerConfig, async (ctx) => {
                        const actionMatch = pathname.match(/^\/v1\/tasks\/([^/]+)\/(complete|archive)$/);
                        if (actionMatch && req.method === 'POST') {
                            const taskId = parseTaskRouteId(actionMatch[1]);
                            if (!taskId) return errorResponse('Invalid task id', 400);
                            const action = actionMatch[2];
                            const status: TaskStatus = action === 'archive' ? 'archived' : 'done';

                            return await withRequestWriteLock(ctx.key, async () => {
                                throwIfRequestAborted(requestAbortController.signal);
                                const dataResult = loadAppDataOrError(ctx.filePath);
                                if ('error' in dataResult) return dataResult.error;
                                const data = dataResult;
                                const idx = data.tasks.findIndex((t) => t.id === taskId && !t.deletedAt);
                                if (idx < 0) return errorResponse('Task not found', 404);

                                const nowIso = new Date().toISOString();
                                const existing = data.tasks[idx];
                                const { updatedTask, nextRecurringTask } = applyTaskUpdates(
                                    existing,
                                    {
                                        status,
                                        rev: normalizeRevision(existing.rev) + 1,
                                        revBy: CLOUD_API_REV_BY,
                                    },
                                    nowIso,
                                );
                                data.tasks[idx] = updatedTask;
                                if (nextRecurringTask) data.tasks.push(stampRecurringFollowUp(nextRecurringTask, existing, data.tasks));
                                const finalized = finalizeCloudDataForWrite(data, nowIso, FINALIZE_REJECT_INVALID_REST_WRITE);
                                if ('error' in finalized) return finalized.error;
                                const finalizedTask = finalized.tasks.find((item) => item.id === updatedTask.id) || updatedTask;
                                throwIfRequestAborted(requestAbortController.signal);
                                writeCloudData(ctx.filePath, finalized, { assertStorageRoot });
                                return jsonResponse({ task: finalizedTask });
                            });
                        }

                        for (const entityRoute of ENTITY_ROUTES) {
                            const entityRouteResponse = await handleEntityRoute(entityRoute, req, pathname, url, {
                                assertStorageRoot,
                                key: ctx.key,
                                filePath: ctx.filePath,
                                maxBodyBytes,
                                signal: requestAbortController.signal,
                                withWriteLock: withRequestWriteLock,
                            });
                            if (entityRouteResponse) return entityRouteResponse;
                        }

                        if (req.method === 'GET' && pathname === '/v1/search') {
                            throwIfRequestAborted(requestAbortController.signal);
                            const query = url.searchParams.get('query') || '';
                            const pagination = parsePagination(url.searchParams);
                            if ('error' in pagination) return errorResponse(pagination.error, 400);
                            const taskOffset = parseSearchPaginationValue(url.searchParams, 'taskOffset', pagination.offset);
                            if (typeof taskOffset !== 'number') return errorResponse(taskOffset.error, 400);
                            const projectOffset = parseSearchPaginationValue(url.searchParams, 'projectOffset', pagination.offset);
                            if (typeof projectOffset !== 'number') return errorResponse(projectOffset.error, 400);
                            const taskLimit = parseSearchPaginationValue(url.searchParams, 'taskLimit', pagination.limit);
                            if (typeof taskLimit !== 'number') return errorResponse(taskLimit.error, 400);
                            const projectLimit = parseSearchPaginationValue(url.searchParams, 'projectLimit', pagination.limit);
                            if (typeof projectLimit !== 'number') return errorResponse(projectLimit.error, 400);
                            const dataResult = loadAppDataOrError(ctx.filePath);
                            if ('error' in dataResult) return dataResult.error;
                            const data = dataResult;
                            const tasks = filterNotDeleted(data.tasks);
                            const projects = filterNotDeleted(data.projects);
                            // filterTasksBySearch/filterProjectsBySearch are the same matchers
                            // searchAll() composes, called directly here (rather than through
                            // searchAll) because searchAll internally slices its result to
                            // core's SEARCH_RESULT_LIMIT (200) before returning — computing
                            // taskTotal/projectTotal from that sliced array reported at most
                            // 200 even when there were more true matches, and made
                            // taskOffset/projectOffset past 200 always return empty. This
                            // endpoint does its own offset/limit slicing below (bounded by
                            // LIST_MAX_LIMIT), so it doesn't need searchAll's fixed 200 cap.
                            const matchedTasks = filterTasksBySearch(tasks, projects, query);
                            const matchedProjects = filterProjectsBySearch(projects, query);
                            const taskTotal = matchedTasks.length;
                            const projectTotal = matchedProjects.length;
                            return jsonResponse({
                                tasks: matchedTasks.slice(taskOffset, taskOffset + taskLimit),
                                projects: matchedProjects.slice(projectOffset, projectOffset + projectLimit),
                                taskTotal,
                                projectTotal,
                                limit: pagination.limit,
                                offset: pagination.offset,
                                taskLimit,
                                taskOffset,
                                projectLimit,
                                projectOffset,
                            });
                        }

                        return errorResponse('Method not allowed', 405);
                    }, requestAbortController.signal);
                    if (groupResponse) return groupResponse;
                }

                if (pathname === '/v1/data') {
                    const dataResponse = await withNamespace(req, url, dataServerConfig, async (ctx) => {
                    const key = ctx.key;
                    const filePath = ctx.filePath;

                    if (req.method === 'HEAD') {
                        return await withRequestWriteLock(key, async () => {
                            throwIfRequestAborted(requestAbortController.signal);
                            if (!existsSync(filePath)) return emptyCorsResponse(404);
                            return dataMetadataResponse(filePath);
                        });
                    }

                    if (req.method === 'GET') {
                        return await withRequestWriteLock(key, async () => {
                            throwIfRequestAborted(requestAbortController.signal);
                            if (!existsSync(filePath)) {
                                const emptyData = createEmptyCloudData();
                                throwIfRequestAborted(requestAbortController.signal);
                                if (!existsSync(filePath)) {
                                    writeCloudData(filePath, emptyData, { assertStorageRoot });
                                }
                                return jsonResponse(emptyData);
                            }
                            let rawData: Uint8Array;
                            try {
                                rawData = readFileSync(filePath);
                            } catch {
                                return errorResponse('Failed to read data', 500);
                            }
                            if (isTrustedValidatedDataFile(filePath)) {
                                return jsonFileResponse(rawData);
                            }
                            let data: unknown;
                            try {
                                const rawText = new TextDecoder('utf-8', { fatal: true }).decode(rawData);
                                data = JSON.parse(rawText);
                            } catch {
                                return errorResponse('Failed to read data', 500);
                            }
                            const validated = validateStoredAppData(filePath, data);
                            if ('error' in validated) return validated.error;
                            return jsonFileResponse(rawData);
                        });
                    }

                    if (req.method === 'PUT') {
                        // Namespace admission has already reserved a valid empty
                        // document, so body streaming and validation never hold the
                        // global admission lock.
                        const body = await readJsonBody(req, maxBodyBytes, requestAbortController.signal);
                        if (isBodyReadError(body)) {
                            const err = body.__mindwtrError;
                            return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                        }
                        if (!body) return errorResponse('Missing body');
                        if (typeof body !== 'object') return errorResponse('Invalid JSON body');
                        const validated = validateAppData(body);
                        if (!validated.ok) return errorResponse(validated.error, 400);
                        return await withRequestWriteLock(key, async () => {
                            let publication: PreparedFilePublication | null = null;
                            try {
                                throwIfRequestAborted(requestAbortController.signal);
                                assertStorageRoot();
                                publication = prepareFilePublicationSafely(
                                    initialDataDirRealPath,
                                    join(initialDataDirRealPath, basename(filePath)),
                                    'data',
                                );
                                assertStorageRoot();
                                if (!publication) {
                                    throw new Error('Cloud data file publication is unsafe');
                                }

                                const existingDataResult = loadExistingDataForMerge(filePath);
                                if ('error' in existingDataResult) return existingDataResult.error;
                                const existingData = existingDataResult;
                                const incomingData = validated.data;
                                const mergeTimestamp = resolveServerMergeTimestamp(existingData, incomingData);
                                const mergeResult = mergeAppDataWithStats(existingData, incomingData, {
                                    nowIso: mergeTimestamp,
                                });
                                throwIfRequestAborted(requestAbortController.signal);
                                writeCloudData(filePath, mergeResult.data, {
                                    assertStorageRoot,
                                    publication,
                                });
                                assertStorageRoot();
                                const metadata = getDataFileMetadata(filePath);
                                assertStorageRoot();
                                const contentLength = String(metadata.size);
                                const remoteFingerprint = buildHttpRemoteFileFingerprint('cloud', {
                                    etag: metadata.etag,
                                    lastModified: metadata.lastModified,
                                    contentLength,
                                });
                                // Deliberate second merge: serverMergedRemoteData must be true
                                // whenever the SERVER's stored data contributed anything to the
                                // merged result — including settings-level and normalization-level
                                // contributions that per-entity MergeStats cannot express. Merging
                                // the incoming payload against an empty base yields the exact
                                // "client-only" normal form to compare against. Do not replace this
                                // with a stats-derived heuristic: a false negative makes clients
                                // skip a needed re-read and diverge silently.
                                const incomingOnlyMerge = mergeAppDataWithStats({
                                    tasks: [],
                                    projects: [],
                                    sections: [],
                                    areas: [],
                                    people: [],
                                    settings: {},
                                }, incomingData, { nowIso: mergeTimestamp });
                                const serverMergedRemoteData = !areSyncPayloadsEqual(mergeResult.data, incomingOnlyMerge.data);
                                return jsonResponse({
                                    ok: true,
                                    stats: mergeResult.stats,
                                    clockSkewWarning: mergeResult.clockSkewWarning ?? null,
                                    remoteFingerprint,
                                    etag: metadata.etag,
                                    lastModified: metadata.lastModified,
                                    contentLength,
                                    serverMergedRemoteData,
                                }, {
                                    headers: {
                                        ETag: metadata.etag,
                                        'Last-Modified': metadata.lastModified,
                                    },
                                });
                            } catch (error) {
                                assertStorageRoot();
                                throw error;
                            } finally {
                                if (publication) {
                                    abandonPreparedFilePublication(publication);
                                }
                            }
                        });
                    }

                    // Unmatched method (only HEAD/GET/PUT are handled): fall through to
                    // later routes exactly as before, instead of a route-specific 405.
                    return null;
                    }, requestAbortController.signal);
                    if (dataResponse) return dataResponse;
                }

                if (pathname === '/v1/calendar/feed') {
                    const feedResponse = await withNamespace(req, url, calendarFeedServerConfig, async (ctx) => {
                        if (req.method === 'GET') {
                            return jsonResponse({ feed: describeCalendarFeed(readCalendarFeed(dataDir, ctx.key)) });
                        }
                        if (req.method === 'POST') {
                            // A feed for a namespace that has never synced would publish
                            // nothing, and letting one be created would let unknown tokens
                            // plant sidecar files past the namespace cap.
                            if (!existsSync(ctx.filePath)) return errorResponse('No synced data to publish', 404);
                            return await withRequestWriteLock(ctx.key, async () => {
                                throwIfRequestAborted(requestAbortController.signal);
                                return jsonResponse(
                                    { feed: describeCalendarFeed(rotateCalendarFeed(dataDir, ctx.key, assertStorageRoot)) },
                                    { status: 201 },
                                );
                            });
                        }
                        if (req.method === 'DELETE') {
                            return await withRequestWriteLock(ctx.key, async () => {
                                throwIfRequestAborted(requestAbortController.signal);
                                revokeCalendarFeed(dataDir, ctx.key);
                                return jsonResponse({ feed: null });
                            });
                        }
                        return errorResponse('Method not allowed', 405);
                    }, requestAbortController.signal);
                    if (feedResponse) return feedResponse;
                }

                // The published feed authenticates with the token in its own URL, so it
                // never reaches withNamespace. An unknown token is a 404, not a 401: the
                // URL is the only credential, and 401 would invite an Authorization
                // header that this route does not read.
                const calendarFeedToken = parseCalendarFeedPathToken(pathname);
                if (calendarFeedToken) {
                    if (req.method !== 'GET') return errorResponse('Method not allowed', 405);
                    const feedClientRateKey = getAuthFailureRateKey(req, {
                        trustProxyHeaders,
                        trustedProxyIps,
                        requestIpAddress: getRequestIpAddress(req),
                    });
                    const feedClientRateLimitResponse = rateLimiter.check(
                        `ics-client:${feedClientRateKey}`,
                        maxPerWindow,
                    );
                    if (feedClientRateLimitResponse) return feedClientRateLimitResponse;

                    // Unknown tokens share only the stable client bucket above, so
                    // rotating token strings cannot allocate limiter keys while
                    // forcing namespace sidecar scans.
                    const feedNamespaceKey = findCalendarFeedNamespace(dataDir, calendarFeedToken);
                    // A namespace whose token left the allowlist gets the same 404 as an
                    // unknown feed token - revoking sync access must also stop the feed
                    // (R-03), not just the authenticated API. Any-token mode has no
                    // allowlist to fall out of, so every feed stays valid there, unchanged.
                    if (!feedNamespaceKey || (allowedAuthTokens && !allowedAuthTokens.keys.has(feedNamespaceKey))) {
                        return errorResponse('Not found', 404);
                    }
                    const feedRateLimitResponse = rateLimiter.check(
                        `ics:${tokenToKey(calendarFeedToken)}`,
                        maxPerWindow,
                    );
                    if (feedRateLimitResponse) return feedRateLimitResponse;
                    return calendarFeedResponse(dataDir, feedNamespaceKey);
                }

                if (pathname === '/v1/attachments/orphans') {
                    const orphansResponse = await withNamespace(req, url, orphansServerConfig, async (ctx) => {
                        if (req.method !== 'POST' && req.method !== 'DELETE') {
                            return errorResponse('Method not allowed', 405);
                        }

                        return await withRequestWriteLock(ctx.key, async () => {
                            throwIfRequestAborted(requestAbortController.signal);
                            return handleOrphanAttachmentGcRequest(dataDir, ctx.key, ctx.filePath);
                        });
                    }, requestAbortController.signal);
                    if (orphansResponse) return orphansResponse;
                }

                if (pathname.startsWith('/v1/attachments/')) {
                    const attachmentPathResponse = await withNamespace(req, url, attachmentPathServerConfig, async (ctx) => {
                        // Only PUT may create the namespace's attachment directory; GET and
                        // DELETE must never plant it (see resolveAttachmentPath's doc comment).
                        const resolvedAttachmentPath = attachmentPathResolver(dataDir, ctx.key, pathname.slice('/v1/attachments/'.length), { create: req.method === 'PUT' });
                        if (!isOriginalDataDirectory()) {
                            return errorResponse('Cloud storage unavailable', 503);
                        }
                        if (!resolvedAttachmentPath) {
                            return errorResponse('Invalid attachment path', 400);
                        }
                        return handleAttachmentPathRequest(req, pathname, resolvedAttachmentPath, {
                            maxAttachmentBytes,
                            abortSignal: requestAbortController.signal,
                            assertStorageRoot,
                        });
                    }, requestAbortController.signal);
                    if (attachmentPathResponse) return attachmentPathResponse;
                }

                        return errorResponse('Not found', 404);
                    } catch (error) {
                        if (error instanceof CloudStorageUnavailableError) {
                            return errorResponse('Cloud storage unavailable', 503);
                        }
                        if (isRequestAbortError(error)) {
                            return errorResponse(error.message, error.status);
                        }
                        const errorCode = error && typeof error === 'object' && 'code' in error
                            ? (error as { code?: unknown }).code
                            : undefined;
                        if (errorCode === 'EACCES') {
                            logError('request failed', {
                                failureClass: 'filesystem',
                                failureCode: 'permission_denied',
                                failureErrno: errorCode,
                                requestId,
                            });
                            return createInternalServerErrorResponse(
                                'Cloud data directory is not writable. Check volume permissions.',
                                requestId,
                            );
                        }
                        const isAttachmentFailure = requestRoute === '/v1/attachments/:path';
                        logError('request failed', {
                            failureClass: isAttachmentFailure || typeof errorCode === 'string'
                                ? 'filesystem'
                                : 'runtime',
                            failureCode: isAttachmentFailure ? 'attachment_io_failed' : 'request_failed',
                            failureErrno: typeof errorCode === 'string' ? errorCode : undefined,
                            requestId,
                        });
                        return createInternalServerErrorResponse('Internal server error', requestId);
                    }
                })();
                attachRequestId(response, requestId);
                const completion: CloudRequestCompletion = {
                    requestId,
                    method: req.method,
                    route: requestRoute,
                    status: response.status,
                    elapsedMs: Math.max(0, Math.round(performance.now() - requestStartedAt)),
                };
                if (shouldLogCloudRequest(completion, logAllRequests, slowRequestMs)) {
                    requestCompletionSink(completion);
                }
                return response;
            } finally {
                clearTimeout(requestTimeout);
            }
        },
    });

    let stopped = false;
    const stopServer = async () => {
        if (stopped) return;
        stopped = true;
        clearInterval(cleanupTimer);
        try {
            await Promise.resolve((server as { stop?: (closeIdleConnections?: boolean) => void | Promise<void> }).stop?.(true));
        } catch {
            // Ignore stop errors during teardown.
        }
    };
    const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
    if (IS_MAIN_MODULE) {
        const handleSignal = (signal: NodeJS.Signals) => {
            logInfo('shutdown signal received', { signal });
            void stopServer().finally(() => process.exit(0));
        };
        for (const signal of ['SIGINT', 'SIGTERM'] as NodeJS.Signals[]) {
            const handler = () => handleSignal(signal);
            signalHandlers.push([signal, handler]);
            process.once(signal, handler);
        }
    }

    return {
        port: server.port,
        stop: () => {
            for (const [signal, handler] of signalHandlers) {
                process.off(signal, handler);
            }
            void stopServer();
        },
    };
}

if (IS_MAIN_MODULE) {
    startCloudServer().catch(() => {
        logError('Failed to start server', {
            failureClass: 'runtime',
            failureCode: 'server_start_failed',
        });
        process.exit(1);
    });
}
