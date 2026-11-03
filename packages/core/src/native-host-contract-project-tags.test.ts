import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectTagsWriteMethods, type NativeProjectTagsWriteRequest } from './native-host-contract-project-tags';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { PROJECT_SQLITE_COLUMNS, projectToSqliteRow } from './project-sync-schema';
import type { ProjectTagsIntent } from './project-tags';
import type { AppData, Project, Section, Task } from './types';

const now = '2026-09-28T15:00:00.000Z';
const project = (id = 'target', overrides: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#3b82f6', order: 0, tagIds: ['legacy', '#Work', 'legacy'],
    rev: 3, revBy: 'old-device', createdAt: now, updatedAt: now, ...overrides,
});
const task = (id = 'linked-task', overrides: Partial<Task> = {}): Task => ({
    id, title: 'Keep task text', status: 'next', projectId: 'target', tags: ['#z', '#a'],
    contexts: ['@home'], rev: 5, revBy: 'old-device', createdAt: now, updatedAt: now, ...overrides,
});
const section = (): Section => ({ id: 'linked-section', projectId: 'target', title: 'Keep section text',
    order: 0, rev: 2, revBy: 'old-device', createdAt: now, updatedAt: now });
const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortKeys(nested)])) : value;

async function open(initial: Partial<AppData> = {}, fail?: () => boolean) {
    await flushPendingSave(); resetForTests();
    let data: AppData = { tasks: [], projects: [project()], sections: [], areas: [], people: [],
        settings: { deviceId: 'tags-device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (fail?.()) throw new Error('disk unavailable');
        data = structuredClone(next); saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const methods = createProjectTagsWriteMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        }, revision: () => 'stable-revision' });
    const request = (intent: ProjectTagsIntent): NativeProjectTagsWriteRequest => {
        const options = methods.getProjectTagsEditOptions({ projectId: 'target' });
        if (!options.ok) throw new Error(JSON.stringify(options.error));
        const { id: _id, ...expected } = options.value.project;
        return { requestId: '73799899-d143-40c1-84bd-a09172bba5a4', projectId: 'target', intent, expected };
    };
    return { methods, request, data: () => data, saves: () => saves };
}

afterEach(async () => { vi.useRealTimers(); await flushPendingSave(); resetForTests(); });

describe('prepared native Project Tags edits', () => {
    it('offers a saved unused tag through the native Project tag options', async () => {
        const { methods } = await open({ settings: { deviceId: 'test', taxonomy: {
            tags: [{ token: '#unused', rev: 1, revBy: 'test', updatedAt: now }],
        } } });
        expect(methods.getProjectTagsEditOptions({ projectId: 'target' })).toMatchObject({ ok: true,
            value: { suggestions: ['legacy', '#Work', '#unused'] } });
    });

    it('returns the full RN suggestion order and raw selected tags; preserves rich unrelated rows', async () => {
        const original = project('target', { supportNotes: 'Raw notes', dueDate: '2026-10-01',
            attachments: [{ id: 'a', kind: 'link', title: 'Source', uri: 'https://example.test/',
                createdAt: now, updatedAt: now }] });
        const other = project('other', { tagIds: ['#z', '##raw', ''] });
        const linkedTask = task(); const linkedSection = section();
        const beforeAttachments = projectToSqliteRow(original)[PROJECT_SQLITE_COLUMNS.indexOf('attachments')];
        const children = { tasks: [linkedTask, task('deleted', { tags: ['#gone'], deletedAt: now })],
            sections: [linkedSection] };
        const { methods, request, data } = await open({ projects: [original, other],
            ...children });
        const childrenBefore = { tasks: structuredClone(useTaskStore.getState()._allTasks),
            sections: structuredClone(useTaskStore.getState()._allSections) };
        expect(methods.getProjectTagsEditOptions({ projectId: 'target' })).toMatchObject({ ok: true,
            value: { project: { tagIds: original.tagIds }, canEdit: true,
                suggestions: ['#a', '#z', 'legacy', '#Work', '##raw'] } });
        const input = request({ kind: 'add', input: '  ##new  ' });
        const plan = methods.prepareProjectTagsWrite(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(plan.value.prepared.effect.project.after).toMatchObject({
            tagIds: ['legacy', '#Work', '##new'], rev: 4, supportNotes: 'Raw notes', dueDate: '2026-10-01',
        });
        expect(await methods.commitPreparedProjectTagsWrite({ request: input, prepared: plan.value.prepared }))
            .toEqual({ ok: true, value: { id: 'target', tagIds: ['legacy', '#Work', '##new'] } });
        expect(data().projects[0]).toEqual(plan.value.prepared.effect.project.after);
        expect(projectToSqliteRow(data().projects[0])[PROJECT_SQLITE_COLUMNS.indexOf('attachments')])
            .toBe(beforeAttachments);
        expect(data().projects[1]).toEqual(other);
        expect(data().tasks).toEqual(childrenBefore.tasks);
        expect(data().sections).toEqual(childrenBefore.sections);
    });

    it('matches RN toggle including raw bare legacy suggestions, exact removal, clear and no-op', async () => {
        const { methods, request, saves } = await open();
        const bare = methods.prepareProjectTagsWrite(request({ kind: 'toggle', input: 'legacy' }));
        if (!bare.ok || bare.value.kind !== 'prepared') throw new Error('toggle failed');
        expect(bare.value.prepared.result.tagIds).toEqual(['legacy', '#Work', 'legacy', '#legacy']);
        const remove = methods.prepareProjectTagsWrite(request({ kind: 'toggle', input: ' #Work ' }));
        if (!remove.ok || remove.value.kind !== 'prepared') throw new Error('remove failed');
        expect(remove.value.prepared.result.tagIds).toEqual(['legacy', 'legacy']);
        const clear = methods.prepareProjectTagsWrite(request({ kind: 'clear' }));
        if (!clear.ok || clear.value.kind !== 'prepared') throw new Error('clear failed');
        expect(clear.value.prepared.result.tagIds).toEqual([]);
        expect(saves()).toBe(0);
        const empty = await open({ projects: [project('target', { tagIds: [] })], settings: {} });
        useTaskStore.setState({ settings: {} });
        expect(empty.methods.prepareProjectTagsWrite(empty.request({ kind: 'clear' }))).toEqual({ ok: true,
            value: { kind: 'noop', result: { id: 'target', tagIds: [] } } });
        expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
        expect(empty.saves()).toBe(0);
    });

    it('matches RN updateProject for a nonarchived Tags edit without changing child rows', async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T16:00:00.000Z'));
        const { methods, request } = await open({ projects: [project('target', { status: 'waiting',
            supportNotes: 'Keep', dueDate: '2026-10-01' })], tasks: [task()], sections: [section()] });
        const input = request({ kind: 'toggle', input: '#Work' });
        const plan = methods.prepareProjectTagsWrite(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const children = { tasks: structuredClone(useTaskStore.getState()._allTasks),
            sections: structuredClone(useTaskStore.getState()._allSections) };
        expect((await useTaskStore.getState().updateProject('target', { tagIds: ['legacy', 'legacy'] })).success)
            .toBe(true);
        expect(useTaskStore.getState()._allProjects[0]).toEqual(plan.value.prepared.effect.project.after);
        expect(useTaskStore.getState()._allTasks).toEqual(children.tasks);
        expect(useTaskStore.getState()._allSections).toEqual(children.sections);
    });

    it('keeps nullable legacy Project members raw through a valid frozen effect', async () => {
        const { methods, request } = await open();
        const nullable = { ...project(), areaId: null, areaTitle: null, supportNotes: null,
            attachments: null, rev: null, revBy: null, deletedAt: null, purgedAt: null } as unknown as Project;
        useTaskStore.setState({ _allProjects: [nullable] });
        const input = request({ kind: 'add', input: 'new' });
        const plan = methods.prepareProjectTagsWrite(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        expect(plan.value.prepared.scope.project).toEqual(nullable);
        expect(plan.value.prepared.effect.project.after).toMatchObject({ areaId: null, supportNotes: null,
            attachments: null, rev: 1, tagIds: ['legacy', '#Work', '#new'] });
        expect(methods.validatePreparedProjectTagsWrite({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
    });

    it('keeps composed and decomposed Unicode tags distinct in frozen results', async () => {
        const composed = '#caf\u00e9';
        const decomposed = '#cafe\u0301';
        const { methods, request } = await open({ projects: [project('target', { tagIds: [composed] })] });
        const input = request({ kind: 'toggle', input: decomposed });
        const plan = methods.prepareProjectTagsWrite(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(plan.value.prepared.result.tagIds).toEqual([composed, decomposed]);
        expect(methods.validatePreparedProjectTagsWrite({ request: input, prepared: plan.value.prepared }))
            .toEqual({ ok: true, value: { id: 'target', tagIds: [composed, decomposed] } });
    });

    it('rejects stale title/status/tags and unavailable or archived Projects before any write', async () => {
        const { methods, request, saves } = await open();
        const input = request({ kind: 'add', input: 'new' });
        for (const expected of [{ ...input.expected, title: 'stale' },
            { ...input.expected, status: 'waiting' as const },
            { ...input.expected, tagIds: ['#changed'] }]) {
            expect(methods.prepareProjectTagsWrite({ ...input, expected })).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
        }
        useTaskStore.setState({ _allProjects: [project('target', { status: 'archived', rev: 4 })] });
        expect(methods.prepareProjectTagsWrite(input)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(methods.getProjectTagsEditOptions({ projectId: 'target' })).toMatchObject({ ok: true,
            value: { canEdit: false } });
        expect(methods.prepareProjectTagsWrite(request({ kind: 'clear' }))).toEqual({ ok: true,
            value: { kind: 'blocked', result: { blocked: '' } } });
        for (const unavailable of [{ deletedAt: now }, { purgedAt: now }]) {
            useTaskStore.setState({ _allProjects: [project('target', unavailable)] });
            expect(methods.getProjectTagsEditOptions({ projectId: 'target' })).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
        }
        expect(saves()).toBe(0);
    });

    it('validates cold exact effect and receipt before mutable checks, and rejects forgeries', async () => {
        const rich = project('target', { supportNotes: 'Keep', areaId: null as never,
            attachments: [{ id: 'a', kind: 'link', title: 'Source', uri: 'https://example.test/',
                createdAt: now, updatedAt: now }] });
        const { methods, request, saves } = await open({ projects: [rich, project('other')] });
        const input = request({ kind: 'toggle', input: 'Work' });
        const plan = methods.prepareProjectTagsWrite(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const frozen = JSON.parse(JSON.stringify(sortKeys({ request: input, prepared: plan.value.prepared }))) as
            { request: typeof input; prepared: typeof plan.value.prepared };
        expect(methods.validatePreparedProjectTagsWrite(frozen)).toEqual({ ok: true, value: plan.value.prepared.result });
        for (const mutation of [
            (value: typeof frozen) => { value.prepared.result.tagIds = ['forged']; },
            (value: typeof frozen) => { value.prepared.effect.project.after.color = '#000'; },
            (value: typeof frozen) => { value.prepared.scope.project.tagIds = ['#changed']; },
            (value: typeof frozen) => { value.prepared.effect.project.after.rev = 3; },
            (value: typeof frozen) => { value.prepared.effect.project.after.supportNotes = 'Changed'; },
            (value: typeof frozen) => { (value.prepared as object as Record<string, unknown>).extra = true; },
        ]) {
            const forged = structuredClone(frozen); mutation(forged);
            expect(methods.validatePreparedProjectTagsWrite(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(await methods.commitPreparedProjectTagsWrite(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        useTaskStore.setState({ _allProjects: [{ ...rich, tagIds: plan.value.prepared.result.tagIds }, project('other')] });
        expect(await methods.commitPreparedProjectTagsWrite(frozen)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allProjects: [{ ...rich, tagIds: ['#concurrent'] }, project('other')] });
        expect(await methods.commitPreparedProjectTagsWrite(frozen)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allProjects: [rich, project('other')] });
        expect(await methods.commitPreparedProjectTagsWrite(frozen)).toMatchObject({ ok: true });
        const count = saves();
        useTaskStore.setState((state) => ({ settings: { ...state.settings, deviceId: 'different-device' },
            _allProjects: [...state._allProjects, project('later')] }));
        expect(await methods.commitPreparedProjectTagsWrite(frozen)).toMatchObject({ ok: true });
        expect(saves()).toBe(count);
        useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'target'
            ? { ...row, title: 'Later title' } : row) }));
        expect(await methods.commitPreparedProjectTagsWrite(frozen)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
    });

    it('retries failed targeted persistence, then replays once across restart', async () => {
        let failed = true;
        const first = await open({ projects: [project()], settings: {} }, () => failed);
        useTaskStore.setState({ settings: {} });
        const input = first.request({ kind: 'toggle', input: '#Work' });
        const plan = first.methods.prepareProjectTagsWrite(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const frozen = { request: input, prepared: plan.value.prepared };
        expect(await first.methods.commitPreparedProjectTagsWrite(frozen)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(first.data().projects[0].tagIds).toEqual(['legacy', '#Work', 'legacy']);
        failed = false;
        expect(await first.methods.commitPreparedProjectTagsWrite(frozen)).toEqual({ ok: true,
            value: { id: 'target', tagIds: ['legacy', 'legacy'] } });
        expect(first.data().projects[0]).toMatchObject({ tagIds: ['legacy', 'legacy'], rev: 4 });
        const second = await open(structuredClone(first.data()));
        await flushPendingSave();
        const count = second.saves();
        expect(await second.methods.commitPreparedProjectTagsWrite(frozen)).toMatchObject({ ok: true });
        expect(second.saves()).toBe(count);
    });

    it('rejects malformed requests, oversized options/envelopes, and capped revisions', async () => {
        const { methods, request, saves } = await open();
        const input = request({ kind: 'add', input: 'new' });
        expect(methods.prepareProjectTagsWrite({ ...input, requestId: input.requestId.toUpperCase() }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.prepareProjectTagsWrite({ ...input, intent: { kind: 'add', input: '  ' } }))
            .toEqual({ ok: true, value: { kind: 'noop', result: { id: 'target',
                tagIds: ['legacy', '#Work', 'legacy'] } } });
        expect(methods.prepareProjectTagsWrite({ ...input, intent: { kind: 'add', input: '漢'.repeat(700_000) } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.prepareProjectTagsWrite({ ...input, intent: { kind: 'clear', input: 'extra' } as never }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.probeProjectTagsWriteOutcome(input)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allProjects: [project('target', { tagIds: ['x'.repeat(2_000_001)] })] });
        expect(methods.getProjectTagsEditOptions({ projectId: 'target' })).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        useTaskStore.setState({ _allProjects: [project('target', { rev: 2_147_483_647 })] });
        const capped = request({ kind: 'add', input: 'next' });
        expect(methods.prepareProjectTagsWrite(capped)).toMatchObject({ ok: false });
        expect(saves()).toBe(0);
        const manySuggestions = await open({ projects: [project(), project('other', {
            tagIds: Array.from({ length: 30 }, (_, index) => `#${index}-${'x'.repeat(80_000)}`),
        })] });
        expect(manySuggestions.methods.getProjectTagsEditOptions({ projectId: 'target' })).toMatchObject({
            ok: false, error: { code: 'INVALID_INPUT' },
        });
    });
});
