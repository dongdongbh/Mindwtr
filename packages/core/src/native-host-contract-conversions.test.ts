import { afterEach, describe, expect, it } from 'vitest';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import type { NativeTaskPromotionEnvelope, NativeTaskPromotionRequest } from './native-host-contract-task-promote';
import type { NativeProjectToSectionEnvelope, NativeProjectToSectionRequest } from './native-host-contract-project-to-section';
import { revisionOf, taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Section, Task } from './types';

const at = '2026-10-01T12:00:00.000Z';
const promoteId = '00000000-0000-4000-8000-000000001355';
const undoId = '00000000-0000-4000-8000-000000001356';
const convertId = '00000000-0000-4000-8000-000000001324';
const convertUndoId = '00000000-0000-4000-8000-000000001325';
const task = (id: string, patch: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', tags: [], contexts: [], createdAt: at, updatedAt: at, rev: 1, revBy: 'prior', ...patch,
});
const project = (id: string, patch: Partial<Project> = {}): Project => ({
    id, title: id, color: '#445566', order: 0, status: 'active', tagIds: [],
    createdAt: at, updatedAt: at, rev: 1, revBy: 'prior', ...patch,
});
const unwrap = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function open(options: { tasks?: Task[]; projects?: Project[]; sections?: Section[];
    settings?: AppData['settings'] } = {}) {
    await flushPendingSave();
    resetForTests();
    let data: AppData = { tasks: options.tasks ?? [], projects: options.projects ?? [],
        sections: options.sections ?? [], areas: [], people: [], settings: options.settings ?? { deviceId: 'native-device' } };
    let saves = 0;
    let failing = false;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (failing) throw new Error('Injected save failure');
        data = clone(next);
        saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false,
        editLockCount: 0, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
    expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    return { host, saved: () => data, saves: () => saves, failSaves: (value: boolean) => { failing = value; } };
}

afterEach(async () => { await flushPendingSave(); resetForTests(); });

const checklistTask = (patch: Partial<Task> = {}) => task('source', { title: 'Plan trip', description: 'Notes',
    contexts: ['@home'], checklist: [
        { id: 'one', title: 'Book flight', isCompleted: true },
        { id: 'two', title: 'Pack', isCompleted: false },
        { id: 'three', title: 'Leave', isCompleted: false },
    ], ...patch });
const promoteRequest = (title = 'Trip'): NativeTaskPromotionRequest & { expandChecklist: true } => ({
    requestId: promoteId, taskId: 'source', title, expandChecklist: true,
    taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('source')!),
});
const promote = (host: ReturnType<typeof createNativeHostContract>, request = promoteRequest()): NativeTaskPromotionEnvelope =>
    ({ request, prepared: unwrap(host.prepareTaskPromotion(request)).prepared });

describe('native checklist project conversion (UI-17)', () => {
    it('reports the shared block reason for the saved task', async () => {
        const { host } = await open({ tasks: [checklistTask({ recurrence: 'daily' })] });
        const revision = taskRevisionOf(useTaskStore.getState()._tasksById.get('source')!);
        expect(unwrap(host.getTaskPromotionOptions({ taskId: 'source', taskRevision: revision })).blockedMessage)
            .toContain('remove recurrence');
        const clean = await open({ tasks: [checklistTask()] });
        expect(unwrap(clean.host.getTaskPromotionOptions({ taskId: 'source',
            taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('source')!) })))
            .toEqual({ blockedMessage: null });
        expect(clean.host.getTaskPromotionOptions({ taskId: 'source', taskRevision: 'stale' }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('expands the checklist in order with checked state, replays once and undoes exactly', async () => {
        const { host, saved, saves } = await open({ tasks: [checklistTask()] });
        const before = saves();
        const envelope = promote(host);
        expect(saves()).toBe(before);
        expect(envelope.prepared.version).toBe(2);
        expect(unwrap(host.validatePreparedTaskPromotion(envelope))).toEqual({ id: promoteId, reused: false });
        expect(unwrap(await host.commitPreparedTaskPromotion(envelope))).toEqual({ id: promoteId, reused: false });
        const generated = saved().tasks.filter((row) => row.projectId === promoteId);
        expect(generated.map((row) => [row.title, row.status])).toEqual([
            ['Book flight', 'done'], ['Pack', 'next'], ['Leave', 'next']]);
        expect(generated.map((row) => row.order)).toEqual([0, 1, 2]);
        expect(generated.every((row) => row.contexts.includes('@home'))).toBe(true);
        expect(saved().projects.find((row) => row.id === promoteId)).toMatchObject({ title: 'Trip', supportNotes: 'Notes' });
        expect(saved().tasks.find((row) => row.id === 'source')?.deletedAt).toBeTruthy();
        const converted = clone(saved());
        const replaySaves = saves();
        expect(unwrap(await host.commitPreparedTaskPromotion(clone(envelope)))).toEqual({ id: promoteId, reused: false });
        expect(saves()).toBe(replaySaves);
        expect(saved()).toEqual(converted);

        const undoRequest = { requestId: undoId, promoteRequestId: promoteId };
        const undo = { request: undoRequest, prepared: unwrap(host.prepareTaskPromotionUndo({ request: undoRequest, promote: envelope })).prepared };
        expect(unwrap(host.validatePreparedTaskPromotionUndo(undo))).toEqual({ id: 'source' });
        expect(unwrap(await host.commitPreparedTaskPromotionUndo(undo))).toEqual({ id: 'source' });
        const restored = saved().tasks.find((row) => row.id === 'source')!;
        expect(restored.deletedAt).toBeUndefined();
        expect(restored.checklist).toEqual(checklistTask().checklist);
        expect(saved().projects.find((row) => row.id === promoteId)?.deletedAt).toBeTruthy();
        expect(saved().tasks.filter((row) => row.projectId === promoteId)).toEqual([]);
        const undone = clone(saved());
        expect(unwrap(await host.commitPreparedTaskPromotionUndo(clone(undo)))).toEqual({ id: 'source' });
        expect(saved()).toEqual(undone);
    });

    it('refuses blocked, forged and mismatched journals before writing', async () => {
        const blocked = await open({ tasks: [checklistTask({ assignedTo: 'Sam' })] });
        expect(blocked.host.prepareTaskPromotion(promoteRequest()))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('assignee') } });
        const { host, saves } = await open({ tasks: [checklistTask()] });
        const envelope = promote(host);
        const before = saves();
        const reordered = clone(envelope) as { request: NativeTaskPromotionRequest; prepared: { conversion: { tasks: Task[] } } };
        reordered.prepared.conversion.tasks.reverse();
        expect(host.validatePreparedTaskPromotion(reordered as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.commitPreparedTaskPromotion(reordered as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const optedOut = { ...clone(envelope), request: { ...envelope.request, expandChecklist: undefined } };
        expect(host.validatePreparedTaskPromotion(JSON.parse(JSON.stringify(optedOut))))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.prepareTaskPromotionUndo({ request: { requestId: undoId, promoteRequestId: undoId }, promote: envelope }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(before);
    });

    it('keeps the original task when the source changed and retries an interrupted save once', async () => {
        const changed = await open({ tasks: [checklistTask()] });
        const stale = promote(changed.host);
        const edited = { ...useTaskStore.getState()._tasksById.get('source')!, title: 'Edited elsewhere' };
        useTaskStore.setState({ _allTasks: [edited], _tasksById: new Map([[edited.id, edited]]) });
        expect(await changed.host.commitPreparedTaskPromotion(stale)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(useTaskStore.getState()._allProjects).toEqual([]);

        const { host, saved, failSaves } = await open({ tasks: [checklistTask()] });
        const envelope = promote(host);
        failSaves(true);
        expect(await host.commitPreparedTaskPromotion(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(saved().projects).toEqual([]);
        failSaves(false);
        expect(unwrap(await host.commitPreparedTaskPromotion(clone(envelope)))).toEqual({ id: promoteId, reused: false });
        expect(saved().projects.filter((row) => row.id === promoteId)).toHaveLength(1);
        expect(saved().tasks.filter((row) => row.projectId === promoteId)).toHaveLength(3);
    });

    it('still replays a version 1 move journal without the opt-in field', async () => {
        const { host, saved } = await open({ tasks: [checklistTask()] });
        const request = { requestId: promoteId, taskId: 'source', title: 'Trip',
            taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('source')!) };
        const prepared = unwrap(host.prepareTaskPromotion(request)).prepared;
        expect(prepared.version).toBe(1);
        expect(unwrap(await host.commitPreparedTaskPromotion({ request, prepared }))).toEqual({ id: promoteId, reused: false });
        expect(saved().tasks.find((row) => row.id === 'source')).toMatchObject({ projectId: promoteId });
        expect(saved().tasks.find((row) => row.id === 'source')?.checklist).toHaveLength(3);
    });
});

const destinationRevision = (id: string) => revisionOf(useTaskStore.getState()._projectsById.get(id)!);
const convertRequest = (patch: Partial<NativeProjectToSectionRequest> = {}): NativeProjectToSectionRequest => ({
    requestId: convertId, projectId: 'source', projectRevision: destinationRevision('source'),
    destinationProjectId: 'destination', destinationRevision: destinationRevision('destination'), title: 'Moved', ...patch,
});
const convert = (host: ReturnType<typeof createNativeHostContract>, request = convertRequest()): NativeProjectToSectionEnvelope =>
    ({ request, prepared: unwrap(host.prepareProjectToSection(request)).prepared });
const sectionFixture = (sourcePatch: Partial<Project> = {}, destinationPatch: Partial<Project> = {}) => ({
    projects: [project('source', { title: 'Source', supportNotes: 'Notes', ...sourcePatch }),
        project('destination', { title: 'Destination', ...destinationPatch }),
        project('sequential', { title: 'Sequential', isSequential: true })],
    tasks: [task('b', { projectId: 'source', order: 1 }), task('a', { projectId: 'source', order: 0, status: 'done', completedAt: new Date().toISOString() }),
        task('kept', { projectId: 'destination', order: 0 })],
});

describe('native project to section conversion (UI-18)', () => {
    it('previews eligible destinations without writing', async () => {
        const { host, saves } = await open(sectionFixture());
        const before = saves();
        const options = unwrap(host.getProjectToSectionConversionOptions({ projectId: 'source', projectRevision: destinationRevision('source') }));
        expect(saves()).toBe(before);
        expect(options).toMatchObject({ blockedMessage: null, sequentialMessage: null,
            notesMessage: 'Project notes become section notes.', defaultTitle: 'Source' });
        expect(options.destinations.map((row) => row.id)).toEqual(['destination']);
        expect(options.destinations[0]).toMatchObject({ summary: 'Move 2 tasks (1 done, 0 archived) from Source into Destination.',
            areaLine: 'Moved tasks use the destination Area: No area.', revision: destinationRevision('destination') });
        const blocked = await open(sectionFixture({ tagIds: ['#tag'] }));
        expect(unwrap(blocked.host.getProjectToSectionConversionOptions({ projectId: 'source', projectRevision: destinationRevision('source') })))
            .toMatchObject({ blockedMessage: 'Remove this project’s tags first.', destinations: [] });
    });

    it('converts in project order, replays once and undoes the same tasks and section', async () => {
        const { host, saved, saves } = await open(sectionFixture());
        const envelope = convert(host);
        expect(unwrap(host.validatePreparedProjectToSection(envelope))).toMatchObject({ sectionId: convertId, destinationProjectId: 'destination' });
        expect(unwrap(await host.commitPreparedProjectToSection(envelope))).toMatchObject({ sectionId: convertId,
            message: 'Project converted to section.', undoLabel: 'Undo' });
        const moved = saved().tasks.filter((row) => row.sectionId === convertId).sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
        expect(moved.map((row) => row.id)).toEqual(['a', 'b']);
        expect(moved.every((row) => row.projectId === 'destination')).toBe(true);
        expect(saved().sections.find((row) => row.id === convertId)).toMatchObject({ projectId: 'destination', title: 'Moved', description: 'Notes' });
        expect(saved().projects.find((row) => row.id === 'source')?.deletedAt).toBeTruthy();
        const converted = clone(saved());
        const replaySaves = saves();
        expect(unwrap(await host.commitPreparedProjectToSection(clone(envelope)))).toMatchObject({ sectionId: convertId });
        expect(saves()).toBe(replaySaves);
        expect(saved()).toEqual(converted);

        const request = { requestId: convertUndoId, convertRequestId: convertId };
        const undo = { request, prepared: unwrap(host.prepareProjectToSectionUndo({ request, convert: envelope })).prepared };
        expect(unwrap(await host.commitPreparedProjectToSectionUndo(undo))).toEqual({ id: 'source' });
        expect(saved().projects.find((row) => row.id === 'source')?.deletedAt).toBeUndefined();
        expect(saved().sections.find((row) => row.id === convertId)?.deletedAt).toBeTruthy();
        expect(saved().tasks.filter((row) => row.projectId === 'source').map((row) => [row.id, row.order]).sort())
            .toEqual([['a', 0], ['b', 1]]);
        expect(saved().tasks.find((row) => row.id === 'kept')).toMatchObject({ projectId: 'destination', order: 0 });
        const undone = clone(saved());
        expect(unwrap(await host.commitPreparedProjectToSectionUndo(clone(undo)))).toEqual({ id: 'source' });
        expect(saved()).toEqual(undone);
    });

    it('keeps a sequential source as a sequential section in a Per section destination', async () => {
        const { host, saved } = await open(sectionFixture({ isSequential: true }, { perSectionFlow: true }));
        const options = unwrap(host.getProjectToSectionConversionOptions({ projectId: 'source', projectRevision: destinationRevision('source') }));
        expect(options.sequentialMessage).toContain('Within sections');
        expect(options.destinations.map((row) => row.id)).toEqual(['destination']);
        unwrap(await host.commitPreparedProjectToSection(convert(host)));
        expect(saved().sections.find((row) => row.id === convertId)?.isSequential).toBe(true);
    });

    it('refuses a stale destination at preview, before and after preparation', async () => {
        const { host, saves } = await open(sectionFixture());
        expect(host.prepareProjectToSection(convertRequest({ destinationRevision: 'stale' })))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const envelope = convert(host);
        const renamed = { ...useTaskStore.getState()._projectsById.get('destination')!, title: 'Renamed', rev: 2 };
        useTaskStore.setState({ _allProjects: useTaskStore.getState()._allProjects.map((row) => row.id === renamed.id ? renamed : row),
            _projectsById: new Map(useTaskStore.getState()._allProjects.map((row) => [row.id, row.id === renamed.id ? renamed : row])) });
        const before = saves();
        expect(await host.commitPreparedProjectToSection(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(before);
        expect(useTaskStore.getState()._allSections).toEqual([]);
    });

    it('rejects a forged journal and retries an interrupted save without a second section', async () => {
        const { host, saved, failSaves } = await open(sectionFixture());
        const envelope = convert(host);
        const forged = clone(envelope);
        forged.prepared.command.tasks.reverse();
        expect(host.validatePreparedProjectToSection(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        failSaves(true);
        expect(await host.commitPreparedProjectToSection(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(saved().sections).toEqual([]);
        failSaves(false);
        unwrap(await host.commitPreparedProjectToSection(clone(envelope)));
        expect(saved().sections.filter((row) => row.id === convertId)).toHaveLength(1);
        expect(saved().tasks.filter((row) => row.sectionId === convertId)).toHaveLength(2);
    });
});
