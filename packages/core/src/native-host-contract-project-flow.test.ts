import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectFlowMethods, type NativeProjectFlowRequest } from './native-host-contract-project-flow';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { PROJECT_SQLITE_COLUMNS, projectToSqliteRow } from './project-sync-schema';
import type { AppData, Project, ProjectFlowMode, Section, Task } from './types';

const now = '2026-09-28T15:00:00.000Z';
const project = (id = 'target', overrides: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#3b82f6', order: 0, tagIds: ['#work'],
    rev: 3, revBy: 'old-device', createdAt: now, updatedAt: now, ...overrides,
});
const task = (): Task => ({ id: 'linked-task', title: 'Keep task text', status: 'next', projectId: 'target',
    tags: ['#work'], contexts: ['@home'], rev: 5, revBy: 'old-device', createdAt: now, updatedAt: now });
const section = (): Section => ({ id: 'linked-section', projectId: 'target', title: 'Keep section text',
    order: 0, rev: 2, revBy: 'old-device', createdAt: now, updatedAt: now });
const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortKeys(nested)])) : value;

async function open(initial: Partial<AppData> = {}, fail?: () => boolean) {
    await flushPendingSave(); resetForTests();
    let data: AppData = { tasks: [], projects: [project()], sections: [], areas: [], people: [],
        settings: { deviceId: 'flow-device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (fail?.()) throw new Error('disk unavailable');
        data = structuredClone(next); saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const methods = createProjectFlowMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        }, revision: () => 'revision' });
    const request = <Action extends NativeProjectFlowRequest['action']>(action: Action): NativeProjectFlowRequest & { action: Action } => {
        const options = methods.getProjectFlowOptions({ projectId: 'target' });
        if (!options.ok) throw new Error(JSON.stringify(options.error));
        const { id: _id, ...expected } = options.value.project;
        return { requestId: '73799899-d143-40c1-84bd-a09172bba5a4', projectId: 'target', action, expected };
    };
    const sectionRequest = (sequential: boolean, sectionId = 'linked-section') => {
        const options = methods.getProjectSectionFlowOptions({ projectId: 'target' });
        if (!options.ok) throw new Error(JSON.stringify(options.error));
        const row = options.value.sections.find((row) => row.id === sectionId);
        if (!row) throw new Error('Section flow option is unavailable');
        return request({ kind: 'sectionFlow', sectionId, sequential, expectedSection: row.token });
    };
    return { methods, request, sectionRequest, data: () => data, saves: () => saves };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z')); });
afterEach(async () => { vi.useRealTimers(); await flushPendingSave(); resetForTests(); });

describe('prepared native Project flow', () => {
    it('toggles type while preserving raw scope and all unrelated rows', async () => {
        const original = project('target', { isSequential: false, sequentialScope: 'section' });
        const linkedTask = task();
        const linkedSection = section();
        const other = project('other');
        const { methods, request, data } = await open({ projects: [original, other],
            tasks: [linkedTask], sections: [linkedSection] });
        const tasksBefore = structuredClone(useTaskStore.getState()._allTasks);
        const sectionsBefore = structuredClone(useTaskStore.getState()._allSections);
        const input = request({ kind: 'toggleType' });
        const plan = methods.prepareProjectFlow(input);
        if (!plan.ok) throw new Error(JSON.stringify(plan.error));
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared', prepared: {
            version: 1,
            result: { id: 'target', isSequential: true, sequentialScope: 'section' },
            effect: { project: { after: { isSequential: true, sequentialScope: 'section', rev: 4 } } },
        } } });
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(await methods.commitPreparedProjectFlow({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true, value: { isSequential: true, sequentialScope: 'section' } });
        expect(data().projects[0]).toEqual(plan.value.prepared.effect.project.after);
        expect(data().projects[1]).toEqual(other);
        expect(data().tasks).toEqual(tasksBefore);
        expect(data().sections).toEqual(sectionsBefore);
    });

    it('keeps optional flow fields raw in the token and makes missing scope an explicit Project write', async () => {
        const { methods, request, data, saves } = await open({ projects: [project('target', { isSequential: true })] });
        expect(methods.getProjectFlowOptions({ projectId: 'target' })).toMatchObject({ ok: true,
            value: { project: { isSequential: true, sequentialScope: null }, canChange: true } });
        const input = request({ kind: 'setScope', scope: 'project' });
        const plan = methods.prepareProjectFlow(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared', prepared: {
            result: { isSequential: true, sequentialScope: 'project' } } } });
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(await methods.commitPreparedProjectFlow({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(data().projects[0]).toMatchObject({ isSequential: true, sequentialScope: 'project', rev: 4 });
        expect(methods.prepareProjectFlow(request({ kind: 'setScope', scope: 'project' }))).toEqual({ ok: true,
            value: { kind: 'noop', result: { id: 'target', isSequential: true, sequentialScope: 'project' } } });
        expect(saves()).toBe(1);
    });

    it('blocks scope on parallel and all archived flow changes after checking the frozen token', async () => {
        const { methods, request, saves } = await open({ projects: [project('target')] });
        expect(methods.getProjectFlowOptions({ projectId: 'target' })).toMatchObject({ ok: true,
            value: { project: { isSequential: null, sequentialScope: null }, canChange: true } });
        const stale = request({ kind: 'setScope', scope: 'project' });
        expect(methods.prepareProjectFlow(stale)).toEqual({ ok: true,
            value: { kind: 'blocked', result: { blocked: '' } } });
        useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'target'
            ? { ...row, status: 'archived', rev: 4 } : row) }));
        expect(methods.prepareProjectFlow(stale)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(methods.getProjectFlowOptions({ projectId: 'target' })).toMatchObject({ ok: true,
            value: { canChange: false } });
        expect(methods.prepareProjectFlow(request({ kind: 'toggleType' }))).toEqual({ ok: true,
            value: { kind: 'blocked', result: { blocked: '' } } });
        expect(saves()).toBe(0);
    });

    it('allows waiting and someday changes, and toggle back keeps stored scope', async () => {
        for (const status of ['waiting', 'someday'] as const) {
            const { methods, request, data } = await open({ projects: [project('target', {
                status, isSequential: true, sequentialScope: 'section',
            })] });
            const input = request({ kind: 'toggleType' });
            const plan = methods.prepareProjectFlow(input);
            if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
            expect(await methods.commitPreparedProjectFlow({ request: input, prepared: plan.value.prepared }))
                .toMatchObject({ ok: true, value: { isSequential: false, sequentialScope: 'section' } });
            expect(data().projects[0]).toMatchObject({ status, isSequential: false, sequentialScope: 'section' });
        }
    });

    it('matches RN updateProject final rows for type and scope without touching children', async () => {
        for (const action of [{ kind: 'toggleType' } as const,
            { kind: 'setScope', scope: 'section' } as const]) {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-09-28T16:00:00.000Z'));
            const { methods, request } = await open({ projects: [project('target', {
                status: 'waiting', isSequential: true, sequentialScope: 'project', supportNotes: 'Keep notes',
            })], tasks: [task()], sections: [section()] });
            const input = request(action);
            const plan = methods.prepareProjectFlow(input);
            if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
            const tasksBefore = structuredClone(useTaskStore.getState()._allTasks);
            const sectionsBefore = structuredClone(useTaskStore.getState()._allSections);
            const patch = action.kind === 'toggleType' ? { isSequential: false }
                : { sequentialScope: 'section' as const };
            expect((await useTaskStore.getState().updateProject('target', patch)).success).toBe(true);
            expect(useTaskStore.getState()._allProjects[0]).toEqual(plan.value.prepared.effect.project.after);
            expect(useTaskStore.getState()._allTasks).toEqual(tasksBefore);
            expect(useTaskStore.getState()._allSections).toEqual(sectionsBefore);
            vi.useRealTimers();
        }
    });

    it('accepts Swift sorted-key rich journals, exact receipt replay, and refuses partial changes', async () => {
        const attachment = { id: 'a', kind: 'link' as const, title: 'Source', uri: 'https://example.test/',
            createdAt: now, updatedAt: now };
        const rich = project('target', { isSequential: true, attachments: [attachment, { ...attachment, id: 'b' }],
            supportNotes: 'Keep notes', dueDate: '2026-10-01', areaTitle: 'Work' });
        const attachmentIndex = PROJECT_SQLITE_COLUMNS.indexOf('attachments');
        const attachmentText = projectToSqliteRow(rich)[attachmentIndex];
        const { methods, request, data, saves } = await open({ projects: [rich] });
        const input = request({ kind: 'setScope', scope: 'section' });
        const plan = methods.prepareProjectFlow(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const frozen = JSON.parse(JSON.stringify(sortKeys({ request: input, prepared: plan.value.prepared }))) as
            { request: typeof input; prepared: typeof plan.value.prepared };
        expect(methods.validatePreparedProjectFlow(frozen)).toMatchObject({ ok: true });
        expect(await methods.commitPreparedProjectFlow(frozen)).toMatchObject({ ok: true,
            value: { id: 'target', isSequential: true, sequentialScope: 'section' } });
        expect(projectToSqliteRow(data().projects[0])[attachmentIndex]).toBe(attachmentText);
        expect(data().projects[0]).toMatchObject({ supportNotes: rich.supportNotes, dueDate: rich.dueDate,
            areaTitle: rich.areaTitle, tagIds: rich.tagIds, rev: 4 });
        const count = saves();
        useTaskStore.setState((state) => ({ settings: { ...state.settings, deviceId: 'different-device' },
            _allProjects: [...state._allProjects, project('new')] }));
        expect(await methods.commitPreparedProjectFlow(frozen)).toMatchObject({ ok: true });
        expect(saves()).toBe(count);
        useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'target'
            ? { ...row, supportNotes: 'Later edit' } : row) }));
        expect(await methods.commitPreparedProjectFlow(frozen)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(count);
    });

    it('refuses stale first-apply metadata, archive, and deletion', async () => {
        const original = project('target', { isSequential: true });
        const { methods, request, saves } = await open({ projects: [original] });
        const input = request({ kind: 'setScope', scope: 'section' });
        const plan = methods.prepareProjectFlow(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        for (const changed of [{ ...original, color: '#000000' },
            { ...original, status: 'archived' as const }, { ...original, deletedAt: now }]) {
            useTaskStore.setState({ _allProjects: [changed] });
            expect(await methods.commitPreparedProjectFlow({ request: input, prepared: plan.value.prepared }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        expect(saves()).toBe(0);
    });

    it('retries a failed durable save without toggling twice and initializes a missing device ID atomically', async () => {
        let failed = true;
        const first = await open({ settings: {} }, () => failed);
        useTaskStore.setState({ settings: {} });
        const input = first.request({ kind: 'toggleType' });
        const plan = first.methods.prepareProjectFlow(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(plan.value.prepared.deviceIdBefore).toBeNull();
        const frozen = { request: input, prepared: plan.value.prepared };
        expect(await first.methods.commitPreparedProjectFlow(frozen)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(first.data().projects[0].isSequential).toBeUndefined();
        failed = false;
        expect(await first.methods.commitPreparedProjectFlow(frozen)).toMatchObject({ ok: true,
            value: { isSequential: true, sequentialScope: null } });
        expect(first.data().projects[0]).toMatchObject({ isSequential: true, rev: 4 });
        expect(first.data().settings.deviceId).toBe(plan.value.prepared.deviceIdToInitialize);
        const second = await open(structuredClone(first.data()));
        await flushPendingSave();
        const count = second.saves();
        expect(await second.methods.commitPreparedProjectFlow(frozen)).toMatchObject({ ok: true });
        expect(second.saves()).toBe(count);
    });

    it('rejects malformed, forged and oversized journals; nil-pending probe never writes', async () => {
        const { methods, request, saves } = await open({ projects: [project('target', { isSequential: true })] });
        const input = request({ kind: 'setScope', scope: 'section' });
        const plan = methods.prepareProjectFlow(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const envelope = { request: input, prepared: plan.value.prepared };
        const omitted = structuredClone(envelope);
        (omitted.prepared.scope.project as Partial<Project>).tagIds = undefined;
        expect(methods.validatePreparedProjectFlow(omitted)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const forged = structuredClone(envelope);
        forged.prepared.effect.project.after.color = '#000000';
        expect(methods.validatePreparedProjectFlow(forged)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const wrongResult = structuredClone(envelope);
        wrongResult.prepared.result.isSequential = false;
        expect(methods.validatePreparedProjectFlow(wrongResult)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(methods.prepareProjectFlow({ ...input, action: { kind: 'setScope', scope: 'other' } as never }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.prepareProjectFlow({ ...input, expected: { ...input.expected, isSequential: false } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(methods.probeProjectFlowOutcome(input)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });

    it('refuses a rich Project snapshot over 2 MB UTF-8 before persistence', async () => {
        const { methods, request, saves } = await open({ projects: [project('target', {
            isSequential: true, supportNotes: '漢'.repeat(250_000),
        })] });
        expect(methods.prepareProjectFlow(request({ kind: 'setScope', scope: 'section' })))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(0);
    });

    it('keeps legacy read/token keysets exact and exposes mode only in the separate read', async () => {
        const { methods, request } = await open({ projects: [project('target', { perSectionFlow: true })] });
        const legacy = methods.getProjectFlowOptions({ projectId: 'target' });
        const explicit = methods.getProjectFlowModeOptions({ projectId: 'target' });
        if (!legacy.ok || !explicit.ok) throw new Error('read failed');
        expect(Object.keys(legacy.value).sort()).toEqual(['canChange', 'project', 'revision']);
        expect(Object.keys(legacy.value.project).sort()).toEqual([
            'id', 'isSequential', 'rev', 'revBy', 'sequentialScope', 'status', 'title', 'updatedAt',
        ]);
        expect(Object.keys(request({ kind: 'flowMode', mode: 'parallel' }).expected).sort()).toEqual([
            'isSequential', 'rev', 'revBy', 'sequentialScope', 'status', 'title', 'updatedAt',
        ]);
        expect(explicit.value).toEqual({ ...legacy.value, mode: 'perSection' });
    });

    const modes: ProjectFlowMode[] = ['parallel', 'sequential', 'perSection'];
    for (const from of modes) for (const to of modes) {
        it(`durably changes ${from} to ${to}, preserves choices, and reopens without reapplying`, async () => {
            const initial = project('target', { isSequential: from === 'sequential',
                perSectionFlow: from === 'perSection', sequentialScope: 'section' });
            const missing = section();
            const storedParallel = { ...section(), id: 'stored-parallel', isSequential: false };
            const storedSequential = { ...section(), id: 'stored-sequential', isSequential: true };
            const deleted = { ...section(), id: 'deleted', deletedAt: now };
            const unrelated = { ...section(), id: 'unrelated', projectId: 'other' };
            const first = await open({ projects: [initial, project('other')], tasks: [task()],
                sections: [unrelated, storedSequential, missing, deleted, storedParallel] });
            const before = structuredClone(first.data());
            const tasksBefore = structuredClone(useTaskStore.getState()._allTasks);
            const input = first.request({ kind: 'flowMode', mode: to });
            const plan = first.methods.prepareProjectFlow(input);
            if (!plan.ok) throw new Error(JSON.stringify(plan.error));
            if (from === to) {
                expect(plan.value).toEqual({ kind: 'noop', result: {
                    id: 'target', isSequential: from === 'sequential', sequentialScope: 'section',
                } });
                expect(first.saves()).toBe(0);
                expect(first.data()).toEqual(before);
                return;
            }
            if (plan.value.kind !== 'prepared' || plan.value.prepared.version !== 2) throw new Error('v2 prepare failed');
            const envelope = { request: input, prepared: plan.value.prepared };
            expect(envelope.prepared.scope.sections.map((row) => row.id)).toEqual([
                'deleted', 'linked-section', 'stored-parallel', 'stored-sequential',
            ]);
            expect(Object.keys(envelope.prepared.result).sort()).toEqual(['id', 'isSequential', 'sequentialScope']);
            expect(first.methods.validatePreparedProjectFlow(envelope)).toMatchObject({ ok: true });
            expect(await first.methods.commitPreparedProjectFlow(envelope)).toMatchObject({ ok: true });
            expect(first.saves()).toBe(1);
            expect(first.methods.getProjectFlowModeOptions({ projectId: 'target' }))
                .toMatchObject({ ok: true, value: { mode: to } });
            expect(first.data().projects[0]).toMatchObject({ isSequential: to === 'sequential',
                perSectionFlow: to === 'perSection', sequentialScope: 'section', rev: 4 });
            expect(first.data().projects[1]).toEqual(before.projects[1]);
            expect(first.data().tasks).toEqual(tasksBefore);
            for (const unchanged of [storedParallel, storedSequential, deleted, unrelated])
                expect(first.data().sections?.find((row) => row.id === unchanged.id)).toEqual(unchanged);
            const changed = first.data().sections?.find((row) => row.id === missing.id);
            if (to === 'perSection') expect(changed).toMatchObject({ isSequential: from === 'sequential', rev: 3 });
            else expect(changed).toEqual(missing);
            const second = await open(structuredClone(first.data()));
            const cold = JSON.parse(JSON.stringify(sortKeys(envelope)));
            expect(second.methods.validatePreparedProjectFlow(cold)).toMatchObject({ ok: true });
            const saveCount = second.saves();
            expect(await second.methods.commitPreparedProjectFlow(cold)).toMatchObject({ ok: true });
            expect(second.saves()).toBe(saveCount);
            expect(second.methods.getProjectFlowModeOptions({ projectId: 'target' }))
                .toMatchObject({ ok: true, value: { mode: to } });
        });
    }

    it('defaults from Sequential across sections to Parallel and preserves explicit choices on reentry', async () => {
        const first = await open({ projects: [project('target', { isSequential: true, sequentialScope: 'project' })],
            sections: [section()] });
        for (const mode of ['perSection', 'sequential', 'perSection'] as const) {
            const input = first.request({ kind: 'flowMode', mode });
            const plan = first.methods.prepareProjectFlow(input);
            if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
            expect(await first.methods.commitPreparedProjectFlow({ request: input, prepared: plan.value.prepared }))
                .toMatchObject({ ok: true });
        }
        expect(first.data().sections?.[0]).toMatchObject({ isSequential: false, rev: 3 });
        expect(first.data().projects[0]).toMatchObject({ perSectionFlow: true, isSequential: false });
    });

    it('blocks every explicit archived mode without a write', async () => {
        const { methods, request, saves } = await open({ projects: [project('target', { status: 'archived' })] });
        for (const mode of modes) expect(methods.prepareProjectFlow(request({ kind: 'flowMode', mode })))
            .toEqual({ ok: true, value: { kind: 'blocked', result: { blocked: '' } } });
        expect(methods.getProjectFlowModeOptions({ projectId: 'target' }))
            .toMatchObject({ ok: true, value: { canChange: false, mode: 'parallel' } });
        expect(saves()).toBe(0);
    });

    it('rejects changed project rows and added, deleted, reassigned or changed scoped sections before writing', async () => {
        const original = section();
        const stored = { ...section(), id: 'stored', isSequential: false };
        const { methods, request, saves } = await open({ sections: [original, stored] });
        const input = request({ kind: 'flowMode', mode: 'perSection' });
        const plan = methods.prepareProjectFlow(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const envelope = { request: input, prepared: plan.value.prepared };
        for (const sections of [[original, stored, { ...original, id: 'added' }], [stored],
            [{ ...original, deletedAt: now }, stored], [{ ...original, projectId: 'other' }, stored],
            [original, { ...stored, title: 'Changed stored row' }], [original, { ...stored, isSequential: true }]]) {
            useTaskStore.setState({ _allSections: sections });
            expect(await methods.commitPreparedProjectFlow(envelope)).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
        }
        useTaskStore.setState({ _allSections: [original, stored],
            _allProjects: [project('target', { perSectionFlow: true })] });
        expect(await methods.commitPreparedProjectFlow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });

    it('requires the full v2 section after-image for replay and ignores unrelated sections', async () => {
        const { methods, request, data, saves } = await open({ sections: [section()] });
        const input = request({ kind: 'flowMode', mode: 'perSection' });
        const plan = methods.prepareProjectFlow(input);
        if (!plan.ok || plan.value.kind !== 'prepared' || plan.value.prepared.version !== 2) throw new Error('prepare failed');
        const envelope = { request: input, prepared: plan.value.prepared };
        expect(await methods.commitPreparedProjectFlow(envelope)).toMatchObject({ ok: true });
        const after = structuredClone(data().sections ?? []);
        const count = saves();
        useTaskStore.setState({ _allSections: [section()] });
        expect(await methods.commitPreparedProjectFlow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allSections: [...after, { ...section(), id: 'new-related' }] });
        expect(await methods.commitPreparedProjectFlow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allSections: [...after, { ...section(), id: 'other', projectId: 'other' }] });
        expect(await methods.commitPreparedProjectFlow(envelope)).toMatchObject({ ok: true });
        expect(saves()).toBe(count);
    });

    it('replays a cold v2 before-image and retries a failed atomic save without stamping twice', async () => {
        const initial = { projects: [project('target', { isSequential: true, sequentialScope: 'section' })],
            sections: [section()], settings: { deviceId: 'flow-device' } };
        const first = await open(initial);
        const input = first.request({ kind: 'flowMode', mode: 'perSection' });
        const plan = first.methods.prepareProjectFlow(input);
        if (!plan.ok || plan.value.kind !== 'prepared' || plan.value.prepared.version !== 2) throw new Error('prepare failed');
        const envelope = JSON.parse(JSON.stringify(sortKeys({ request: input, prepared: plan.value.prepared })));
        useTaskStore.setState({ _allProjects: [], _allSections: [] });
        expect(first.methods.validatePreparedProjectFlow(envelope)).toMatchObject({ ok: true });
        let failed = true;
        const second = await open(initial, () => failed);
        expect(second.methods.validatePreparedProjectFlow(envelope)).toMatchObject({ ok: true });
        expect(await second.methods.commitPreparedProjectFlow(envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(second.data().projects[0].perSectionFlow).toBeUndefined();
        expect(second.data().sections?.[0].isSequential).toBeUndefined();
        expect(second.saves()).toBe(0);
        failed = false;
        expect(await second.methods.commitPreparedProjectFlow(envelope)).toMatchObject({ ok: true });
        expect(second.data().projects[0]).toEqual(plan.value.prepared.effect.project.after);
        expect(second.data().sections?.[0]).toEqual(plan.value.prepared.effect.sections[0].after);
        expect(second.data().settings.deviceId).toBe('flow-device');
        const third = await open(structuredClone(second.data()));
        const count = third.saves();
        expect(await third.methods.commitPreparedProjectFlow(envelope)).toMatchObject({ ok: true });
        expect(third.saves()).toBe(count);
    });

    it('initializes a missing device ID with both project and section writes', async () => {
        const { methods, request, data } = await open({ sections: [section()] });
        useTaskStore.setState({ settings: {} });
        const input = request({ kind: 'flowMode', mode: 'perSection' });
        const plan = methods.prepareProjectFlow(input);
        if (!plan.ok || plan.value.kind !== 'prepared' || plan.value.prepared.version !== 2) throw new Error('prepare failed');
        expect(plan.value.prepared.deviceIdBefore).toBeNull();
        expect(await methods.commitPreparedProjectFlow({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        const deviceId = plan.value.prepared.deviceIdToInitialize;
        expect(data().settings.deviceId).toBe(deviceId);
        expect(data().projects[0]).toMatchObject({ revBy: deviceId, perSectionFlow: true });
        expect(data().sections?.[0]).toMatchObject({ revBy: deviceId, isSequential: false });
    });

    it('bounds the full v2 project and section journal before persistence', async () => {
        const { methods, request, saves } = await open({
            sections: [{ ...section(), description: '漢'.repeat(250_000) }],
        });
        expect(methods.prepareProjectFlow(request({ kind: 'flowMode', mode: 'perSection' })))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(0);
    });

    it('rejects malformed v2 scopes, effects, versions and mode requests during cold validation', async () => {
        const { methods, request, saves } = await open({ sections: [section()] });
        const input = request({ kind: 'flowMode', mode: 'perSection' });
        const plan = methods.prepareProjectFlow(input);
        if (!plan.ok || plan.value.kind !== 'prepared' || plan.value.prepared.version !== 2) throw new Error('prepare failed');
        const prepared = plan.value.prepared;
        const envelope = { request: input, prepared };
        for (const forged of [
            { ...envelope, prepared: { ...prepared, version: 1 } },
            { ...envelope, prepared: { ...prepared, scope: { project: prepared.scope.project } } },
            { ...envelope, prepared: { ...prepared, scope: { ...prepared.scope,
                sections: [...prepared.scope.sections, ...prepared.scope.sections] } } },
            { ...envelope, prepared: { ...prepared, effect: { ...prepared.effect, sections: [] } } },
            { ...envelope, prepared: { ...prepared, effect: { ...prepared.effect,
                sections: [{ ...prepared.effect.sections[0], after: { ...prepared.effect.sections[0].after, isSequential: true } }] } } },
        ]) expect(methods.validatePreparedProjectFlow(forged as never)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(methods.prepareProjectFlow({ ...input, action: { kind: 'flowMode', mode: 'other' } } as never))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(0);
    });
});

describe('prepared native Section flow', () => {
    const parent = () => project('target', { perSectionFlow: true, sequentialScope: 'section' });

    it('reads detached live section tokens separately and preserves old project read keysets', async () => {
        const original = { ...section(), description: 'Retained description', isCollapsed: true };
        const sibling = { ...section(), id: 'sibling', order: 1, isSequential: true };
        const { methods, sectionRequest } = await open({ projects: [parent()], sections: [original, sibling,
            { ...section(), id: 'deleted', deletedAt: now }, { ...section(), id: 'other', projectId: 'other' }] });
        const options = methods.getProjectSectionFlowOptions({ projectId: 'target' });
        const legacy = methods.getProjectFlowOptions({ projectId: 'target' });
        if (!options.ok || !legacy.ok) throw new Error('read failed');
        expect(Object.keys(options.value).sort()).toEqual(['canChange', 'project', 'revision', 'sections']);
        expect(options.value.project).toEqual(legacy.value.project);
        expect(Object.keys(legacy.value).sort()).toEqual(['canChange', 'project', 'revision']);
        expect(Object.keys(options.value.project).sort()).toEqual([
            'id', 'isSequential', 'rev', 'revBy', 'sequentialScope', 'status', 'title', 'updatedAt',
        ]);
        expect(options.value.canChange).toBe(true);
        expect(options.value.sections.map(({ id, sequential }) => ({ id, sequential })))
            .toEqual([{ id: original.id, sequential: false }, { id: 'sibling', sequential: true }]);
        expect(Object.keys(options.value.sections[0]).sort()).toEqual(['id', 'sequential', 'title', 'token']);
        expect(options.value.sections[0].token).toEqual(original);
        expect(Object.keys(sectionRequest(true).expected).sort()).toEqual([
            'isSequential', 'rev', 'revBy', 'sequentialScope', 'status', 'title', 'updatedAt',
        ]);
        options.value.sections[0].token.title = 'Mutation of a read';
        expect(useTaskStore.getState()._allSections.find((row) => row.id === original.id)?.title).toBe(original.title);
        expect(methods.getProjectSectionFlowOptions({ projectId: 'target', extra: true } as never))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('saves only the selected section, preserves parent/tasks/siblings, and stamps exactly once per choice', async () => {
        const original = { ...section(), title: '  Keep section text  ', description: 'Keep notes', isCollapsed: true };
        const sibling = { ...section(), id: 'sibling', isSequential: false };
        const opened = await open({ projects: [parent(), project('other')], tasks: [task()], sections: [original, sibling] });
        const projectsBefore = structuredClone(useTaskStore.getState()._allProjects);
        const tasksBefore = structuredClone(useTaskStore.getState()._allTasks);
        for (const sequential of [true, false]) {
            const input = opened.sectionRequest(sequential);
            const plan = opened.methods.prepareProjectFlow(input);
            if (!plan.ok || plan.value.kind !== 'prepared' || plan.value.prepared.version !== 3) throw new Error('v3 prepare failed');
            const prepared = plan.value.prepared;
            expect(Object.keys(prepared).sort()).toEqual([
                'deviceIdBefore', 'deviceIdToInitialize', 'effect', 'request', 'result', 'scope', 'updateAt', 'version',
            ]);
            expect(Object.keys(prepared.scope).sort()).toEqual(['project', 'section']);
            expect(Object.keys(prepared.effect)).toEqual(['section']);
            expect(prepared.result).toEqual({ id: 'target', isSequential: false, sequentialScope: 'section' });
            const envelope = { request: input, prepared };
            expect(opened.methods.validatePreparedProjectFlow(envelope)).toMatchObject({ ok: true });
            expect(await opened.methods.commitPreparedProjectFlow(envelope)).toEqual({ ok: true, value: prepared.result });
            expect(opened.data().sections?.find((row) => row.id === original.id)).toEqual(prepared.effect.section.after);
            expect(opened.data().projects).toEqual(projectsBefore);
            expect(opened.data().tasks).toEqual(tasksBefore);
            expect(opened.data().sections?.find((row) => row.id === sibling.id)).toEqual(sibling);
            expect(prepared.effect.section.after).toMatchObject({ title: '  Keep section text  ', description: 'Keep notes',
                isCollapsed: true, isSequential: sequential, rev: sequential ? 3 : 4 });
        }
        expect(opened.saves()).toBe(2);
    });

    it('treats absent and explicit Parallel as the same no-write mode and skips unchanged Sequential', async () => {
        for (const stored of [undefined, false, true]) {
            const { methods, sectionRequest, saves } = await open({ projects: [parent()],
                sections: [{ ...section(), ...(stored === undefined ? {} : { isSequential: stored }) }] });
            expect(methods.prepareProjectFlow(sectionRequest(stored === true))).toEqual({ ok: true,
                value: { kind: 'noop', result: { id: 'target', isSequential: false, sequentialScope: 'section' } } });
            expect(saves()).toBe(0);
        }
    });

    it('blocks non-Per-section and archived parents, and refuses deleted parents', async () => {
        for (const changed of [project('target'), project('target', { isSequential: true, perSectionFlow: true }),
            project('target', { status: 'archived', perSectionFlow: true })]) {
            const { methods, request, saves } = await open({ projects: [changed], sections: [section()] });
            expect(methods.getProjectSectionFlowOptions({ projectId: 'target' }))
                .toMatchObject({ ok: true, value: { canChange: false } });
            expect(methods.prepareProjectFlow(request({ kind: 'sectionFlow', sectionId: section().id,
                sequential: true, expectedSection: section() }))).toEqual({ ok: true,
                value: { kind: 'blocked', result: { blocked: '' } } });
            expect(saves()).toBe(0);
        }
        const { methods, sectionRequest } = await open({ projects: [parent()], sections: [section()] });
        const input = sectionRequest(true);
        useTaskStore.setState({ _allProjects: [{ ...parent(), deletedAt: now }] });
        expect(methods.prepareProjectFlow(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(methods.getProjectSectionFlowOptions({ projectId: 'target' })).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
    });

    it('rejects missing, stale, deleted and reassigned sections before preparation or first apply', async () => {
        const { methods, sectionRequest, saves } = await open({ projects: [parent()], sections: [section()] });
        const input = sectionRequest(true);
        const plan = methods.prepareProjectFlow(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        for (const rows of [[], [{ ...section(), title: 'New title' }], [{ ...section(), deletedAt: now }],
            [{ ...section(), projectId: 'other' }], [{ ...section(), isSequential: true }]]) {
            useTaskStore.setState({ _allSections: rows });
            expect(methods.prepareProjectFlow(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await methods.commitPreparedProjectFlow({ request: input, prepared: plan.value.prepared }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        useTaskStore.setState({ _allSections: [section()], _allProjects: [{ ...parent(), title: 'Parent edited' }] });
        expect(await methods.commitPreparedProjectFlow({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });

    it('allows sibling additions after prepare without mutating them', async () => {
        const { methods, sectionRequest, data } = await open({ projects: [parent()], sections: [section()] });
        const input = sectionRequest(true);
        const plan = methods.prepareProjectFlow(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const sibling = { ...section(), id: 'new-sibling' };
        useTaskStore.setState({ _allSections: [section(), sibling] });
        expect(await methods.commitPreparedProjectFlow({ request: input, prepared: plan.value.prepared })).toMatchObject({ ok: true });
        expect(data().sections?.find((row) => row.id === sibling.id)).toEqual(sibling);
    });

    it('cold-validates v3, retries a failed save exactly, and replays after a later parent edit', async () => {
        const initial = { projects: [parent()], sections: [section()], settings: { deviceId: 'flow-device' } };
        const first = await open(initial);
        const input = first.sectionRequest(true);
        const plan = first.methods.prepareProjectFlow(input);
        if (!plan.ok || plan.value.kind !== 'prepared' || plan.value.prepared.version !== 3) throw new Error('prepare failed');
        const frozen = JSON.parse(JSON.stringify(sortKeys({ request: input, prepared: plan.value.prepared })));
        useTaskStore.setState({ _allProjects: [], _allSections: [] });
        expect(first.methods.validatePreparedProjectFlow(frozen)).toMatchObject({ ok: true });
        let failed = false;
        const second = await open(initial, () => failed);
        failed = true;
        const rejected = await second.methods.commitPreparedProjectFlow(frozen);
        failed = false;
        expect(rejected).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(second.data().sections?.[0].isSequential).toBeUndefined();
        expect(await second.methods.commitPreparedProjectFlow(frozen)).toMatchObject({ ok: true });
        expect(second.data().sections?.[0]).toEqual(plan.value.prepared.effect.section.after);
        expect(second.data().projects[0]).toEqual(initial.projects[0]);
        const changedParent = { ...parent(), title: 'Later parent edit', perSectionFlow: false, rev: 20 };
        const third = await open({ ...structuredClone(second.data()), projects: [changedParent] });
        const count = third.saves();
        expect(await third.methods.commitPreparedProjectFlow(frozen)).toMatchObject({ ok: true });
        expect(third.saves()).toBe(count);
        expect(third.data().projects[0]).toEqual(changedParent);
        expect(third.data().sections?.[0].rev).toBe(3);
        useTaskStore.setState({ _allProjects: [] });
        expect(await third.methods.commitPreparedProjectFlow(frozen)).toMatchObject({ ok: true });
        useTaskStore.setState({ _allSections: [{ ...plan.value.prepared.effect.section.after, description: 'Later section edit' }] });
        expect(await third.methods.commitPreparedProjectFlow(frozen)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
    });

    it('initializes the device with the selected section and leaves the project revision unchanged', async () => {
        const { methods, sectionRequest, data } = await open({ projects: [parent()], sections: [section()] });
        useTaskStore.setState({ settings: {} });
        const input = sectionRequest(true);
        const plan = methods.prepareProjectFlow(input);
        if (!plan.ok || plan.value.kind !== 'prepared' || plan.value.prepared.version !== 3) throw new Error('prepare failed');
        expect(await methods.commitPreparedProjectFlow({ request: input, prepared: plan.value.prepared })).toMatchObject({ ok: true });
        expect(data().settings.deviceId).toBe(plan.value.prepared.deviceIdToInitialize);
        expect(data().sections?.[0].revBy).toBe(data().settings.deviceId);
        expect(data().projects[0]).toEqual(parent());
    });

    it('rejects malformed, forged and oversized v3 journals before writes', async () => {
        const { methods, sectionRequest, saves } = await open({ projects: [parent()], sections: [section()] });
        const input = sectionRequest(true);
        const plan = methods.prepareProjectFlow(input);
        if (!plan.ok || plan.value.kind !== 'prepared' || plan.value.prepared.version !== 3) throw new Error('prepare failed');
        const prepared = plan.value.prepared;
        const envelope = { request: input, prepared };
        for (const forged of [
            { ...envelope, prepared: { ...prepared, version: 2 } },
            { ...envelope, prepared: { ...prepared, scope: { project: prepared.scope.project } } },
            { ...envelope, prepared: { ...prepared, effect: { ...prepared.effect, project: { before: parent(), after: parent() } } } },
            { ...envelope, prepared: { ...prepared, effect: { section: { ...prepared.effect.section,
                after: { ...prepared.effect.section.after, isSequential: false } } } } },
            { ...envelope, prepared: { ...prepared, result: { ...prepared.result, isSequential: true } } },
        ]) expect(methods.validatePreparedProjectFlow(forged as never)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        for (const action of [{ ...input.action, extra: true }, { ...input.action, sequential: 'true' },
            { ...input.action, expectedSection: { ...section(), projectId: 'other' } }]) {
            expect(methods.prepareProjectFlow({ ...input, action } as never)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        expect(saves()).toBe(0);
        const large = await open({ projects: [parent()], sections: [{ ...section(), description: '漢'.repeat(250_000) }] });
        expect(large.methods.prepareProjectFlow(large.sectionRequest(true))).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(large.saves()).toBe(0);
    });
});
