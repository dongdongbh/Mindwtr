import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectTaskSortMethods, type NativeProjectTaskSortRequest } from './native-host-contract-project-sort';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { PROJECT_SQLITE_COLUMNS, projectToSqliteRow } from './project-sync-schema';
import { PROJECT_TASK_SORT_OPTIONS, resolveNonDoneTaskSortBy } from './task-list-sort-options';
import type { AppData, Project, Section, Task } from './types';

const now = '2026-09-28T15:00:00.000Z';
const project = (overrides: Partial<Project> = {}): Project => ({ id: 'target', title: 'Project', status: 'active',
    color: '#3b82f6', order: 0, tagIds: ['#a', '#b'], rev: 3, revBy: 'old', createdAt: now, updatedAt: now,
    ...overrides });
const task: Task = { id: 'task', title: 'Keep', status: 'next', projectId: 'target',
    createdAt: now, updatedAt: now };
const section: Section = { id: 'section', title: 'Keep', projectId: 'target', order: 0,
    createdAt: now, updatedAt: now };
const sortedKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortedKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortedKeys(item)])) : value;

async function open(initial: Partial<AppData> = {}, failing?: () => boolean) {
    await flushPendingSave(); resetForTests();
    let data: AppData = { tasks: [task], projects: [project()], sections: [section], areas: [], people: [],
        settings: { deviceId: 'sort-device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (failing?.()) throw new Error('disk unavailable');
        data = structuredClone(next); saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const methods = createProjectTaskSortMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        }, revision: () => 'revision', t: (key) => key });
    const request = (sortBy: NativeProjectTaskSortRequest['sortBy']): NativeProjectTaskSortRequest => {
        const options = methods.getProjectTaskSortOptions({ projectId: 'target' });
        if (!options.ok) throw new Error(JSON.stringify(options.error));
        const { id: _id, ...expected } = options.value.project;
        return { requestId: '73799899-d143-40c1-84bd-a09172bba5a4', projectId: 'target', sortBy, expected };
    };
    return { methods, request, data: () => data, saves: () => saves };
}

afterEach(async () => { vi.useRealTimers(); await flushPendingSave(); resetForTests(); });

describe('durable Project task sort', () => {
    it('offers the RN roster and makes every saved choice a project-only write', async () => {
        for (const sortBy of PROJECT_TASK_SORT_OPTIONS.filter((choice) => choice !== 'default')) {
            vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T16:00:00.000Z'));
            const rich = project({ supportNotes: 'raw notes', attachments: [{ id: 'link', kind: 'link',
                title: 'Source', uri: 'https://example.test/', createdAt: now, updatedAt: now }] });
            const { methods, request, data } = await open({ projects: [rich] });
            const tasksBefore = structuredClone(useTaskStore.getState()._allTasks);
            const sectionsBefore = structuredClone(useTaskStore.getState()._allSections);
            expect(methods.getProjectTaskSortOptions({ projectId: 'target' })).toMatchObject({ ok: true,
                value: { label: 'sort.label', effectiveSortBy: 'default', canEdit: true,
                    choices: PROJECT_TASK_SORT_OPTIONS.map((id) => ({ id, label: `sort.${id}`, selected: id === 'default' })) } });
            const input = request(sortBy);
            const prepared = methods.prepareProjectTaskSort(input);
            if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
            expect(prepared.value.prepared.effect.project.after).toMatchObject({ taskSortBy: sortBy,
                rev: 4, supportNotes: 'raw notes' });
            expect(await methods.commitPreparedProjectTaskSort({ request: input, prepared: prepared.value.prepared }))
                .toMatchObject({ ok: true, value: { id: 'target', taskSortBy: sortBy } });
            expect(data().projects).toEqual([prepared.value.prepared.effect.project.after]);
            expect(data().tasks).toEqual(tasksBefore);
            expect(data().sections).toEqual(sectionsBefore);
            vi.useRealTimers();
        }
    });

    // Project.taskSortBy syncs, and older clients erase a project sort they do not know (#1415).
    it('never offers or accepts the shared-list-only priority sort', async () => {
        const { methods, request } = await open();
        const options = methods.getProjectTaskSortOptions({ projectId: 'target' });
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.choices.map((choice) => choice.id)).not.toContain('priority');
        expect(methods.prepareProjectTaskSort(request('priority'))).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
    });

    it('clears saved sort for default, including a hidden time estimate, and no-op never saves', async () => {
        const { methods, request, data, saves } = await open({ projects: [project({ taskSortBy: 'timeEstimate' })],
            settings: { deviceId: 'sort-device', features: { timeEstimates: false } } });
        const options = methods.getProjectTaskSortOptions({ projectId: 'target' });
        expect(options).toMatchObject({ ok: true,
            value: { project: { taskSortBy: 'timeEstimate' }, effectiveSortBy: 'default' } });
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.choices[0]).toMatchObject({ id: 'default', selected: true });
        expect(options.value.choices.some((choice) => choice.id === 'timeEstimate')).toBe(false);
        expect(methods.prepareProjectTaskSort(request('timeEstimate'))).toMatchObject({ ok: true,
            value: { kind: 'blocked' } });
        const input = request('default');
        const plan = methods.prepareProjectTaskSort(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        expect(plan.value.prepared.effect.project.after.taskSortBy).toBeUndefined();
        expect(await methods.commitPreparedProjectTaskSort({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true, value: { taskSortBy: null } });
        expect(data().projects[0].taskSortBy).toBeUndefined();
        expect(methods.prepareProjectTaskSort(request('default'))).toMatchObject({ ok: true,
            value: { kind: 'noop', result: { taskSortBy: null } } });
        expect(saves()).toBe(1);
    });

    it('shows one selected default for legacy completed and clears that saved value explicitly', async () => {
        const { methods, request, data } = await open({ projects: [project({ taskSortBy: 'completed' })] });
        const options = methods.getProjectTaskSortOptions({ projectId: 'target' });
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.project.taskSortBy).toBe('completed');
        expect(options.value.effectiveSortBy).toBe(resolveNonDoneTaskSortBy('completed', useTaskStore.getState().settings));
        expect(options.value.choices.filter((choice) => choice.selected)).toEqual([
            { id: 'default', label: 'sort.default', selected: true },
        ]);
        const input = request('default');
        const plan = methods.prepareProjectTaskSort(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        expect(await methods.commitPreparedProjectTaskSort({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true, value: { taskSortBy: null } });
        expect(data().projects[0].taskSortBy).toBeUndefined();
    });

    it('matches RN updateProject persisted rows for every offered sort and default clear', async () => {
        for (const sortBy of PROJECT_TASK_SORT_OPTIONS) {
            vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T16:00:00.000Z'));
            const { methods, request } = await open({ projects: [project({ taskSortBy: 'due' })] });
            const input = request(sortBy);
            const plan = methods.prepareProjectTaskSort(input);
            if (sortBy === 'due') {
                expect(plan).toMatchObject({ ok: true, value: { kind: 'noop' } });
            } else {
                if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
                expect((await useTaskStore.getState().updateProject('target', { taskSortBy: sortBy })).success).toBe(true);
                expect(projectToSqliteRow(useTaskStore.getState()._allProjects[0]))
                    .toEqual(projectToSqliteRow(plan.value.prepared.effect.project.after));
            }
            vi.useRealTimers();
        }
    });

    it('validates frozen effects, accepts Swift key order, and refuses stale replay after edits', async () => {
        const rich = project({ attachments: [{ id: 'a', kind: 'link', title: 'A', uri: 'https://a.test/',
            createdAt: now, updatedAt: now }, { id: 'b', kind: 'link', title: 'B', uri: 'https://b.test/',
            createdAt: now, updatedAt: now }] });
        const { methods, request, data, saves } = await open({ projects: [rich] });
        const input = request('title');
        const plan = methods.prepareProjectTaskSort(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const frozen = JSON.parse(JSON.stringify(sortedKeys({ request: input, prepared: plan.value.prepared })));
        expect(methods.validatePreparedProjectTaskSort(frozen)).toMatchObject({ ok: true });
        const forged = structuredClone(frozen);
        forged.prepared.effect.project.after.color = '#000';
        expect(methods.validatePreparedProjectTaskSort(forged)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const reordered = structuredClone(frozen);
        reordered.prepared.effect.project.after.tagIds.reverse();
        expect(methods.validatePreparedProjectTaskSort(reordered)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const partial = structuredClone(frozen);
        delete partial.prepared.effect.project.after.color;
        expect(methods.validatePreparedProjectTaskSort(partial)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const attachmentIndex = PROJECT_SQLITE_COLUMNS.indexOf('attachments');
        const attachmentsBefore = projectToSqliteRow(rich)[attachmentIndex];
        expect(await methods.commitPreparedProjectTaskSort(frozen)).toMatchObject({ ok: true });
        expect(projectToSqliteRow(data().projects[0])[attachmentIndex]).toBe(attachmentsBefore);
        const count = saves();
        useTaskStore.setState((state) => ({ settings: { ...state.settings, deviceId: 'other' } }));
        expect(await methods.commitPreparedProjectTaskSort(frozen)).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [{ ...data().projects[0], title: 'Later rename' }] });
        expect(await methods.commitPreparedProjectTaskSort(frozen)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(count);
    });

    it('refuses stale, archived, deleted, malformed and oversized requests without writes', async () => {
        const { methods, request, saves } = await open();
        const input = request('due');
        expect(methods.probeProjectTaskSortOutcome(input)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(methods.prepareProjectTaskSort({ ...input, sortBy: 'bogus' as never })).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(methods.prepareProjectTaskSort({ ...input, unexpected: true } as never)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(methods.prepareProjectTaskSort({ ...input, projectId: 'x'.repeat(501) })).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(methods.prepareProjectTaskSort({ ...input, expected: { ...input.expected, rev: 4 } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allProjects: [project({ status: 'archived' })] });
        expect(methods.prepareProjectTaskSort(request('due'))).toMatchObject({ ok: true,
            value: { kind: 'blocked' } });
        useTaskStore.setState({ _allProjects: [project({ deletedAt: now })] });
        expect(methods.getProjectTaskSortOptions({ projectId: 'target' })).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });

    it('keeps a frozen time estimate write valid after the feature is switched off', async () => {
        const { methods, request } = await open();
        const input = request('timeEstimate');
        const plan = methods.prepareProjectTaskSort(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        useTaskStore.setState((state) => ({ settings: { ...state.settings,
            features: { ...state.settings.features, timeEstimates: false } } }));
        const frozen = { request: input, prepared: plan.value.prepared };
        expect(methods.validatePreparedProjectTaskSort(frozen)).toMatchObject({ ok: true });
        expect(await methods.commitPreparedProjectTaskSort(frozen)).toMatchObject({ ok: true,
            value: { taskSortBy: 'timeEstimate' } });
        expect(methods.getProjectTaskSortOptions({ projectId: 'target' })).toMatchObject({ ok: true,
            value: { effectiveSortBy: 'default' } });
    });

    it('rejects a rich Project response or journal above the native byte bound', async () => {
        const { methods, request, saves } = await open({ projects: [project({
            supportNotes: '漢'.repeat(250_000),
        })] });
        expect(methods.getProjectTaskSortOptions({ projectId: 'target' })).toMatchObject({ ok: true });
        expect(methods.prepareProjectTaskSort(request('due'))).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(0);
    });

    it('cold first-apply is deterministic; original UUID cannot overwrite later rename or deletion', async () => {
        const first = await open();
        const input = first.request('review');
        const plan = first.methods.prepareProjectTaskSort(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const frozen = { request: input, prepared: plan.value.prepared };
        const cold = await open(structuredClone(first.data()));
        expect(await cold.methods.commitPreparedProjectTaskSort(frozen)).toMatchObject({ ok: true,
            value: { taskSortBy: 'review' } });
        const renamed = structuredClone(cold.data());
        renamed.projects[0].title = 'Later rename';
        const afterRename = await open(renamed);
        expect(await afterRename.methods.commitPreparedProjectTaskSort(frozen)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        const deleted = structuredClone(cold.data());
        deleted.projects[0].deletedAt = now;
        const afterDelete = await open(deleted);
        expect(await afterDelete.methods.commitPreparedProjectTaskSort(frozen)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
    });

    it('retries SAVE_FAILED and recognizes the full after-row after cold reopen', async () => {
        let fail = true;
        const first = await open({ settings: {} }, () => fail);
        useTaskStore.setState({ settings: {} });
        const input = first.request('due');
        const plan = first.methods.prepareProjectTaskSort(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const frozen = { request: input, prepared: plan.value.prepared };
        expect(await first.methods.commitPreparedProjectTaskSort(frozen)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        fail = false;
        expect(await first.methods.commitPreparedProjectTaskSort(frozen)).toMatchObject({ ok: true });
        const second = await open(structuredClone(first.data()));
        await flushPendingSave();
        const count = second.saves();
        expect(await second.methods.commitPreparedProjectTaskSort(frozen)).toMatchObject({ ok: true });
        expect(second.saves()).toBe(count);
    });
});
