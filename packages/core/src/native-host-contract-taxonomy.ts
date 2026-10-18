import type { NativeHostResult } from './native-host-contract';
import { detach, exact, iso, record } from './native-host-contract-project-shared';
import { getManageDeleteConfirm, getManageEditorDraft, getManageEditorText,
    isManageEditorSaveDisabled, type ManageConfirm, type ManageEditorDraft,
    type ManageUntranslatedText } from './manage-settings-model';
import { readAreaDurableData, createAreaSaveGuard } from './native-host-contract-area-durable';
import { ensureDeviceId } from './store-helpers';
import { formatTagIdPreservingCase } from './store-projects/shared';
import { useTaskStore } from './store';
import { taskEditValuesEqual } from './json-value-equality';
import { TASK_SYNC_FIELD_SCHEMA, taskToSqliteRow } from './task-sync-schema';
import { PROJECT_SYNC_FIELD_SCHEMA, projectToSqliteRow } from './project-sync-schema';
import { planTaxonomyEffect, selectTaxonomyScope, taxonomyDestination,
    type TaxonomyKind, type TaxonomyScope } from './taxonomy-policy';
import type { PreparedTaxonomy } from './store-types';
import type { Project, Task } from './types';

export type NativeTaxonomyRequest = PreparedTaxonomy['request'];
export type NativeTaxonomyResult = PreparedTaxonomy['result'];
export type NativePreparedTaxonomy = PreparedTaxonomy & { version: 1 };
export type NativeTaxonomyOptions = { kind: TaxonomyKind; name: string; expected: TaxonomyScope;
    draft: ManageEditorDraft; text: ReturnType<typeof getManageEditorText>; confirmation: ManageConfirm };
export type NativeTaxonomyPreparation = { kind: 'noop'; result: NativeTaxonomyResult }
    | { kind: 'prepared'; prepared: NativePreparedTaxonomy };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const text = (value: unknown, max = 100_000): value is string => typeof value === 'string' && value.length <= max;
const id = (value: unknown): value is string => text(value, 500) && Boolean(value);
const stamp = (value: unknown): value is string => text(value, 500) && Boolean(value.trim());
const rev = (value: unknown) => value === undefined || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const optionalString = (value: unknown) => value === undefined || text(value);
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const stringArray = (value: unknown): value is string[] => Array.isArray(value)
    && value.every((part) => text(part));
const fields = (value: Record<string, unknown>, names: readonly string[]) =>
    Object.keys(value).every((name) => names.includes(name));
const attachmentKeys = ['id', 'kind', 'title', 'uri', 'mimeType', 'size', 'createdAt', 'updatedAt',
    'deletedAt', 'cloudKey', 'fileHash', 'contentRev', 'contentMtimeMs', 'contentSize',
    'pendingContentUpload', 'staleContentHash', 'localStatus'];
const attachments = (value: unknown) => Array.isArray(value) && value.every((item) => record(item)
    && fields(item, attachmentKeys) && id(item.id) && ['file', 'link'].includes(String(item.kind))
    && text(item.title) && text(item.uri) && stamp(item.createdAt) && stamp(item.updatedAt)
    && ['mimeType', 'deletedAt', 'cloudKey', 'fileHash'].every((field) => optionalString(item[field]))
    && ['size', 'contentRev', 'contentMtimeMs', 'contentSize'].every((field) => item[field] === undefined
        || typeof item[field] === 'number' && Number.isFinite(item[field]))
    && (item.pendingContentUpload === undefined || typeof item.pendingContentUpload === 'boolean')
    && (item.staleContentHash === undefined || typeof item.staleContentHash === 'string')
    && (item.localStatus === undefined || ['available', 'missing', 'uploading', 'downloading'].includes(String(item.localStatus))));
const taskKeys = TASK_SYNC_FIELD_SCHEMA.map((field) => field.name);
const projectKeys = PROJECT_SYNC_FIELD_SCHEMA.map((field) => field.name);

/** Full saved Task rows, including Trash and raw focus/archive metadata. */
const validTask = (value: unknown): value is Task => {
    if (!record(value) || !fields(value, taskKeys) || !id(value.id) || !text(value.title)
        || !['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(String(value.status))
        || !stringArray(value.tags) || !stringArray(value.contexts)
        || !stamp(value.createdAt) || !stamp(value.updatedAt) || !rev(value.rev)
        || !optionalString(value.revBy) || !optionalString(value.deletedAt) || !optionalString(value.purgedAt)) return false;
    for (const [name, part] of Object.entries(value)) {
        if (part === null) {
            if (!['completedAtBeforeProjectArchive', 'isFocusedTodayBeforeProjectArchive'].includes(name)) return false;
            continue;
        }
        if (name === 'relativeStartOffset') {
            if (!record(part) || !exact(part, ['amount', 'unit']) || typeof part.amount !== 'number'
                || !Number.isFinite(part.amount) || !['minute', 'hour', 'day', 'week'].includes(String(part.unit))) return false;
        } else if (name === 'viewSectionIds') {
            if (!record(part) || !Object.values(part).every((entry) => text(entry))) return false;
        } else if (name === 'recurrence') {
            if (typeof part !== 'string' && (!record(part) || !fields(part, ['rule', 'seriesId', 'strategy', 'byDay',
                'byMonthDay', 'weekStart', 'count', 'until', 'completedOccurrences', 'anchorDay',
                'startAnchorDay', 'dueAnchorDay', 'reviewAnchorDay', 'rrule'])
                || !['daily', 'weekly', 'monthly', 'yearly'].includes(String(part.rule))
                || Object.entries(part).some(([field, entry]) => field === 'byDay' ? !stringArray(entry)
                    : field === 'byMonthDay' ? !Array.isArray(entry) || !entry.every((item) => Number.isSafeInteger(item))
                    : ['count', 'completedOccurrences', 'anchorDay', 'startAnchorDay', 'dueAnchorDay', 'reviewAnchorDay'].includes(field)
                        ? !Number.isSafeInteger(entry) : !text(entry)))) return false;
        } else if (name === 'checklist') {
            if (!Array.isArray(part) || part.some((item) => !record(item)
                || !exact(item, ['id', 'title', 'isCompleted']) || !id(item.id)
                || !text(item.title) || typeof item.isCompleted !== 'boolean')) return false;
        } else if (name === 'attachments') {
            if (!attachments(part)) return false;
        } else {
            const kind = TASK_SYNC_FIELD_SCHEMA.find((field) => field.name === name)?.cloudKit?.kind;
            if ((kind === 'boolean' && typeof part !== 'boolean')
                || (kind === 'integer' && (typeof part !== 'number' || !Number.isFinite(part)))
                || ((kind === 'string' || kind === 'date') && !text(part))
                || (kind === 'string-array' && !stringArray(part))
                || (['boardOrder', 'order', 'orderNum', 'focusOrder'].includes(name)
                    && (typeof part !== 'number' || !Number.isFinite(part)))) return false;
        }
    }
    try { taskToSqliteRow(value as unknown as Task); return true; } catch { return false; }
};

const validProject = (value: unknown): value is Project => {
    if (!record(value) || !fields(value, projectKeys) || !id(value.id) || !text(value.title)
        || !['active', 'someday', 'waiting', 'archived'].includes(String(value.status))
        || !text(value.color) || typeof value.order !== 'number' || !Number.isFinite(value.order)
        || !stringArray(value.tagIds) || !stamp(value.createdAt) || !stamp(value.updatedAt)
        || !rev(value.rev) || !['revBy', 'deletedAt', 'purgedAt', 'supportNotes', 'dueDate', 'startDate',
            'reviewAt', 'cancelledAt', 'areaId', 'areaTitle', 'taskSortBy'].every((field) => optionalString(value[field]))
        || (value.attachments !== undefined && !attachments(value.attachments))
        || (value.isFocused !== undefined && typeof value.isFocused !== 'boolean')
        || (value.isSequential !== undefined && typeof value.isSequential !== 'boolean')
        || (value.sequentialScope !== undefined && !['project', 'section'].includes(String(value.sequentialScope)))
        || (value.viewSectionIds !== undefined && !(record(value.viewSectionIds)
            && Object.values(value.viewSectionIds).every((sectionId) => typeof sectionId === 'string')))) return false;
    try { projectToSqliteRow(value as unknown as Project); return true; } catch { return false; }
};

const validScope = (value: unknown, kind: TaxonomyKind, name: string): value is TaxonomyScope => {
    if (!record(value) || !exact(value, ['tasks', 'projects']) || !Array.isArray(value.tasks)
        || !Array.isArray(value.projects) || !value.tasks.every(validTask)
        || !value.projects.every(validProject)
        || new Set(value.tasks.map((row) => row.id)).size !== value.tasks.length
        || new Set(value.projects.map((row) => row.id)).size !== value.projects.length
        || kind === 'context' && value.projects.length !== 0) return false;
    const selected = selectTaxonomyScope(kind, name, value.tasks, value.projects);
    return value.tasks.length + value.projects.length > 0 && same(value, selected);
};

const readRequest = (value: unknown): NativeTaxonomyRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'kind', 'action', 'name', 'to', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || !['context', 'tag'].includes(String(input.kind))
        || !['rename', 'delete'].includes(String(input.action)) || !text(input.name, 10_000)
        || !input.name || taxonomyDestination(input.kind as TaxonomyKind, 'delete', input.name, null) === undefined
        || !(input.to === null || text(input.to, 10_000))
        || (input.action === 'delete' ? input.to !== null : input.to === null)
        || !validScope(input.expected, input.kind as TaxonomyKind, input.name)) return null;
    return input as NativeTaxonomyRequest;
};

/** Replan from the frozen request only, before a host opens SQLite on recovery. */
const readPrepared = (value: unknown): NativePreparedTaxonomy | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'result']) || raw.version !== 1
        || !same(raw.request, request) || !same(raw.scope, request.expected)
        || !(raw.deviceIdBefore === null || id(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null ? typeof raw.deviceIdToInitialize !== 'string'
            || !UUID.test(raw.deviceIdToInitialize) : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !record(raw.result)
        || !exact(raw.result, ['kind', 'action', 'name', 'to'])) return null;
    const prepared = raw as unknown as NativePreparedTaxonomy;
    const destination = taxonomyDestination(request.kind, request.action, request.name, request.to);
    if (destination === undefined) return null;
    const effect = planTaxonomyEffect(request.kind, request.action, request.name, request.to,
        request.expected, prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt);
    if (!effect || effect.tasks.length + effect.projects.length === 0
        || !same(effect, prepared.effect)
        || !same(prepared.result, { kind: request.kind, action: request.action,
            name: request.name, to: destination })) return null;
    return prepared;
};

export function createTaxonomyMethods(deps: {
    readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>>;
    t: () => (key: string) => string;
}) {
    const saves = createAreaSaveGuard(deps.save);
    const resultFor = (request: NativeTaxonomyRequest): NativeTaxonomyResult => ({
        kind: request.kind, action: request.action, name: request.name,
        to: taxonomyDestination(request.kind, request.action, request.name, request.to) ?? null,
    });
    return {
        async getTaxonomyOptions(input: { kind: TaxonomyKind; name: string }): Promise<NativeHostResult<NativeTaxonomyOptions>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const value = detach<Record<string, unknown>>(input);
            if (!value || !exact(value, ['kind', 'name']) || !['context', 'tag'].includes(String(value.kind))
                || !text(value.name, 10_000) || !value.name) return fail('INVALID_INPUT', 'A bounded taxonomy target is required');
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const kind = value.kind as TaxonomyKind;
            const expected = selectTaxonomyScope(kind, value.name, read.value.authority.snapshot.tasks,
                read.value.authority.snapshot.projects);
            if (expected.tasks.length + expected.projects.length === 0)
                return fail('STALE_REVISION', 'Managed value disappeared; refresh Manage');
            const t = deps.t();
            const options = detach<NativeTaxonomyOptions>(JSON.parse(JSON.stringify({ kind, name: value.name, expected,
                draft: getManageEditorDraft({ type: kind, name: value.name }),
                text: getManageEditorText(t, kind, {} as ManageUntranslatedText),
                confirmation: getManageDeleteConfirm(t, value.name) })));
            return options && validScope(options.expected, kind, value.name)
                ? { ok: true, value: options } : fail('INVALID_INPUT', 'Taxonomy options exceed the bounded response');
        },
        checkTaxonomyName(input: { kind: TaxonomyKind; name: string }): NativeHostResult<{ saveDisabled: boolean }> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const value = detach<Record<string, unknown>>(input);
            return value && exact(value, ['kind', 'name']) && ['context', 'tag'].includes(String(value.kind))
                && text(value.name, 10_000)
                ? { ok: true, value: { saveDisabled: isManageEditorSaveDisabled(value.kind as TaxonomyKind, value.name, []) } }
                : fail('INVALID_INPUT', 'A bounded taxonomy name is required');
        },
        probeTaxonomyOutcome(input: NativeTaxonomyRequest): NativeHostResult<NativeTaxonomyResult> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Taxonomy outcome is unknown; refresh Manage')
                : fail('INVALID_INPUT', 'A bounded taxonomy request is required');
        },
        async prepareTaxonomy(input: NativeTaxonomyRequest): Promise<NativeHostResult<NativeTaxonomyPreparation>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded taxonomy request is required');
            const updateAt = new Date().toISOString();
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const { snapshot } = read.value.authority;
            const scope = selectTaxonomyScope(request.kind, request.name, snapshot.tasks, snapshot.projects);
            if (!same(scope, request.expected) || (snapshot.settings.deviceId ?? null)
                !== (read.value.authority.state.settings.deviceId ?? null))
                return fail('STALE_REVISION', 'Managed value changed; refresh Manage');
            const destination = taxonomyDestination(request.kind, request.action, request.name, request.to);
            const result = destination === undefined ? { kind: request.kind, action: request.action,
                name: request.name, to: request.action === 'delete' ? null
                    : request.kind === 'tag' ? formatTagIdPreservingCase(request.to ?? '')
                        : request.to?.trim() ?? '' } : resultFor(request);
            if (destination === undefined) return { ok: true, value: { kind: 'noop', result } };
            const device = ensureDeviceId(snapshot.settings);
            const effect = planTaxonomyEffect(request.kind, request.action, request.name, request.to,
                scope, device.deviceId, updateAt)!;
            if (!effect.tasks.length && !effect.projects.length)
                return { ok: true, value: { kind: 'noop', result } };
            const prepared: NativePreparedTaxonomy = { version: 1, request, scope, effect,
                deviceIdBefore: snapshot.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null, updateAt, result };
            const frozen = detach<NativePreparedTaxonomy>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Taxonomy operation exceeds the bounded journal');
        },
        validatePreparedTaxonomy(input: { request: NativeTaxonomyRequest; prepared: NativePreparedTaxonomy }): NativeHostResult<NativeTaxonomyResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared taxonomy request or journal does not match');
        },
        async commitPreparedTaxonomy(input: { request: NativeTaxonomyRequest; prepared: NativePreparedTaxonomy }): Promise<NativeHostResult<NativeTaxonomyResult>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared taxonomy request or journal does not match');
            const read = await readAreaDurableData(true); if (!read.ok) return read;
            if (!saves.mayApply(prepared, read.value.adapter))
                return fail('SAVE_FAILED', 'Taxonomy operation has an unresolved persistence failure');
            const applied = await useTaskStore.getState().commitPreparedTaxonomy(prepared, read.value.authority);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Taxonomy changed; refresh Manage');
            const saved = await saves.finish(prepared, read.value.adapter,
                applied.outcome === 'replayed', read.value.authority.saveBoundary);
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
