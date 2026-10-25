import { isValidProjectColorOverride } from './color-constants';
import type { NativeHostResult } from './native-host-contract';
import { projectReviewPickerValue } from './project-details-presentation';
import { normalizeProjectTag } from './project-tags';
import { resolveI18nText, type I18nTemplateValues, type TranslateFn } from './i18n';
import { revisionOf } from './native-request-receipts';
import { createProjectToSectionPreviewer, getProjectToSectionEligibility, planProjectToSection, type ProjectToSectionReceipt } from './project-to-section';
import { projectDuplicateId } from './native-host-contract-project-duplicate';
import { useTaskStore } from './store';
import { PROJECT_TASK_SORT_OPTIONS } from './task-list-sort-options';
import { deterministicHash128 } from './uuid';
import { ensureDeviceId } from './store-helpers';
import { getProjectAccentColor } from './task-accent-color';

/**
 * One Project details edit as the user made it: the field and its new value (a target state), under the request UUID the
 * native host journals before anything else runs. A section's create uses the request UUID as the new section's id.
 */
export type NativeProjectEdit = { requestId: string; projectId: string } & (
    | { kind: 'title'; title: string }
    | { kind: 'status'; status: 'active' | 'waiting' | 'someday' }
    | { kind: 'type'; sequential: boolean }
    | { kind: 'scope'; scope: 'project' | 'section' }
    | { kind: 'area'; areaId: string | null }
    | { kind: 'color'; colorOverride: string | null }
    | { kind: 'tag'; tag: string; present: boolean }
    | { kind: 'notes'; text: string }
    | { kind: 'date'; field: 'startDate' | 'dueDate' | 'reviewAt'; value: string | null; opened: string | null }
    | { kind: 'sectionCreate'; title: string }
    | { kind: 'sectionRename'; sectionId: string; title: string }
    | { kind: 'sectionDelete'; sectionId: string }
    | { kind: 'sectionMove'; sectionId: string; direction: 'up' | 'down'; order: string[] }
    // The header's actions sheet (RN's "..."): Complete, Cancel or Reactivate, Duplicate, Delete and that Delete's Undo.
    | { kind: 'lifecycle'; action: 'complete' | 'cancel' | 'reactivate' }
    | { kind: 'duplicate' }
    | { kind: 'delete' }
    | { kind: 'deleteUndo'; deleteRequestId: string }
    // RN's Convert to section… (the request UUID names the new section) and that conversion's Undo.
    | { kind: 'toSection'; destinationProjectId: string; title: string; expected: string }
    | { kind: 'toSectionUndo'; convertRequestId: string }
    // RN's view options Sort: the project's task sort (core's choices).
    | { kind: 'sort'; sortBy: string });
/** [reply] is the prepared command's own answer when it wrote: the copy and its toast (duplicate), RN's Undo toast (delete). */
export type NativeProjectEditResult = { id: string; kind: NativeProjectEdit['kind']; outcome: 'saved' | 'unchanged' | 'blocked'; reply?: unknown };

type Reply = NativeHostResult<unknown>;
type Json = Record<string, unknown>;
/** The prepared project commands this runs: core's own options, preparation and commit methods, called on the contract. */
type Port = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ATTEMPTS = 4;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const text = (value: unknown, max = 100_000): value is string => typeof value === 'string' && value.length <= max;
const id = (value: unknown): value is string => text(value, 500) && value.length > 0;
const keys = (input: Json, names: string[]) => Object.keys(input).length === names.length + 3
    && ['requestId', 'projectId', 'kind', ...names].every((name) => Object.prototype.hasOwnProperty.call(input, name));

const valid = (input: unknown): input is NativeProjectEdit => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const edit = input as Json;
    if (typeof edit.requestId !== 'string' || !UUID.test(edit.requestId) || !id(edit.projectId)) return false;
    switch (edit.kind) {
        case 'title': case 'sectionCreate': return keys(edit, ['title']) && text(edit.title);
        case 'status': return keys(edit, ['status']) && ['active', 'waiting', 'someday'].includes(edit.status as string);
        case 'type': return keys(edit, ['sequential']) && typeof edit.sequential === 'boolean';
        case 'scope': return keys(edit, ['scope']) && (edit.scope === 'project' || edit.scope === 'section');
        case 'color': return keys(edit, ['colorOverride']) && edit.colorOverride !== undefined && isValidProjectColorOverride(edit.colorOverride);
        case 'area': return keys(edit, ['areaId']) && (edit.areaId === null || id(edit.areaId));
        case 'tag': return keys(edit, ['tag', 'present']) && text(edit.tag) && typeof edit.present === 'boolean';
        case 'notes': return keys(edit, ['text']) && text(edit.text, 2_000_000);
        case 'date': return keys(edit, ['field', 'value', 'opened']) && ['startDate', 'dueDate', 'reviewAt'].includes(edit.field as string)
            && (edit.value === null || text(edit.value, 100)) && (edit.opened === null || (edit.field === 'reviewAt' && text(edit.opened, 100)));
        case 'sectionRename': return keys(edit, ['sectionId', 'title']) && id(edit.sectionId) && text(edit.title);
        case 'sectionDelete': return keys(edit, ['sectionId']) && id(edit.sectionId);
        case 'sectionMove': return keys(edit, ['sectionId', 'direction', 'order']) && id(edit.sectionId)
            && (edit.direction === 'up' || edit.direction === 'down') && Array.isArray(edit.order)
            && edit.order.length <= 1_000 && edit.order.every(id);
        case 'lifecycle': return keys(edit, ['action']) && ['complete', 'cancel', 'reactivate'].includes(edit.action as string);
        case 'duplicate': case 'delete': return keys(edit, []);
        case 'deleteUndo': return keys(edit, ['deleteRequestId']) && typeof edit.deleteRequestId === 'string'
            && UUID.test(edit.deleteRequestId) && edit.deleteRequestId !== edit.requestId;
        case 'toSection': return keys(edit, ['destinationProjectId', 'title', 'expected']) && id(edit.destinationProjectId) && text(edit.title, 500)
            && text(edit.expected, 200);
        case 'sort': return keys(edit, ['sortBy']) && (PROJECT_TASK_SORT_OPTIONS as readonly string[]).includes(edit.sortBy as string);
        case 'toSectionUndo': return keys(edit, ['convertRequestId']) && typeof edit.convertRequestId === 'string'
            && UUID.test(edit.convertRequestId) && edit.convertRequestId !== edit.requestId;
        default: return false;
    }
};

/** The section order [order] would have after moving [sectionId] one step [direction]; null when it cannot move. */
const moved = (order: string[], sectionId: string, direction: 'up' | 'down'): string[] | null => {
    const from = order.indexOf(sectionId);
    const to = from + (direction === 'up' ? -1 : 1);
    if (from < 0 || to < 0 || to >= order.length) return null;
    const next = [...order];
    [next[from], next[to]] = [next[to], next[from]];
    return next;
};
const same = (a: string[], b: string[] | null) => b !== null && a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Project details' journaled edit (Android's `projectEdit` Menu command): core's options for the project as it is now, the
 * request built from them, core's preparation and the prepared commit, all inside one command, so the native journal holds
 * only the user's intent and its boot replay or retry redoes the whole edit. Each edit is a target state: one already applied
 * (a replay) answers `unchanged` and writes nothing. A sync landing between the steps (STALE_REVISION) prepares the edit
 * again against the project as it is then. A save that failed before is finished first, and every answer waits for the save.
 */
export function createProjectEditMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    contract: () => Port;
    t: () => TranslateFn;
}) {
    const word = (key: string, values?: I18nTemplateValues) => resolveI18nText(deps.t(), key, values ? { values } : undefined);
    const call = async (name: string, input: unknown): Promise<Reply> => {
        const port = deps.contract();
        return await (port[name] as (value: unknown) => Reply | Promise<Reply>).call(port, input);
    };
    const token = (options: Json): Json => {
        const { id: _id, ...expected } = options.project as Json;
        return expected;
    };
    type Plan = { outcome: 'unchanged' | 'blocked'; reply?: Json } | { command: string; request: Json } | { conflict: string }
        // A store command run as is (Convert to section and its Undo): its answer is final, never prepared again.
        | { run: () => Promise<NativeHostResult<Json>> };
    // The Deletes this process confirmed, by request UUID: their Undo needs the confirmed Delete. RN's Undo lives as long as its
    // toast and is gone after a restart; these are gone after a restart too.
    const deletes = new Map<string, Json>();
    // The conversions this process made, by request UUID, for their Undo (RN keeps the receipt for its toast's Undo).
    const conversions = new Map<string, ProjectToSectionReceipt>();
    // The envelope a request prepared while its save is owed, by request UUID: the retry (Try again) commits that same envelope, so
    // its receipt answers with the first reply (the toast, the Undo) instead of a plan that finds the work already done.
    const preparedBy = new Map<string, { command: string; request: Json; prepared: Json }>();
    // Each conversion's plan, by request UUID, so its retry sends the same command (RN retries the same prepared conversion).
    const convertPlans = new Map<string, Parameters<ReturnType<typeof useTaskStore.getState>['convertProjectToSection']>[0]>();
    /** What the preview showed: the counts and titles, and every row the conversion moves, at their revisions. */
    const convertToken = (projectId: string, destinationId: string): string => {
        const state = useTaskStore.getState();
        const rows = [state._projectsById.get(projectId), state._projectsById.get(destinationId),
            ...state._allTasks.filter((row) => row.projectId === projectId || row.projectId === destinationId),
            ...state._allSections.filter((row) => row.projectId === projectId || row.projectId === destinationId)]
            .map((row) => row ? `${row.id}@${revisionOf(row)}` : '-').sort();
        return deterministicHash128(JSON.stringify([projectId, destinationId, rows])).map((part) => part.toString(16)).join('');
    };
    const remember = <T,>(map: Map<string, T>, key: string, value: T) => {
        map.set(key, value);
        if (map.size > 20) map.delete(map.keys().next().value as string);
    };

    /** The request one edit makes from core's options for the project as it is now. */
    const plan = async (edit: NativeProjectEdit): Promise<NativeHostResult<Plan>> => {
        const base = { requestId: edit.requestId, projectId: edit.projectId };
        const project = { projectId: edit.projectId };
        const options = async (name: string, input: Json = project): Promise<NativeHostResult<Json>> =>
            await call(name, input) as NativeHostResult<Json>;
        switch (edit.kind) {
            case 'title': {
                const read = await options('getProjectRenameOptions');
                if (!read.ok) return read;
                return { ok: true, value: read.value.canRename === false ? { outcome: 'blocked' }
                    : { command: 'ProjectRename', request: { ...base, title: edit.title, expected: token(read.value) } } };
            }
            case 'status': {
                const read = await options('getProjectStatusOptions');
                if (!read.ok) return read;
                return { ok: true, value: read.value.canChange === false ? { outcome: 'blocked' }
                    : { command: 'ProjectStatus', request: { ...base, status: edit.status, expected: token(read.value) } } };
            }
            case 'type': case 'scope': {
                const read = await options('getProjectFlowOptions');
                if (!read.ok) return read;
                if (read.value.canChange === false) return { ok: true, value: { outcome: 'blocked' } };
                const flow = read.value.project as Json;
                if (edit.kind === 'type' && (flow.isSequential === true) === edit.sequential) return { ok: true, value: { outcome: 'unchanged' } };
                const action = edit.kind === 'type' ? { kind: 'toggleType' } : { kind: 'setScope', scope: edit.scope };
                return { ok: true, value: { command: 'ProjectFlow', request: { ...base, action, expected: token(read.value) } } };
            }
            case 'color': case 'area': {
                const read = await options('getProjectAreaOptions');
                if (!read.ok) return read;
                if (read.value.canEdit === false) return { ok: true, value: { outcome: 'blocked' } };
                const areaId = edit.kind === 'area' ? edit.areaId : (read.value.project as Json).areaId;
                const area = areaId === null ? null : (read.value.areas as Json[]).find((row) => row.id === areaId);
                if (area === undefined) return { ok: true, value: { conflict: 'The Area is no longer there' } };
                return { ok: true, value: { command: 'ProjectArea', request: { ...base, areaId, ...(edit.kind === 'color' ? { colorOverride: edit.colorOverride } : {}), expected: token(read.value),
                    selectedArea: area === null ? null : { id: area.id, name: area.label } } } };
            }
            case 'tag': {
                const read = await options('getProjectTagsEditOptions');
                if (!read.ok) return read;
                if (read.value.canEdit === false) return { ok: true, value: { outcome: 'blocked' } };
                const tag = normalizeProjectTag(edit.tag);
                const has = ((read.value.project as Json).tagIds as string[]).includes(tag);
                if (!tag || has === edit.present) return { ok: true, value: { outcome: 'unchanged' } };
                // Core's add adds; its toggle of a tag the project has removes it.
                return { ok: true, value: { command: 'ProjectTagsWrite', request: { ...base,
                    intent: { kind: edit.present ? 'add' : 'toggle', input: tag }, expected: token(read.value) } } };
            }
            case 'notes': {
                const read = await options('getProjectNotesEditOptions');
                if (!read.ok) return read;
                return { ok: true, value: read.value.canEdit === false ? { outcome: 'blocked' }
                    : { command: 'ProjectNotesWrite', request: { ...base, text: edit.text, expected: token(read.value) } } };
            }
            case 'date': {
                // A review date picked on Android: the picked day at the hour and minute the picker opened on (RN's picker).
                const value = edit.value !== null && edit.opened !== null ? projectReviewPickerValue(edit.value, edit.opened) : edit.value;
                if (edit.value !== null && value === null) return fail('INVALID_INPUT', 'A picked review day and the picker instant are required');
                const read = await options('getProjectDateOptions', { ...project, field: edit.field });
                if (!read.ok) return read;
                return { ok: true, value: read.value.canEdit === false ? { outcome: 'blocked' }
                    : { command: 'ProjectDate', request: { ...base, field: edit.field, value, expected: token(read.value) } } };
            }
            case 'sectionCreate': {
                // The section takes the request UUID as its id: once it exists, the edit is done.
                if (useTaskStore.getState()._allSections.some((row) => row.id === edit.requestId)) return { ok: true, value: { outcome: 'unchanged' } };
                const read = await options('getProjectSectionOptions');
                if (!read.ok) return read;
                return { ok: true, value: read.value.canCreate === false ? { outcome: 'blocked' }
                    : { command: 'ProjectSectionCreate', request: { ...base, title: edit.title } } };
            }
            case 'sectionRename': case 'sectionDelete': {
                const current = useTaskStore.getState()._allSections.find((row) => row.id === edit.sectionId);
                if (!current || current.deletedAt) {
                    return { ok: true, value: edit.kind === 'sectionDelete' ? { outcome: 'unchanged' } : { conflict: 'The Section is no longer there' } };
                }
                const isRename = edit.kind === 'sectionRename';
                const read = await options(isRename ? 'getProjectSectionRenameOptions' : 'getProjectSectionDeleteOptions',
                    { ...project, sectionId: edit.sectionId });
                if (!read.ok) return read;
                if (read.value[isRename ? 'canRename' : 'canDelete'] === false) return { ok: true, value: { outcome: 'blocked' } };
                return { ok: true, value: isRename
                    ? { command: 'ProjectSectionRename', request: { ...base, sectionId: edit.sectionId, title: edit.title, expected: read.value.token } }
                    : { command: 'ProjectSectionDelete', request: { ...base, sectionId: edit.sectionId, expected: read.value.token } } };
            }
            case 'sectionMove': {
                const read = await options('getProjectSectionOrderOptions');
                if (!read.ok) return read;
                if (read.value.canReorder === false) return { ok: true, value: { outcome: 'blocked' } };
                const shown = (read.value.sections as Json[]).map((row) => row.id as string);
                if (same(shown, moved(edit.order, edit.sectionId, edit.direction))) return { ok: true, value: { outcome: 'unchanged' } };
                if (!same(shown, edit.order)) return { ok: true, value: { conflict: 'The Sections changed since they were shown' } };
                return { ok: true, value: { command: 'ProjectSectionOrder', request: { ...base, sectionId: edit.sectionId,
                    direction: edit.direction, expectedSections: read.value.token } } };
            }
            case 'sort': {
                const read = await options('getProjectTaskSortOptions');
                if (!read.ok) return read;
                if (read.value.canEdit === false) return { ok: true, value: { outcome: 'blocked' } };
                const expected = token(read.value);
                if ((expected.taskSortBy ?? 'default') === edit.sortBy) return { ok: true, value: { outcome: 'unchanged' } };
                return { ok: true, value: { command: 'ProjectTaskSort', request: { ...base, sortBy: edit.sortBy, expected } } };
            }
            case 'toSection': {
                const converted = (destinationProjectId: string, sectionId: string) => ({ destinationProjectId, sectionId,
                    title: word('common.done'), message: word('projects.convertSuccess'), undoLabel: word('common.undo') });
                // The section named by this request exists: the conversion landed (a retry or a replay); its toast again while its Undo
                // is still known (this process).
                if (useTaskStore.getState()._allSections.some((row) => row.id === edit.requestId)) {
                    return { ok: true, value: { outcome: 'unchanged', ...(conversions.has(edit.requestId) ? { reply: converted(edit.destinationProjectId, edit.requestId) } : {}) } };
                }
                const cached = convertPlans.get(edit.requestId);
                // RN converts what its preview showed: a change since (a sync, another edit) refuses with RN's message.
                if (!cached && convertToken(edit.projectId, edit.destinationProjectId) !== edit.expected) return { ok: true, value: { conflict: word('projects.convertFailure.conflict') } };
                return { ok: true, value: { run: async () => {
                    const state = useTaskStore.getState();
                    const device = ensureDeviceId(state.settings);
                    const planned = cached ? { ok: true as const, command: cached } : planProjectToSection(state, edit.projectId, edit.destinationProjectId, edit.title, edit.requestId,
                        new Date().toISOString(), state.settings.deviceId ?? null, device.updated ? device.deviceId : null);
                    if (!planned.ok) return fail('STALE_REVISION', word(`projects.convertBlocked.${planned.reason}`));
                    remember(convertPlans, edit.requestId, planned.command);
                    const result = await state.convertProjectToSection(planned.command);
                    if (!result.success) {
                        if (result.reason !== 'save-failed') convertPlans.delete(edit.requestId);
                        return fail(result.reason === 'save-failed' ? 'SAVE_FAILED' : 'STALE_REVISION', word(`projects.convertFailure.${result.reason}`));
                    }
                    remember(conversions, edit.requestId, result.receipt);
                    return { ok: true, value: converted(result.destinationProjectId, result.sectionId) };
                } } };
            }
            case 'toSectionUndo': {
                const source = useTaskStore.getState()._projectsById.get(edit.projectId);
                if (source && !source.deletedAt && !source.purgedAt) return { ok: true, value: { outcome: 'unchanged', reply: { sourceProjectId: source.id } } };
                const receipt = conversions.get(edit.convertRequestId);
                if (!receipt) return { ok: true, value: { conflict: word('projects.convertUndoFailure.invalid') } };
                return { ok: true, value: { run: async () => {
                    const result = await useTaskStore.getState().undoProjectToSection(receipt);
                    if (!result.success) return fail(result.reason === 'save-failed' ? 'SAVE_FAILED' : 'STALE_REVISION', word(`projects.convertUndoFailure.${result.reason}`));
                    conversions.delete(edit.convertRequestId);
                    return { ok: true, value: { sourceProjectId: result.sourceProjectId } };
                } } };
            }
            case 'lifecycle': case 'duplicate': case 'delete': case 'deleteUndo': {
                const current = useTaskStore.getState()._projectsById.get(edit.projectId);
                const gone = !current || Boolean(current.deletedAt) || Boolean(current.purgedAt);
                if (edit.kind === 'deleteUndo') {
                    // Back in place (a replay, or the Undo already ran): nothing to restore.
                    return { ok: true, value: !gone ? { outcome: 'unchanged' }
                        : !deletes.has(edit.deleteRequestId) ? { conflict: 'The Delete can no longer be undone' }
                            : { command: 'ProjectDeleteUndo', request: { requestId: edit.requestId, deleteRequestId: edit.deleteRequestId } } };
                }
                if (gone) return { ok: true, value: edit.kind === 'delete' ? { outcome: 'unchanged' } : { conflict: 'The Project is no longer there' } };
                const request = { ...base, projectRevision: revisionOf(current) };
                if (edit.kind === 'delete') return { ok: true, value: { command: 'ProjectDelete', request } };
                // ponytail: a duplicate's replay after it landed is refused by its receipt (new ids, another payload), never written twice.
                if (edit.kind === 'duplicate') {
                    // A replay after a restart: the copy this request made (its ids come from the request UUID) answers it.
                    const made = new Set(Array.from({ length: (current.attachments?.length ?? 0) + 1 }, (_, index) => projectDuplicateId(edit.requestId, index)));
                    const copy = useTaskStore.getState()._allProjects.find((row) => made.has(row.id));
                    return { ok: true, value: copy ? { outcome: 'unchanged', reply: { id: copy.id, message: word('projects.duplicated') } }
                        : { command: 'ProjectDuplicate', request } };
                }
                const done = edit.action === 'reactivate' ? current.status !== 'archived'
                    : current.status === 'archived' && Boolean(current.cancelledAt) === (edit.action === 'cancel');
                return { ok: true, value: done ? { outcome: 'unchanged' } : { command: 'ProjectLifecycle', request: { ...request, action: edit.action } } };
            }
        }
    };

    return {
        /**
         * RN's Convert to section… for [projectId]: the actions row (its eligibility, or why not), the destinations core allows,
         * and for a picked destination the preview's lines in the app language (or why that destination is refused). A read.
         */
        getProjectToSectionOptions(input: { projectId: string; destinationId: string | null; title: string }): NativeHostResult<Json> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input !== 'object' || !id(input.projectId) || !(input.destinationId === null || id(input.destinationId))
                || !text(input.title, 500) || Object.keys(input).length !== 3) return fail('INVALID_INPUT', 'A project, a destination or null, and a title are required');
            const state = useTaskStore.getState();
            const source = state._projectsById.get(input.projectId);
            const eligible = getProjectToSectionEligibility(state, input.projectId);
            const previewer = createProjectToSectionPreviewer(state, input.projectId);
            const areaById = new Map(state._allAreas.map((area) => [area.id, area]));
            const destinations = eligible.ok ? state._allProjects.filter((row) => !row.deletedAt && previewer(row.id).ok)
                .map((row) => ({ id: row.id, title: row.title, color: getProjectAccentColor(row, areaById) ?? null })) : [];
            const preview = input.destinationId === null ? null : previewer(input.destinationId);
            const destination = input.destinationId === null ? undefined : state._projectsById.get(input.destinationId);
            const area = destination?.areaId ? state._allAreas.find((row) => row.id === destination.areaId && !row.deletedAt) : undefined;
            return { ok: true, value: {
                row: { label: word('projects.convertToSection'), eligible: eligible.ok, blocked: eligible.ok ? null : word(`projects.convertBlocked.${eligible.reason}`) },
                sequentialNote: source?.isSequential ? word('projects.convertBlocked.destination-section-sequence') : null,
                words: { title: word('projects.convertToSection'), destination: word('projects.convertDestination'), choose: word('projects.convertChooseDestination'),
                    sectionName: word('projects.convertSectionName'), cancel: word('common.cancel'), back: word('common.back'), next: word('common.next'),
                    convert: word('projects.convertToSection') },
                destinations,
                preview: preview?.ok && destination ? {
                    named: word('projects.convertNamedSection', { name: input.title.trim() }),
                    lines: [word('projects.convertSummary', { count: preview.taskCount, completed: preview.completedCount, archived: preview.archivedCount,
                        source: preview.sourceTitle, destination: preview.destinationTitle }),
                    ...(source?.supportNotes ? [word('projects.convertNotes')] : []),
                    word('projects.convertArea', { area: area?.name ?? word('projects.noArea') }),
                    word('projects.convertDestinationColor'), word('projects.convertColor'), word('projects.convertSettings'), word('projects.convertTrash')],
                    color: getProjectAccentColor(destination, areaById) ?? null,
                    // Sent back with Convert: core converts only what this preview showed.
                    token: convertToken(input.projectId, destination.id),
                } : null,
                blocked: preview && !preview.ok ? word(`projects.convertBlocked.${preview.reason}`) : null,
            } };
        },

        async runProjectEdit(input: NativeProjectEdit): Promise<NativeHostResult<NativeProjectEditResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!valid(input)) return fail('INVALID_INPUT', 'A bounded Project details edit is required');
            const answer = (outcome: NativeProjectEditResult['outcome']) => ({ id: input.projectId, kind: input.kind, outcome });
            // A save that failed before (this edit's first send, say) is finished first, so `unchanged` never hides a lost write.
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            let stale = 'Project changed; the edit could not be applied';
            const replied = (outcome: NativeProjectEditResult['outcome'], reply: unknown) =>
                (['duplicate', 'delete'].includes(input.kind) && reply !== undefined ? { ...answer(outcome), reply } : answer(outcome));
            const commit = async (entry: { command: string; request: Json; prepared: Json }): Promise<Reply> => {
                const committed = await call(`commitPrepared${entry.command}`, { request: entry.request, prepared: entry.prepared });
                if (committed.ok || committed.error.code === 'SAVE_FAILED') {
                    if (entry.command === 'ProjectDelete') remember(deletes, input.requestId, { request: entry.request, prepared: entry.prepared });
                }
                // Only a save owed keeps the envelope: once settled, a replay is a plan that finds the work done (unchanged).
                if (committed.ok || committed.error.code !== 'SAVE_FAILED') preparedBy.delete(input.requestId);
                return committed;
            };
            const retried = preparedBy.get(input.requestId);
            if (retried) {
                const committed = await commit(retried);
                return committed.ok ? { ok: true, value: replied('saved', committed.value) } : committed as NativeHostResult<never>;
            }
            for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
                const planned = await plan(input);
                if (!planned.ok) {
                    if (planned.error.code !== 'STALE_REVISION') return planned;
                    stale = planned.error.message;
                    continue;
                }
                const step = planned.value;
                if ('conflict' in step) return fail('STALE_REVISION', step.conflict);
                if ('run' in step) {
                    const ran = await step.run();
                    if (!ran.ok) return ran;
                    const saved = await deps.save();
                    return saved.ok ? { ok: true, value: { ...answer('saved'), reply: ran.value } } : saved;
                }
                if ('outcome' in step) {
                    const saved = await deps.save();
                    return saved.ok ? { ok: true, value: step.reply ? { ...answer(step.outcome), reply: step.reply } : answer(step.outcome) } : saved;
                }
                const prepared = await call(`prepare${step.command}`, step.command === 'ProjectDeleteUndo'
                    ? { request: step.request, delete: deletes.get(step.request.deleteRequestId as string) } : step.request) as NativeHostResult<Json>;
                if (!prepared.ok) {
                    if (prepared.error.code !== 'STALE_REVISION') return prepared;
                    stale = prepared.error.message;
                    continue;
                }
                if (prepared.value.kind !== 'prepared') {
                    const saved = await deps.save();
                    return saved.ok ? { ok: true, value: answer(prepared.value.kind === 'blocked' ? 'blocked' : 'unchanged') } : saved;
                }
                const entry = { command: step.command, request: step.request, prepared: prepared.value.prepared as Json };
                remember(preparedBy, input.requestId, entry);
                const committed = await commit(entry);
                if (committed.ok) return { ok: true, value: replied('saved', committed.value) };
                if (committed.error.code !== 'STALE_REVISION') return committed as NativeHostResult<never>;
                stale = committed.error.message;
            }
            return fail('STALE_REVISION', stale);
        },
    };
}
