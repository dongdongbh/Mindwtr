import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectNotesWriteMethods, type NativeProjectNotesWriteRequest } from './native-host-contract-project-notes';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { PROJECT_SQLITE_COLUMNS, projectToSqliteRow } from './project-sync-schema';
import type { AppData, Project, Section, Task } from './types';

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
        settings: { deviceId: 'notes-device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (fail?.()) throw new Error('disk unavailable');
        data = structuredClone(next); saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const methods = createProjectNotesWriteMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        }, revision: () => 'stable-revision' });
    const request = (text: string): NativeProjectNotesWriteRequest => {
        const options = methods.getProjectNotesEditOptions({ projectId: 'target' });
        if (!options.ok) throw new Error(JSON.stringify(options.error));
        const { id: _id, ...expected } = options.value.project;
        return { requestId: '73799899-d143-40c1-84bd-a09172bba5a4', projectId: 'target', text, expected };
    };
    return { methods, request, data: () => data, saves: () => saves };
}

afterEach(async () => { vi.useRealTimers(); await flushPendingSave(); resetForTests(); });

describe('prepared native raw Project Notes edits', () => {
    it('preserves Unicode, newlines, and spaces verbatim while changing only the target Project row', async () => {
        const original = project('target', { supportNotes: 'Before', attachments: [{ id: 'a', kind: 'link',
            title: 'Source', uri: 'https://example.test/', createdAt: now, updatedAt: now }], dueDate: '2026-10-01' });
        const linkedTask = task();
        const linkedSection = section();
        const other = project('other');
        const raw = ' \n漢字 مرحبا **raw**\n\n  ';
        const attachmentIndex = PROJECT_SQLITE_COLUMNS.indexOf('attachments');
        const beforeAttachmentText = projectToSqliteRow(original)[attachmentIndex];
        const { methods, request, data } = await open({ projects: [original, other],
            tasks: [linkedTask], sections: [linkedSection] });
        const childrenBefore = { tasks: structuredClone(useTaskStore.getState()._allTasks),
            sections: structuredClone(useTaskStore.getState()._allSections) };
        const input = request(raw);
        const plan = methods.prepareProjectNotesWrite(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(plan.value.prepared.effect.project.after).toMatchObject({
            supportNotes: raw, rev: 4, title: original.title, dueDate: original.dueDate,
        });
        expect(await methods.commitPreparedProjectNotesWrite({ request: input, prepared: plan.value.prepared }))
            .toEqual({ ok: true, value: { id: 'target', supportNotes: raw } });
        expect(data().projects[0]).toEqual(plan.value.prepared.effect.project.after);
        expect(projectToSqliteRow(data().projects[0])[attachmentIndex]).toBe(beforeAttachmentText);
        expect(data().projects[1]).toEqual(other);
        expect(data().tasks).toEqual(childrenBefore.tasks);
        expect(data().sections).toEqual(childrenBefore.sections);
        expect(projectToSqliteRow(data().projects[0])[PROJECT_SQLITE_COLUMNS.indexOf('supportNotes')]).toBe(raw);
    });

    it('treats null or absent plus empty as a no-op and stores exact empty when clearing nonempty Notes', async () => {
        for (const initial of [undefined, '']) {
            const { methods, request, saves } = await open({ projects: [project('target', { supportNotes: initial })],
                settings: {} });
            useTaskStore.setState({ settings: {} });
            const before = structuredClone(useTaskStore.getState()._allProjects[0]);
            expect(methods.getProjectNotesEditOptions({ projectId: 'target' })).toMatchObject({ ok: true,
                value: { project: { supportNotes: initial ?? null }, canEdit: true } });
            expect(methods.prepareProjectNotesWrite(request(''))).toEqual({ ok: true,
                value: { kind: 'noop', result: { id: 'target', supportNotes: initial ?? null } } });
            expect(useTaskStore.getState()._allProjects[0]).toEqual(before);
            expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
            expect(saves()).toBe(0);
        }
        const { methods, request, data } = await open({ projects: [project('target', { supportNotes: 'Nonempty' })] });
        const input = request('');
        const plan = methods.prepareProjectNotesWrite(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('clear was not prepared');
        expect(await methods.commitPreparedProjectNotesWrite({ request: input, prepared: plan.value.prepared }))
            .toEqual({ ok: true, value: { id: 'target', supportNotes: '' } });
        expect(data().projects[0]).toMatchObject({ supportNotes: '', rev: 4 });
    });

    it('checks the token before archived/no-op policy and rejects deleted or purged Projects', async () => {
        const { methods, request, saves } = await open({ projects: [project('target', { supportNotes: 'Keep' })] });
        const stale = request('Keep');
        useTaskStore.setState({ _allProjects: [project('target', { supportNotes: 'Keep', status: 'archived', rev: 4 })] });
        expect(methods.prepareProjectNotesWrite(stale)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(methods.getProjectNotesEditOptions({ projectId: 'target' })).toMatchObject({ ok: true,
            value: { canEdit: false } });
        expect(methods.prepareProjectNotesWrite(request('Changed'))).toEqual({ ok: true,
            value: { kind: 'blocked', result: { blocked: '' } } });
        for (const unavailable of [{ deletedAt: now }, { purgedAt: now }]) {
            useTaskStore.setState({ _allProjects: [project('target', unavailable)] });
            expect(methods.getProjectNotesEditOptions({ projectId: 'target' })).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
            expect(methods.prepareProjectNotesWrite(stale)).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
        }
        expect(saves()).toBe(0);
    });

    it('matches the existing RN updateProject lifecycle result without changing children', async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T16:00:00.000Z'));
        const { methods, request } = await open({ projects: [project('target', { status: 'waiting',
            supportNotes: 'Before', attachments: [], dueDate: '2026-10-01' })],
        tasks: [task()], sections: [section()] });
        const input = request('\n Raw after \n');
        const plan = methods.prepareProjectNotesWrite(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const children = { tasks: structuredClone(useTaskStore.getState()._allTasks),
            sections: structuredClone(useTaskStore.getState()._allSections) };
        expect((await useTaskStore.getState().updateProject('target', { supportNotes: input.text })).success).toBe(true);
        expect(useTaskStore.getState()._allProjects[0]).toEqual(plan.value.prepared.effect.project.after);
        expect(useTaskStore.getState()._allTasks).toEqual(children.tasks);
        expect(useTaskStore.getState()._allSections).toEqual(children.sections);
    });

    it('accepts sorted-key journals, exact after-row receipt, and refuses text-only or partial after states', async () => {
        const rich = project('target', { supportNotes: 'Before', attachments: [{ id: 'a', kind: 'link',
            title: 'Source', uri: 'https://example.test/', createdAt: now, updatedAt: now }] });
        const { methods, request, saves } = await open({ projects: [rich, project('other')] });
        const input = request('After');
        const plan = methods.prepareProjectNotesWrite(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const frozen = JSON.parse(JSON.stringify(sortKeys({ request: input, prepared: plan.value.prepared }))) as
            { request: typeof input; prepared: typeof plan.value.prepared };
        expect(methods.validatePreparedProjectNotesWrite(frozen)).toEqual({ ok: true,
            value: { id: 'target', supportNotes: 'After' } });

        useTaskStore.setState({ _allProjects: [{ ...rich, supportNotes: 'After' }, project('other')] });
        expect(await methods.commitPreparedProjectNotesWrite(frozen)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allProjects: [rich, project('other')] });
        expect(await methods.commitPreparedProjectNotesWrite(frozen)).toMatchObject({ ok: true });
        const count = saves();
        useTaskStore.setState((state) => ({ settings: { ...state.settings, deviceId: 'different-device' },
            _allProjects: [...state._allProjects, project('later')] }));
        expect(await methods.commitPreparedProjectNotesWrite(frozen)).toMatchObject({ ok: true,
            value: { supportNotes: 'After' } });
        expect(saves()).toBe(count);
        useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'target'
            ? { ...row, title: 'Later title' } : row) }));
        expect(await methods.commitPreparedProjectNotesWrite(frozen)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(count);
    });

    it('requires exact live before row, including unrelated fields and timestamp collisions', async () => {
        const original = project('target', { supportNotes: 'Before' });
        const { methods, request, saves } = await open({ projects: [original] });
        const input = request('After');
        const plan = methods.prepareProjectNotesWrite(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        for (const changed of [{ ...original, color: '#000000' }, { ...original, supportNotes: 'Concurrent' },
            { ...original, status: 'archived' as const }, { ...original, deletedAt: now },
            { ...original, updatedAt: plan.value.prepared.updateAt, supportNotes: 'Concurrent' }]) {
            useTaskStore.setState({ _allProjects: [changed] });
            expect(await methods.commitPreparedProjectNotesWrite({ request: input, prepared: plan.value.prepared }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        expect(saves()).toBe(0);
    });

    it('retries failed durable persistence without a second revision and initializes missing device atomically', async () => {
        let failed = true;
        const first = await open({ projects: [project('target', { supportNotes: 'Before' })], settings: {} }, () => failed);
        useTaskStore.setState({ settings: {} });
        const input = first.request('After');
        const plan = first.methods.prepareProjectNotesWrite(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(plan.value.prepared.deviceIdBefore).toBeNull();
        expect(plan.value.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f-]+$/);
        const frozen = { request: input, prepared: plan.value.prepared };
        expect(await first.methods.commitPreparedProjectNotesWrite(frozen)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(first.data().projects[0].supportNotes).toBe('Before');
        expect(first.data().settings.deviceId).toBeUndefined();
        failed = false;
        expect(await first.methods.commitPreparedProjectNotesWrite(frozen)).toEqual({ ok: true,
            value: { id: 'target', supportNotes: 'After' } });
        expect(first.data().projects[0]).toMatchObject({ supportNotes: 'After', rev: 4 });
        expect(first.data().settings.deviceId).toBe(plan.value.prepared.deviceIdToInitialize);
        const second = await open(structuredClone(first.data()));
        await flushPendingSave();
        const count = second.saves();
        expect(await second.methods.commitPreparedProjectNotesWrite(frozen)).toMatchObject({ ok: true });
        expect(second.saves()).toBe(count);
    });

    it('rejects malformed, forged, and oversized prepared requests before writing', async () => {
        const { methods, request, saves } = await open({ projects: [project('target', { supportNotes: 'Before' })] });
        const input = request('After');
        const plan = methods.prepareProjectNotesWrite(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const envelope = { request: input, prepared: plan.value.prepared };
        const missing = structuredClone(envelope);
        (missing.prepared.scope.project as Partial<Project>).tagIds = undefined;
        expect(methods.validatePreparedProjectNotesWrite(missing)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const forgedEffect = structuredClone(envelope);
        forgedEffect.prepared.effect.project.after.color = '#000000';
        expect(methods.validatePreparedProjectNotesWrite(forgedEffect)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const forgedText = structuredClone(envelope);
        forgedText.prepared.result.supportNotes = 'Forged';
        expect(methods.validatePreparedProjectNotesWrite(forgedText)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(methods.prepareProjectNotesWrite({ ...input, expected: { ...input.expected, supportNotes: 'Stale' } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(methods.prepareProjectNotesWrite({ ...input, text: '漢'.repeat(700_000) }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.prepareProjectNotesWrite({ ...input, requestId: input.requestId.toUpperCase() }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.probeProjectNotesWriteOutcome(input)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });
});
