import { safeParseDate, type DateFormatter } from './date';
import type { NativeHostResult } from './native-host-contract';
import type { NativeCalendarFeed } from './native-host-contract-calendar';
import { taskEditValuesEqual as same } from './json-value-equality';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { ensureDeviceId } from './store-helpers';
import { getStorageAdapter, useTaskStore } from './store';
import { projectCalendarReferenceEffect, sameProjectSqliteRow } from './store-projects/project-actions';
import { isProjectCalendarReference } from './project-calendar-reference-schema';
import { createProjectCalendarReference, getProjectCalendarReferenceCandidates, PROJECT_CALENDAR_REFERENCE_PICKER_LIMIT, resolveProjectCalendarReference } from './project-calendar-reference';
import { generateUUID } from './uuid';
import type { PreparedProjectCalendarReference } from './store-types';
import type { Project, ProjectCalendarReference } from './types';

export type NativeProjectCalendarReferenceToken = { title: string; status: Project['status'];
    calendarReference: ProjectCalendarReference | null; rev: number | null; revBy: string | null; updatedAt: string };
export type NativeProjectCalendarReferenceRequest = { requestId: string; projectId: string;
    value: ProjectCalendarReference | null; pickerId: string | null; expected: NativeProjectCalendarReferenceToken };
export type NativeProjectCalendarReferenceResult = { id: string; value: ProjectCalendarReference | null };
export type NativePreparedProjectCalendarReference = PreparedProjectCalendarReference & { version: 1;
    request: NativeProjectCalendarReferenceRequest; result: NativeProjectCalendarReferenceResult };
export type NativeProjectCalendarReferencePreparation = { kind: 'blocked'; result: { blocked: '' } }
    | { kind: 'noop'; result: NativeProjectCalendarReferenceResult }
    | { kind: 'prepared'; prepared: NativePreparedProjectCalendarReference };

export function projectCalendarReferenceDateLabel(reference: ProjectCalendarReference, format: DateFormatter): string {
    const pattern = reference.allDay ? 'PP' : 'PPp', start = format(reference.start, pattern, reference.start), last = safeParseDate(reference.end);
    if (!last) return start;
    if (reference.allDay) last.setDate(last.getDate() - 1);
    const end = format(last, pattern);
    return !end || end === start ? start : `${start} – ${end}`;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const token = (project: Project): NativeProjectCalendarReferenceToken => ({ title: project.title, status: project.status,
    calendarReference: project.calendarReference ?? null, rev: project.rev ?? null,
    revBy: project.revBy ?? null, updatedAt: project.updatedAt });
const result = (request: NativeProjectCalendarReferenceRequest): NativeProjectCalendarReferenceResult =>
    ({ id: request.projectId, value: request.value });
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const validToken = (value: unknown): value is NativeProjectCalendarReferenceToken => record(value)
    && exact(value, ['title', 'status', 'calendarReference', 'rev', 'revBy', 'updatedAt'])
    && typeof value.title === 'string' && value.title.length <= 100_000
    && ['active', 'someday', 'waiting', 'archived'].includes(String(value.status))
    && (value.calendarReference === null || isProjectCalendarReference(value.calendarReference))
    && (value.rev === null || typeof value.rev === 'number' && Number.isSafeInteger(value.rev) && value.rev >= 0)
    && (value.revBy === null || typeof value.revBy === 'string' && value.revBy.length <= 500)
    && iso(value.updatedAt);
const readRequest = (value: unknown): NativeProjectCalendarReferenceRequest | null => {
    const input = detach<NativeProjectCalendarReferenceRequest>(value);
    return input && exact(input, ['requestId', 'projectId', 'value', 'pickerId', 'expected'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && typeof input.projectId === 'string' && input.projectId.length > 0 && input.projectId.length <= 500
        && (input.value === null || isProjectCalendarReference(input.value))
        && (input.pickerId === null || typeof input.pickerId === 'string' && UUID.test(input.pickerId))
        && validToken(input.expected) ? input : null;
};
const readPrepared = (value: unknown): NativePreparedProjectCalendarReference | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request), raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'result'])
        || raw.version !== 1 || !same(raw.request, request) || !record(raw.scope) || !exact(raw.scope, ['project'])
        || !validProject(raw.scope.project, request.projectId) || !record(raw.effect) || !exact(raw.effect, ['project'])
        || !record(raw.effect.project) || !exact(raw.effect.project, ['before', 'after'])
        || !validProject(raw.effect.project.before, request.projectId) || !validProject(raw.effect.project.after, request.projectId)
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null) || !iso(raw.updateAt) || !same(raw.result, result(request))) return null;
    const before = raw.scope.project;
    if (before.status === 'archived' || !same(token(before), request.expected)
        || same(before.calendarReference ?? null, request.value) || !same(before, raw.effect.project.before)) return null;
    const planned = projectCalendarReferenceEffect(before, request.value,
        String(raw.deviceIdBefore ?? raw.deviceIdToInitialize), raw.updateAt);
    return same(planned, raw.effect) ? raw as NativePreparedProjectCalendarReference : null;
};

export function createProjectCalendarReferenceMethods(deps: {
    readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>>; revision: () => string;
    formatDate: (reference: ProjectCalendarReference) => string;
    load: (input: { slot: 'projectCalendar'; start: string; end: string }) => Promise<NativeHostResult<NativeCalendarFeed>>;
}) {
    type Picker = { id: string; projectId: string; adapter: ReturnType<typeof getStorageAdapter>; subscriptions: string;
        expected: NativeProjectCalendarReferenceToken; candidates: ProjectCalendarReference[]; at: number;
        current: ProjectCalendarReference | null; status: 'scheduled' | 'elapsed' | 'unavailable'; available: boolean };
    let picker: Picker | null = null;
    const subscriptions = () => JSON.stringify(useTaskStore.getState().settings.externalCalendars ?? null);
    const response = (selected: Picker, query: string) => {
        const normalized = query.trim().toLocaleLowerCase();
        const matching = selected.candidates.filter((candidate) => !normalized
            || `${candidate.title} ${candidate.sourceName}`.toLocaleLowerCase().includes(normalized));
        const shown = matching.slice(0, PROJECT_CALENDAR_REFERENCE_PICKER_LIMIT);
        const value = { revision: deps.revision(), project: { id: selected.projectId, ...selected.expected },
            canEdit: selected.expected.status !== 'archived', pickerId: selected.id, status: selected.status,
            current: selected.current, currentDateLabel: selected.current ? deps.formatDate(selected.current) : null,
            candidates: shown, candidateDateLabels: shown.map(deps.formatDate),
            available: selected.available, total: matching.length, query };
        return isNativeJsonWithinBytes(value) ? { ok: true as const, value } : fail('INVALID_INPUT', 'Calendar picker exceeds the bounded response');
    };
    return {
        async getProjectCalendarReferenceOptions(input: { projectId: string; query?: string; summary?: true }) {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500
                || (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 1000))
                || (input.summary !== undefined && input.summary !== true))
                return fail('INVALID_INPUT', 'A bounded Project ID is required');
            const state = useTaskStore.getState(), project = state._projectsById.get(input.projectId);
            if (!project || project.deletedAt || project.purgedAt) return fail('STALE_REVISION', 'Project is unavailable');
            const adapter = getStorageAdapter(), source = subscriptions(), expected = token(project), now = new Date();
            if (input.summary) return response({ id: generateUUID(), projectId: project.id, adapter, subscriptions: source, expected,
                candidates: [], at: Date.now(), status: 'unavailable', current: project.calendarReference ?? null, available: false }, '');
            if (input.query !== undefined && picker && picker.projectId === project.id && picker.adapter === adapter
                && picker.subscriptions === source && same(picker.expected, expected) && Date.now() - picker.at <= 300_000)
                return response(picker, input.query);
            const feed = await deps.load({ slot: 'projectCalendar', start: now.toISOString(), end: new Date(now.getTime() + 90 * 86_400_000).toISOString() });
            const available = feed.ok && feed.value.status === 'ready' && feed.value.warning === undefined;
            const candidates = feed.ok && feed.value.status === 'ready' && feed.value.warning === undefined
                ? getProjectCalendarReferenceCandidates(feed.value.events, state.settings.externalCalendars ?? [], now) : [];
            let status: 'scheduled' | 'elapsed' | 'unavailable' = 'unavailable';
            let current = project.calendarReference ?? null;
            let superseded = !feed.ok && feed.error.code === 'STALE_REVISION';
            if (current) {
                let linked = feed;
                const starts = safeParseDate(current.start)?.getTime() ?? NaN, ends = safeParseDate(current.end)?.getTime() ?? NaN;
                if (starts < now.getTime() || ends > now.getTime() + 90 * 86_400_000) {
                    linked = await deps.load({ slot: 'projectCalendar', start: new Date(starts - 86_400_000).toISOString(),
                        end: new Date(Math.max(starts + 86_400_000, ends + 86_400_000)).toISOString() });
                    superseded ||= !linked.ok && linked.error.code === 'STALE_REVISION';
                }
                const resolved = resolveProjectCalendarReference(current, linked.ok && linked.value.status === 'ready' && linked.value.warning === undefined ? linked.value.events : [],
                    linked.ok && linked.value.status === 'ready' && linked.value.warning === undefined, now);
                status = resolved.status;
                if (resolved.event) current = createProjectCalendarReference(resolved.event, state.settings.externalCalendars ?? []) ?? current;
            }
            const fresh = useTaskStore.getState()._projectsById.get(input.projectId);
            if (getStorageAdapter() !== adapter || subscriptions() !== source || !fresh || !sameProjectSqliteRow(project, fresh))
                return fail('STALE_REVISION', 'Project or calendars changed while loading');
            const loaded: Picker = { id: generateUUID(), projectId: project.id, adapter, subscriptions: source, expected, candidates,
                at: Date.now(), status, current, available };
            if (!superseded) picker = loaded;
            return response(loaded, input.query ?? '');
        },
        probeProjectCalendarReferenceOutcome(input: NativeProjectCalendarReferenceRequest): NativeHostResult<NativeProjectCalendarReferenceResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Project calendar reference outcome is unknown; refresh before trying again')
                : fail('INVALID_INPUT', 'A bounded calendar reference request is required');
        },
        prepareProjectCalendarReference(input: NativeProjectCalendarReferenceRequest): NativeHostResult<NativeProjectCalendarReferencePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded calendar reference request is required');
            const state = useTaskStore.getState(), project = state._projectsById.get(request.projectId);
            if (!project || project.deletedAt || project.purgedAt || !same(token(project), request.expected))
                return fail('STALE_REVISION', 'Project changed; refresh before linking its event');
            if (project.status === 'archived') return { ok: true as const, value: { kind: 'blocked' as const, result: { blocked: '' } } };
            if (same(project.calendarReference ?? null, request.value)) return { ok: true as const, value: { kind: 'noop' as const, result: result(request) } };
            if (request.value !== null && (!picker || request.pickerId !== picker.id || picker.projectId !== project.id
                || picker.adapter !== getStorageAdapter() || picker.subscriptions !== subscriptions() || Date.now() - picker.at > 300_000
                || !same(picker.expected, request.expected) || !picker.candidates.some((candidate) => same(candidate, request.value))))
                return fail('STALE_REVISION', 'Calendar selection changed; reopen the event picker');
            const device = ensureDeviceId(state.settings), updateAt = new Date().toISOString();
            const prepared: NativePreparedProjectCalendarReference = { version: 1, request, scope: { project },
                effect: projectCalendarReferenceEffect(project, request.value, device.deviceId, updateAt),
                deviceIdBefore: state.settings.deviceId ?? null, deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: result(request) };
            const frozen = detach<NativePreparedProjectCalendarReference>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen }) ? { ok: true as const, value: { kind: 'prepared' as const, prepared: frozen } }
                : fail('INVALID_INPUT', 'Calendar reference edit exceeds the bounded journal');
        },
        validatePreparedProjectCalendarReference(input: { request: NativeProjectCalendarReferenceRequest; prepared: NativePreparedProjectCalendarReference }) {
            const prepared = readPrepared(input);
            return prepared ? { ok: true as const, value: prepared.result } : fail('INVALID_INPUT', 'Prepared calendar reference does not match');
        },
        async commitPreparedProjectCalendarReference(input: { request: NativeProjectCalendarReferenceRequest; prepared: NativePreparedProjectCalendarReference }) {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared calendar reference does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectCalendarReference(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Project calendar reference conflicts with current data');
            try { if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence(); }
            catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true as const, value: prepared.result } : saved;
        },
    };
}
