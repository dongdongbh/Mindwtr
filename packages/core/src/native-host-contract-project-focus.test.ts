import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectFocusMethods, type NativeProjectFocusRequest } from './native-host-contract-project-focus';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { PROJECT_SQLITE_COLUMNS, projectToSqliteRow } from './project-sync-schema';
import { sameAreaAdditionRow } from './store-projects/area-actions';
import type { AppData, Project } from './types';

const now = '2026-09-28T15:00:00.000Z';
const project = (id = 'target', overrides: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#3b82f6', order: 0, tagIds: ['#work'],
    rev: 3, revBy: 'older-device', createdAt: now, updatedAt: now, ...overrides,
});
const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortKeys(nested)])) : value;

async function open(initial: Partial<AppData> = {}, fail?: () => boolean) {
    await flushPendingSave(); resetForTests();
    let data: AppData = { tasks: [], projects: [project()], sections: [], areas: [], people: [],
        settings: { deviceId: 'focus-device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (fail?.()) throw new Error('disk unavailable');
        data = structuredClone(next); saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const methods = createProjectFocusMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        }, revision: () => 'revision' });
    const request = (focused = true): NativeProjectFocusRequest => {
        const options = methods.getProjectFocusOptions({ projectId: 'target' });
        if (!options.ok) throw new Error(JSON.stringify(options.error));
        const { id: _id, ...expected } = options.value.project;
        return { requestId: 'b9920977-0124-4c08-abd9-0825e220d383', projectId: 'target', focused, expected };
    };
    return { methods, request, data: () => data, saves: () => saves };
}

afterEach(async () => { vi.useRealTimers(); await flushPendingSave(); resetForTests(); });

describe('prepared native Project Focus', () => {
    it('uses the RN focus policy, revises only the target, and updates derived Focus', async () => {
        const original = project();
        const unrelated = project('other', { status: 'someday' });
        const { methods, request, data } = await open({ projects: [original, unrelated] });
        expect(methods.getProjectFocusOptions({ projectId: 'target' })).toMatchObject({ ok: true,
            value: { focusedProjectCount: 0, limit: 5, project: { isFocused: false } } });
        const input = request();
        const plan = methods.prepareProjectFocus(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared', prepared: {
            scope: { focusedProjectCount: 0 }, effect: { project: { after: { isFocused: true, rev: 4,
                revBy: 'focus-device' } } } } } });
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(methods.validatePreparedProjectFocus({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true, value: { id: 'target', focused: true } });
        expect(await methods.commitPreparedProjectFocus({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true, value: { id: 'target', focused: true } });
        expect(data().projects[0]).toEqual(plan.value.prepared.effect.project.after);
        expect(data().projects[1]).toEqual(unrelated);
        expect(useTaskStore.getState().getDerivedState().focusedProjectCount).toBe(1);
        const off = methods.prepareProjectFocus(request(false));
        expect(off).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!off.ok || off.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(await methods.commitPreparedProjectFocus({ request: request(false), prepared: off.value.prepared }))
            .toMatchObject({ ok: true, value: { id: 'target', focused: false } });
        expect(data().projects[0].rev).toBe(5);
        expect(useTaskStore.getState().getDerivedState().focusedProjectCount).toBe(0);
    });

    it('preserves the RN inactive and five-star policies without journaling no-op or blocked choices', async () => {
        const focused = Array.from({ length: 5 }, (_, index) => project(`focused-${index}`, {
            status: index === 0 ? 'archived' : index === 1 ? 'someday' : 'active', isFocused: true,
        }));
        const deleted = project('deleted', { isFocused: true, deletedAt: now });
        const { methods, request, saves } = await open({ projects: [project(), ...focused, deleted] });


        useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'focused-0'
            ? { ...row, isFocused: true } : row) }));
        expect(methods.getProjectFocusOptions({ projectId: 'target' })).toMatchObject({ ok: true,
            value: { focusedProjectCount: 5, limit: 5 } });
        expect(methods.prepareProjectFocus(request())).toEqual({ ok: true,
            value: { kind: 'blocked', result: { blocked: '' } } });
        expect(methods.prepareProjectFocus(request(false))).toEqual({ ok: true,
            value: { kind: 'noop', result: { id: 'target', focused: false } } });
        expect(saves()).toBe(0);

        const inactive = project('target', { status: 'waiting' });
        useTaskStore.setState((state) => ({ _allProjects: [inactive, ...state._allProjects.slice(1)] }));
        expect(methods.prepareProjectFocus(request())).toEqual({ ok: true,
            value: { kind: 'blocked', result: { blocked: '' } } });
        const alreadyFocused = { ...inactive, isFocused: true };
        useTaskStore.setState((state) => ({ _allProjects: [alreadyFocused, ...state._allProjects.slice(1)] }));
        const off = methods.prepareProjectFocus(request(false));
        expect(off).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!off.ok || off.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(await methods.commitPreparedProjectFocus({ request: request(false), prepared: off.value.prepared }))
            .toMatchObject({ ok: true, value: { id: 'target', focused: false } });
    });

    it('accepts a sorted-key journal, preserves attachment SQL text, and receipts before later cap changes', async () => {
        const attachment = { id: 'a', kind: 'link' as const, title: 'Source', uri: 'https://example.test/',
            createdAt: now, updatedAt: now };
        const target = project('target', { attachments: [attachment, { ...attachment, id: 'b' }],
            supportNotes: 'Keep notes', areaTitle: 'Work' });
        const other = project('other', { status: 'archived' });
        const attachmentIndex = PROJECT_SQLITE_COLUMNS.indexOf('attachments');
        const beforeText = projectToSqliteRow(target)[attachmentIndex];
        const { methods, request, data, saves } = await open({ projects: [target, other] });
        const unrelatedBefore = useTaskStore.getState()._allProjects.find((row) => row.id === other.id);
        const input = request();
        const plan = methods.prepareProjectFocus(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const frozen = JSON.parse(JSON.stringify(sortKeys({ request: input, prepared: plan.value.prepared }))) as
            { request: typeof input; prepared: typeof plan.value.prepared };
        expect(methods.validatePreparedProjectFocus(frozen)).toMatchObject({ ok: true });
        expect(await methods.commitPreparedProjectFocus(frozen)).toMatchObject({ ok: true,
            value: { id: 'target', focused: true } });
        expect(projectToSqliteRow(data().projects[0])[attachmentIndex]).toBe(beforeText);
        expect(data().projects[1]).toEqual(unrelatedBefore);
        const count = saves();
        useTaskStore.setState((state) => ({ _allProjects: [...state._allProjects,
            ...Array.from({ length: 4 }, (_, index) => project(`new-${index}`, { isFocused: true }))] }));
        expect(await methods.commitPreparedProjectFocus(frozen)).toMatchObject({ ok: true });
        expect(saves()).toBe(count);
        useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'target'
            ? { ...row, supportNotes: 'Later edit' } : row) }));
        expect(await methods.commitPreparedProjectFocus(frozen)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(count);
        expect(sameAreaAdditionRow.project(target, sortKeys(target) as Project)).toBe(true);
        expect(sameAreaAdditionRow.project(target, { ...target,
            attachments: [...target.attachments!].reverse() })).toBe(false);
    });

    it('refuses changed target metadata or newly full capacity before first apply', async () => {
        const original = project();
        const { methods, request, saves } = await open({ projects: [original] });
        const input = request();
        const plan = methods.prepareProjectFocus(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const envelope = { request: input, prepared: plan.value.prepared };
        useTaskStore.setState({ _allProjects: [{ ...original, supportNotes: 'Changed' }] });
        expect(await methods.commitPreparedProjectFocus(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allProjects: [original,
            ...Array.from({ length: 5 }, (_, index) => project(`full-${index}`, { isFocused: true }))] });
        expect(await methods.commitPreparedProjectFocus(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });

    it('allows first apply when unrelated Focus membership changed but capacity still permits', async () => {
        const original = project();
        const { methods, request, data } = await open({ projects: [original] });
        const input = request();
        const plan = methods.prepareProjectFocus(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const extra = project('extra', { isFocused: true });
        useTaskStore.setState({ _allProjects: [original, extra] });
        expect(await methods.commitPreparedProjectFocus({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true, value: { id: 'target', focused: true } });
        expect(data().projects.map((row) => row.id)).toEqual(['target', 'extra']);
        expect(data().projects[1]).toEqual(extra);
        expect(useTaskStore.getState().getDerivedState().focusedProjectCount).toBe(2);
    });

    it('checks the exact expected token before returning a no-op or blocked result', async () => {
        const focused = Array.from({ length: 5 }, (_, index) => project(`focused-${index}`, { isFocused: true }));
        const { methods, request, saves } = await open({ projects: [project(), ...focused] });
        const noop = request(false);
        const blocked = request(true);
        useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'target'
            ? { ...row, title: 'Renamed', rev: 4 } : row) }));
        expect(methods.prepareProjectFocus(noop)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(methods.prepareProjectFocus(blocked)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });

    it('retries a failed save with the identical frozen effect and initializes a missing device ID once', async () => {
        let failed = true;
        const first = await open({ settings: {} }, () => failed);
        useTaskStore.setState({ settings: {} });
        const input = first.request();
        const plan = first.methods.prepareProjectFocus(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(plan.value.prepared.deviceIdBefore).toBeNull();
        const frozen = { request: input, prepared: plan.value.prepared };
        expect(await first.methods.commitPreparedProjectFocus(frozen)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(first.data().projects[0].isFocused).toBeUndefined();
        failed = false;
        expect(await first.methods.commitPreparedProjectFocus(frozen)).toMatchObject({ ok: true,
            value: { id: 'target', focused: true } });
        expect(first.data().projects[0].rev).toBe(4);
        expect(first.data().settings.deviceId).toBe(plan.value.prepared.deviceIdToInitialize);
        const second = await open(structuredClone(first.data()));
        await flushPendingSave();
        const count = second.saves();
        expect(await second.methods.commitPreparedProjectFocus(frozen)).toMatchObject({ ok: true });
        expect(second.saves()).toBe(count);
    });

    it('rejects forged and oversized journals and probes nil pending without a write', async () => {
        const { methods, request, saves } = await open();
        const input = request();
        const plan = methods.prepareProjectFocus(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const envelope = { request: input, prepared: plan.value.prepared };
        const omitted = structuredClone(envelope);
        (omitted.prepared.scope.project as Partial<Project>).tagIds = undefined;
        expect(methods.validatePreparedProjectFocus(omitted)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const changed = structuredClone(envelope);
        changed.prepared.effect.project.after.supportNotes = 'forged';
        expect(methods.validatePreparedProjectFocus(changed)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const count = structuredClone(envelope);
        count.prepared.scope.focusedProjectCount = 5;
        expect(methods.validatePreparedProjectFocus(count)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(methods.prepareProjectFocus({ ...input, projectId: '漢'.repeat(800_000) }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.probeProjectFocusOutcome(input)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });
});
