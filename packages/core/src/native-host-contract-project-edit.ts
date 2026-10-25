import { isValidProjectColorOverride } from './color-constants';
import type { NativeHostResult } from './native-host-contract';
import { projectReviewPickerValue } from './project-details-presentation';
import { normalizeProjectTag } from './project-tags';
import { revisionOf } from './native-request-receipts';
import { useTaskStore } from './store';

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
    | { kind: 'deleteUndo'; deleteRequestId: string });
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
}) {
    const call = async (name: string, input: unknown): Promise<Reply> => {
        const port = deps.contract();
        return await (port[name] as (value: unknown) => Reply | Promise<Reply>).call(port, input);
    };
    const token = (options: Json): Json => {
        const { id: _id, ...expected } = options.project as Json;
        return expected;
    };
    type Plan = { outcome: 'unchanged' | 'blocked' } | { command: string; request: Json } | { conflict: string };
    // The Deletes this process confirmed, by request UUID: their Undo needs the confirmed Delete. RN's Undo lives as long as its
    // toast and is gone after a restart; these are gone after a restart too.
    const deletes = new Map<string, Json>();

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
                if (edit.kind === 'duplicate') return { ok: true, value: { command: 'ProjectDuplicate', request } };
                const done = edit.action === 'reactivate' ? current.status !== 'archived'
                    : current.status === 'archived' && Boolean(current.cancelledAt) === (edit.action === 'cancel');
                return { ok: true, value: done ? { outcome: 'unchanged' } : { command: 'ProjectLifecycle', request: { ...request, action: edit.action } } };
            }
        }
    };

    return {
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
            for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
                const planned = await plan(input);
                if (!planned.ok) {
                    if (planned.error.code !== 'STALE_REVISION') return planned;
                    stale = planned.error.message;
                    continue;
                }
                const step = planned.value;
                if ('conflict' in step) return fail('STALE_REVISION', step.conflict);
                if ('outcome' in step) {
                    const saved = await deps.save();
                    return saved.ok ? { ok: true, value: answer(step.outcome) } : saved;
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
                const committed = await call(`commitPrepared${step.command}`, { request: step.request, prepared: prepared.value.prepared });
                if (committed.ok && step.command === 'ProjectDelete') {
                    deletes.set(input.requestId, { request: step.request, prepared: prepared.value.prepared });
                    if (deletes.size > 20) deletes.delete(deletes.keys().next().value as string);
                }
                if (committed.ok) return { ok: true, value: ['duplicate', 'delete'].includes(input.kind) ? { ...answer('saved'), reply: committed.value } : answer('saved') };
                if (committed.error.code !== 'STALE_REVISION') return committed;
                stale = committed.error.message;
            }
            return fail('STALE_REVISION', stale);
        },
    };
}
