import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectSectionDeleteMethods, type NativePreparedProjectSectionDelete,
    type NativeProjectSectionDeleteRequest } from './native-host-contract-project-section-delete';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { sameTaskSqliteRow } from './store-projects/section-actions';
import type { AppData, Project, Section, Task } from './types';

const NOW = '2026-09-28T16:00:00.000Z';
const ID = '3fb34adb-9bf8-451f-8f7f-7964b6a0de9b';
const project = (id = 'parent', overrides: Partial<Project> = {}): Project => ({
    id, title: 'Project', status: 'active', color: '#3b82f6', order: 0, tagIds: ['#work'],
    rev: 3, revBy: 'old-device', createdAt: NOW, updatedAt: NOW, ...overrides,
});
const section = (id = 'target', overrides: Partial<Section> = {}): Section => ({
    id, projectId: 'parent', title: 'Section', description: 'Keep raw details', order: 2,
    isCollapsed: true, rev: 4, revBy: 'old-device', createdAt: NOW, updatedAt: NOW, ...overrides,
});
const task = (id: string, overrides: Partial<Task> = {}): Task => ({
    id, projectId: 'parent', sectionId: 'target', title: id, status: 'next', tags: [], contexts: [],
    rev: 2, revBy: 'old-device', createdAt: NOW, updatedAt: NOW, ...overrides,
});
const swiftJsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, part) =>
    part && typeof part === 'object' && !Array.isArray(part)
        ? Object.fromEntries(Object.entries(part).sort(([left], [right]) => left.localeCompare(right)))
        : part)) as T;

async function open(initial: Partial<AppData> = {}, failing?: () => boolean) {
    await flushPendingSave(); resetForTests();
    let data: AppData = { tasks: [task('live'), task('deleted', { deletedAt: NOW }),
        task('wrong-project', { projectId: 'other' }), task('unrelated', { sectionId: 'sibling' })],
    projects: [project(), project('other')], sections: [section(), section('sibling')],
    areas: [], people: [], settings: { deviceId: 'delete-device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (failing?.()) throw new Error('disk unavailable');
        data = structuredClone(next); saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const methods = createProjectSectionDeleteMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        }, revision: () => 'stable-revision' });
    const request = (): NativeProjectSectionDeleteRequest => {
        const options = methods.getProjectSectionDeleteOptions({ projectId: 'parent', sectionId: 'target' });
        if (!options.ok) throw new Error(JSON.stringify(options.error));
        return { requestId: ID, projectId: 'parent', sectionId: 'target', expected: options.value.token };
    };
    const prepare = (input = request()): NativePreparedProjectSectionDelete => {
        const outcome = methods.prepareProjectSectionDelete(input);
        if (!outcome.ok || outcome.value.kind !== 'prepared') throw new Error(JSON.stringify(outcome));
        return outcome.value.prepared;
    };
    return { methods, request, prepare, data: () => data, saves: () => saves };
}

afterEach(async () => { vi.useRealTimers(); await flushPendingSave(); resetForTests(); });

describe('prepared native Project Section delete', () => {
    it('accepts Swift-sorted JSON keys without accepting changed JSON values or array order', async () => {
        const attachments = [
            { id: 'first', kind: 'file' as const, title: 'First', uri: 'file:///first',
                createdAt: NOW, updatedAt: NOW },
            { id: 'second', kind: 'link' as const, title: 'Second', uri: 'https://example.test/',
                createdAt: NOW, updatedAt: NOW },
        ];
        const original = task('rich', { attachments });
        const nullable = structuredClone(original);
        (nullable.attachments![0] as typeof nullable.attachments![number] & { mimeType: null }).mimeType = null;
        expect(sameTaskSqliteRow(original, swiftJsonRoundTrip(original))).toBe(true);
        expect(sameTaskSqliteRow(original, nullable)).toBe(false);
        expect(sameTaskSqliteRow(original, { ...original, attachments: [...attachments].reverse() })).toBe(false);

        const applied = await open({ tasks: [original] });
        const request = applied.request();
        const prepared = swiftJsonRoundTrip(applied.prepare(request));
        expect(await applied.methods.commitPreparedProjectSectionDelete({ request, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(await applied.methods.commitPreparedProjectSectionDelete({ request, prepared }))
            .toEqual({ ok: true, value: prepared.result });

        const changed = await open({ tasks: [original] });
        const changedRequest = changed.request();
        const changedPrepared = swiftJsonRoundTrip(changed.prepare(changedRequest));
        useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((row) => row.id === original.id
            ? { ...row, attachments: [...attachments].reverse() } : row) }));
        expect(await changed.methods.commitPreparedProjectSectionDelete({
            request: changedRequest, prepared: changedPrepared,
        })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('commits and replays a complete Swift sorted-key journal with rich nested rows', async () => {
        const attachment = { id: 'file', kind: 'file' as const, title: 'Keep attachment',
            uri: 'file:///retained.txt', createdAt: NOW, updatedAt: NOW };
        const originalProject = project('parent', { attachments: [attachment] });
        const secondAttachment = { ...attachment, id: 'second', title: 'Keep second' };
        const originalTask = task('live', { attachments: [attachment, secondAttachment],
            checklist: [{ id: 'step', title: 'Keep checklist', isCompleted: false }],
            reviewAt: null as never });
        const { methods, request, prepare, data, saves } = await open({
            projects: [originalProject], tasks: [originalTask],
        });
        const input = request();
        const planned = prepare(input);


        const swiftRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, part) =>
            part && typeof part === 'object' && !Array.isArray(part)
                ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b)))
                : part)) as T;
        const command = swiftRoundTrip({ request: input, prepared: planned });
        expect(methods.validatePreparedProjectSectionDelete(command))
            .toEqual({ ok: true, value: planned.result });
        const baselineTasks = useTaskStore.getState()._allTasks;
        useTaskStore.setState({ _allTasks: [{ ...originalTask,
            attachments: [secondAttachment, attachment] }] });
        expect(await methods.commitPreparedProjectSectionDelete(command))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allTasks: [{ ...originalTask, reviewAt: undefined }] });
        expect(await methods.commitPreparedProjectSectionDelete(command))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allTasks: baselineTasks });
        expect(await methods.commitPreparedProjectSectionDelete(command))
            .toEqual({ ok: true, value: planned.result });
        expect(data().projects[0]).toEqual(originalProject);
        expect(data().tasks[0].attachments).toEqual(originalTask.attachments);
        expect(data().tasks[0].checklist).toEqual(originalTask.checklist);
        expect(data().tasks[0].reviewAt).toBeNull();
        expect(data().tasks[0].sectionId).toBeUndefined();
        const count = saves();
        expect(await methods.commitPreparedProjectSectionDelete(command))
            .toEqual({ ok: true, value: planned.result });
        expect(saves()).toBe(count);
    });

    it('matches RN tombstone and detaches every linked Task, including deleted and wrong-project rows', async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
        const { request, prepare } = await open();

        useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((row) => row.id === 'wrong-project'
            ? { ...row, sectionId: 'target' } : row) }));
        const input = request();
        const planned = prepare(input);
        expect(planned.effect.tasks.map((row) => row.before.id)).toEqual(['live', 'deleted', 'wrong-project']);
        expect((await useTaskStore.getState().deleteSection('target')).success).toBe(true);
        const rn = useTaskStore.getState();
        expect(rn._allSections.find((row) => row.id === 'target')).toEqual(planned.effect.section.after);
        for (const pair of planned.effect.tasks) {
            expect(rn._allTasks.find((row) => row.id === pair.before.id)).toEqual(pair.after);
            expect(pair.after.sectionId).toBeUndefined();
        }
        const native = await open();
        useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((row) => row.id === 'wrong-project'
            ? { ...row, sectionId: 'target' } : row) }));
        const nativePlanned = native.prepare(input);
        const before = useTaskStore.getState();
        const unaffected = { projects: structuredClone(before._allProjects),
            sibling: structuredClone(before._allSections.find((row) => row.id === 'sibling')),
            task: structuredClone(before._allTasks.find((row) => row.id === 'unrelated')) };
        expect(await native.methods.commitPreparedProjectSectionDelete({ request: input, prepared: nativePlanned }))
            .toEqual({ ok: true, value: { id: 'target', projectId: 'parent' } });
        expect(native.data().sections.find((row) => row.id === 'target')).toEqual(nativePlanned.effect.section.after);
        expect(native.data().projects).toEqual(unaffected.projects);
        expect(native.data().sections.find((row) => row.id === 'sibling')).toEqual(unaffected.sibling);
        expect(native.data().tasks.find((row) => row.id === 'unrelated')).toEqual(unaffected.task);
        expect(native.saves()).toBe(1);
    });

    it('recognizes only complete Section and Task receipts before later parent or scope changes', async () => {
        const { methods, request, prepare, saves } = await open();
        const input = request();
        const planned = prepare(input);
        expect(await methods.commitPreparedProjectSectionDelete({ request: input, prepared: planned }))
            .toMatchObject({ ok: true });
        const count = saves();
        useTaskStore.setState((state) => ({ _allProjects: [project('parent', { status: 'archived', deletedAt: NOW })],
            _allTasks: [...state._allTasks, task('later')] }));
        expect(await methods.commitPreparedProjectSectionDelete({ request: input, prepared: planned }))
            .toEqual({ ok: true, value: planned.result });
        expect(saves()).toBe(count);
        useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((row) => row.id === 'deleted'
            ? { ...row, rev: 99 } : row) }));
        expect(await methods.commitPreparedProjectSectionDelete({ request: input, prepared: planned }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((row) => row.id === 'deleted'
            ? planned.effect.tasks.find((pair) => pair.before.id === 'deleted')!.after : row),
        _allSections: state._allSections.map((row) => row.id === 'target' ? { ...row, rev: 99 } : row) }));
        expect(await methods.commitPreparedProjectSectionDelete({ request: input, prepared: planned }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(count);
    });

    it('requires exact live parent, Section, and complete linked Task scope before first apply', async () => {
        const { methods, request, prepare, saves } = await open();
        const input = request();
        const planned = prepare(input);
        const baseline = useTaskStore.getState();
        const conflicts: Array<() => void> = [
            () => useTaskStore.setState({ _allProjects: [project('parent', { title: 'Changed' }), project('other')] }),
            () => useTaskStore.setState({ _allProjects: [project('parent', { startDate: null as never }),
                project('other')] }),
            () => useTaskStore.setState({ _allProjects: [project('parent', { status: 'archived' }), project('other')] }),
            () => useTaskStore.setState({ _allProjects: [project('parent', { deletedAt: NOW }), project('other')] }),
            () => useTaskStore.setState({ _allSections: [section('target', { description: 'Changed' }), section('sibling')] }),
            () => useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((row) => row.id === 'live'
                ? { ...row, title: 'Changed' } : row) })),
            () => useTaskStore.setState((state) => ({ _allTasks: [...state._allTasks, task('later')] })),
            () => useTaskStore.setState((state) => ({ _allTasks: state._allTasks.filter((row) => row.id !== 'deleted') })),
            () => useTaskStore.setState({ settings: { deviceId: 'other-device' } }),
        ];
        for (const conflict of conflicts) {
            useTaskStore.setState({ _allProjects: baseline._allProjects,
                _allSections: baseline._allSections, _allTasks: baseline._allTasks, settings: baseline.settings });
            conflict();
            expect(await methods.commitPreparedProjectSectionDelete({ request: input, prepared: planned }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        expect(saves()).toBe(0);
    });

    it('reads archived history without writes; unavailable targets and malformed requests are refused', async () => {
        const archivedAt = '2026-09-20T00:00:00.000Z';
        const { methods, saves } = await open({ projects: [project('parent', { status: 'archived' })],
            sections: [section('target', { deletedAt: archivedAt, projectArchivedAt: archivedAt })] });
        const options = methods.getProjectSectionDeleteOptions({ projectId: 'parent', sectionId: 'target' });
        expect(options).toMatchObject({ ok: true, value: { revision: 'stable-revision',
            project: { id: 'parent', status: 'archived' }, section: { id: 'target', title: 'Section' },
            canDelete: false, token: { deletedAt: archivedAt, projectArchivedAt: archivedAt } } });
        if (!options.ok) throw new Error('read failed');
        const request = { requestId: ID, projectId: 'parent', sectionId: 'target', expected: options.value.token };
        expect(methods.prepareProjectSectionDelete(request))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(methods.probeProjectSectionDeleteOutcome(request))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(methods.getProjectSectionDeleteOptions({ projectId: 'other', sectionId: 'target' }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(methods.prepareProjectSectionDelete({ ...request, requestId: ID.toUpperCase() }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(0);
    });

    it('preserves RN already-deleted no-op and missing-target failure', async () => {
        const { saves } = await open({ sections: [section('target', { deletedAt: NOW }), section('sibling')] });
        const before = structuredClone(useTaskStore.getState()._allTasks);
        expect(await useTaskStore.getState().deleteSection('target')).toEqual({ success: true });
        expect(useTaskStore.getState()._allTasks).toEqual(before);
        expect(await useTaskStore.getState().deleteSection('absent'))
            .toMatchObject({ success: false, error: 'Section not found' });
        expect(saves()).toBe(0);
    });

    it('keeps raw optional null fields while deleting; empty scope is a Section-only tombstone', async () => {
        const rawParent = project('parent', { startDate: null as never });
        const rawSection = section('target', { description: null as never, isCollapsed: null as never });
        const rawTask = task('raw', { reviewAt: null as never, deletedAt: null as never });
        const { methods, request, prepare, data } = await open({ projects: [rawParent],
            sections: [rawSection], tasks: [rawTask] });
        useTaskStore.setState({ _allProjects: [rawParent], _allSections: [rawSection], _allTasks: [rawTask] });
        const input = request();
        const planned = prepare(input);
        expect(methods.validatePreparedProjectSectionDelete({ request: input, prepared: planned }))
            .toEqual({ ok: true, value: planned.result });
        expect(await methods.commitPreparedProjectSectionDelete({ request: input, prepared: planned }))
            .toMatchObject({ ok: true });
        expect(data().sections[0].description).toBeNull();
        expect(data().tasks[0].reviewAt).toBeNull();
        expect(data().tasks[0].deletedAt).toBeNull();
        expect(data().projects[0]).toEqual(rawParent);
        const empty = await open({ tasks: [] });
        const emptyPlanned = empty.prepare();
        expect(emptyPlanned.effect.tasks).toEqual([]);
        expect(await empty.methods.commitPreparedProjectSectionDelete({ request: empty.request(),
            prepared: emptyPlanned })).toMatchObject({ ok: true });
        expect(empty.data().tasks).toEqual([]);
    });

    it('retains exact prepared rows and missing-device initialization through failed save and retry', async () => {
        let failed = true;
        const { methods, request, prepare, data, saves } = await open({ settings: {} }, () => failed);
        useTaskStore.setState({ settings: {} });
        const input = request();
        const planned = prepare(input);
        expect(planned.deviceIdBefore).toBeNull();
        expect(planned.deviceIdToInitialize).toBeTruthy();
        expect(await methods.commitPreparedProjectSectionDelete({ request: input, prepared: planned }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(data().sections.find((row) => row.id === 'target')?.deletedAt).toBeUndefined();
        failed = false;
        expect(await methods.commitPreparedProjectSectionDelete({ request: input, prepared: planned }))
            .toEqual({ ok: true, value: planned.result });
        expect(data().sections.find((row) => row.id === 'target')).toEqual(planned.effect.section.after);
        expect(data().settings.deviceId).toBe(planned.deviceIdToInitialize);
        const count = saves();
        useTaskStore.setState({ settings: {} });
        expect(await methods.commitPreparedProjectSectionDelete({ request: input, prepared: planned }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(count);
    });

    it('rejects omitted, duplicate, forged, and malformed cold journal rows before storage', async () => {
        const { methods, request, prepare, saves } = await open();
        const input = request();
        const planned = prepare(input);
        const mutations: Array<(value: NativePreparedProjectSectionDelete) => void> = [
            (p) => { p.version = 2 as never; },
            (p) => { p.request.sectionId = 'other'; },
            (p) => { p.result.projectId = 'other'; },
            (p) => { p.scope.project.status = 'archived'; },
            (p) => { p.scope.section.title = 'Forged'; },
            (p) => { p.effect.tasks.pop(); },
            (p) => { p.scope.tasks.push(structuredClone(p.scope.tasks[0]));
                p.effect.tasks.push(structuredClone(p.effect.tasks[0])); },
            (p) => { p.effect.section.after.rev = 99; },
            (p) => { p.effect.section.after.deletedAt = 'not a timestamp'; },
            (p) => { p.effect.tasks[0].after.title = 'Forged'; },
            (p) => { p.effect.tasks[0].after.sectionId = 'target'; },
            (p) => { p.effect.tasks[0].after.updatedAt = '2020-01-01T00:00:00.000Z'; },
            (p) => { p.preparedAt = 'not a timestamp'; },
            (p) => { (p.effect.tasks[0].after as Task & { extra?: string }).extra = 'forged'; },
        ];
        for (const mutate of mutations) {
            const forged = structuredClone(planned);
            mutate(forged);
            expect(methods.validatePreparedProjectSectionDelete({ request: input, prepared: forged }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(methods.validatePreparedProjectSectionDelete({ request: input, prepared: planned }))
            .toEqual({ ok: true, value: planned.result });
        const omittedFromBoth = structuredClone(planned);
        omittedFromBoth.scope.tasks.pop();
        omittedFromBoth.effect.tasks.pop();
        expect(await methods.commitPreparedProjectSectionDelete({ request: input, prepared: omittedFromBoth }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(methods.probeProjectSectionDeleteOutcome(input))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });

    it('refuses oversized full journal instead of omitting linked Tasks', async () => {
        const { methods, request, saves } = await open({ tasks: [task('large', {
            description: 'x'.repeat(2_100_000) })] });
        expect(methods.prepareProjectSectionDelete(request()))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(0);
    });
});
