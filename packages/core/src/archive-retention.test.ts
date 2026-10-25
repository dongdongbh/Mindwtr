import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getArchiveRetentionPreview } from './archive-retention';
import { applyProjectLifecycleTransition, buildEntityMap } from './store-helpers';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { StorageAdapter } from './storage';
import type { AppData, Project, Section, Task } from './types';
import { mergeAppDataWithStats } from './sync';
import { repairMergedSyncReferences } from './sync-normalization';
import { mockAppData } from './sync-test-utils';
import { markArchiveRetentionSyncCompleted } from './store-archive-retention';
import { withQuickJsArgumentLimit } from './quickjs-test-utils';
import { getSavedTaxonomyTokens } from './taxonomy-catalog';

const NOW = '2026-10-01T12:00:00.000Z';
const OLD = '2026-08-01T12:00:00.000Z';
const RECENT = '2026-09-30T12:00:00.000Z';
const task = (id: string, fields: Partial<Task> = {}): Task => ({
    id, title: id, status: 'archived', tags: [], contexts: [], createdAt: OLD,
    updatedAt: OLD, archivedAt: OLD, rev: 1, revBy: 'device-a', ...fields,
});
const project = (id: string, fields: Partial<Project> = {}): Project => ({
    id, title: id, status: 'archived', color: '#6B7280', order: 0, tagIds: [],
    createdAt: OLD, updatedAt: OLD, archivedAt: OLD, rev: 1, revBy: 'device-a', ...fields,
});
const section = (id: string, projectId: string, fields: Partial<Section> = {}): Section => ({
    id, projectId, title: id, order: 0, createdAt: OLD, updatedAt: OLD,
    deletedAt: OLD, projectArchivedAt: OLD, rev: 1, revBy: 'device-a', ...fields,
});

const install = (tasks: Task[], projects: Project[] = [], sections: Section[] = [], settings: AppData['settings'] = {
    deviceId: 'device-a', gtd: { archiveRetentionDays: 30 },
}) => {
    useTaskStore.setState({
        tasks, projects, sections, areas: [], people: [], settings,
        _allTasks: tasks, _allProjects: projects, _allSections: sections, _allAreas: [], _allPeople: [],
        _tasksById: buildEntityMap(tasks), _projectsById: buildEntityMap(projects),
        _sectionsById: buildEntityMap(sections), _areasById: new Map(), _peopleById: new Map(),
        isLoading: false, editLockCount: 0, persistenceFailure: null, error: null, lastDataChangeAt: 0,
    });
};

describe('Archive retention', () => {
    let saveData: ReturnType<typeof vi.fn>;
    let logs: LogPayload[];
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(NOW));
        logs = [];
        setLogger((payload) => logs.push(payload));
        saveData = vi.fn().mockResolvedValue(undefined);
        setStorageAdapter({
            getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }),
            saveData,
        } as StorageAdapter);
        install([]);
    });
    afterEach(async () => {
        try { await flushPendingSave(); } catch { /* terminal save failure case */ }
        resetForTests();
        setLogger(consoleLogger);
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('selects an archived project with 65536 sections and children, more than a QuickJS call takes arguments', () => {
        const sections = Array.from({ length: 65_536 }, (_, index) => section(`section-${index}`, 'old'));
        const tasks = Array.from({ length: 65_536 }, (_, index) => task(`child-${index}`, { projectId: 'old', status: 'done' }));
        const preview = withQuickJsArgumentLimit(() => getArchiveRetentionPreview({ projects: [project('old')], sections, tasks }, 30, Date.parse(NOW)));
        expect(preview.projectIds).toEqual(['old']);
        expect(preview.sectionIds).toHaveLength(65_536);
        expect(preview.taskIds).toHaveLength(65_536);
    });

    it('selects only old standalone tasks and complete archived project groups', () => {
        const data = {
            projects: [project('old'), project('new', { updatedAt: RECENT }), project('active', { status: 'active' })],
            sections: [section('section-old', 'old')],
            tasks: [
                task('standalone'), task('live-child', { projectId: 'active' }),
                task('group-child', { projectId: 'old', sectionId: 'section-old', status: 'done' }),
                task('section-only', { projectId: undefined, sectionId: 'section-old' }),
                task('new-child', { projectId: 'new', updatedAt: RECENT }),
            ],
        };
        expect(getArchiveRetentionPreview(data, 30, Date.parse(NOW))).toEqual({
            taskIds: ['standalone', 'group-child', 'section-only'], projectIds: ['old'],
            sectionIds: ['section-old'], legacyTaskIds: [], legacyProjectIds: [],
        });
        data.tasks.push(task('reopened', { projectId: undefined, sectionId: 'section-old', status: 'next', updatedAt: RECENT }));
        expect(getArchiveRetentionPreview(data, 30, Date.parse(NOW)).projectIds).toEqual([]);
        expect(getArchiveRetentionPreview(data, 30, Date.parse(NOW)).taskIds).toEqual(['standalone']);
        data.tasks.pop();
        data.sections[0] = section('section-old', 'old', { deletedAt: undefined });
        expect(getArchiveRetentionPreview(data, 30, Date.parse(NOW)).projectIds).toEqual([]);
    });

    it('archives and restores section-only children without changing a conflicting project child', () => {
        const owner = project('owner', { status: 'active', archivedAt: undefined });
        const part = section('part', owner.id, { deletedAt: undefined, projectArchivedAt: undefined });
        const sectionOnly = task('section-only', { projectId: undefined, sectionId: part.id,
            status: 'next', archivedAt: undefined, completedAt: undefined });
        const foreign = task('foreign', { projectId: 'another', sectionId: part.id,
            status: 'next', archivedAt: undefined, completedAt: undefined });
        const archived = applyProjectLifecycleTransition(owner, { status: 'archived' },
            [sectionOnly, foreign], [part], NOW, 'device-a');
        expect(archived.tasks[0]).toMatchObject({ status: 'done', projectId: owner.id,
            sectionId: part.id, archivedAt: NOW, projectArchivedAt: NOW });
        expect(archived.tasks[1]).toBe(foreign);
        const repairedForSync = repairMergedSyncReferences({ tasks: [archived.tasks[0]],
            projects: [{ ...owner, ...archived.projectUpdates }], sections: archived.sections,
            areas: [], people: [], settings: {} }, NOW);
        expect(repairedForSync.tasks[0]).toMatchObject({ projectId: owner.id,
            sectionId: part.id, archivedAt: NOW, projectArchivedAt: NOW });
        const restored = applyProjectLifecycleTransition({ ...owner, ...archived.projectUpdates },
            { status: 'active' }, archived.tasks, archived.sections, RECENT, 'device-a');
        expect(restored.tasks[0]).toMatchObject({ status: 'next', archivedAt: undefined, projectArchivedAt: undefined });
        expect(restored.tasks[1]).toBe(foreign);
    });

    it('starts full new clocks for legacy rows when enabled and rejects invalid days', async () => {
        install([task('legacy', { archivedAt: undefined }), task('bad', { archivedAt: '2026-02-30T12:00:00.000Z' }),
            task('attached-legacy', { projectId: 'live-project', archivedAt: undefined })],
            [project('old-project', { archivedAt: undefined }), project('live-project', { status: 'active' })],
            [], { deviceId: 'device-a' });
        expect((await useTaskStore.getState().setArchiveRetentionDays(30)).success).toBe(true);
        expect(useTaskStore.getState()._allTasks.map((row) => row.archivedAt)).toEqual([NOW, NOW, NOW]);
        expect(useTaskStore.getState()._allProjects[0].archivedAt).toBe(NOW);
        expect(useTaskStore.getState().settings.gtd?.archiveRetentionDays).toBe(30);
        expect(saveData).toHaveBeenCalledTimes(1);
        expect((await useTaskStore.getState().runArchiveRetention({ syncConfigured: false })).success).toBe(true);
        expect(useTaskStore.getState()._allTasks.every((row) => !row.purgedAt)).toBe(true);
        for (const invalid of [-1, 1.5, 36501, NaN, Infinity]) {
            expect((await useTaskStore.getState().setArchiveRetentionDays(invalid)).success).toBe(false);
        }
        expect(saveData).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid generic settings writes and keeps an explicit Never value', async () => {
        await useTaskStore.getState().updateSettings({ gtd: { archiveRetentionDays: 0 } });
        await flushPendingSave();
        expect(useTaskStore.getState().settings.gtd?.archiveRetentionDays).toBe(0);
        saveData.mockClear();
        await useTaskStore.getState().updateSettings({ gtd: { archiveRetentionDays: -1 } });
        expect(useTaskStore.getState().settings.gtd?.archiveRetentionDays).toBe(0);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('recomputes after preview, writes one project group batch with fresh tombstones, and stays no-op', async () => {
        const data = {
            tasks: [task('standalone'), task('child', { projectId: 'group', sectionId: 'part', status: 'done' })],
            projects: [project('group')], sections: [section('part', 'group')],
        };
        install(data.tasks, data.projects, data.sections);
        const preview = getArchiveRetentionPreview(data, 30, Date.parse(NOW));
        expect(preview.projectIds).toEqual(['group']);
        await useTaskStore.getState().updateProject('group', { status: 'active' });
        expect((await useTaskStore.getState().runArchiveRetention({ syncConfigured: false })).success).toBe(true);
        expect(useTaskStore.getState()._projectsById.get('group')?.purgedAt).toBeUndefined();
        expect(useTaskStore.getState()._tasksById.get('child')?.projectId).toBe('group');
        await useTaskStore.getState().updateProject('group', { status: 'archived' });
        // A new archive period protects the whole group; the old preview cannot authorize it.
        expect(getArchiveRetentionPreview({ tasks: useTaskStore.getState()._allTasks,
            projects: useTaskStore.getState()._allProjects, sections: useTaskStore.getState()._allSections }, 30).projectIds).toEqual([]);
        install(data.tasks, data.projects, data.sections);
        logs = [];
        saveData.mockClear();
        expect((await useTaskStore.getState().runArchiveRetention({ syncConfigured: false })).success).toBe(true);
        const saved = saveData.mock.calls.at(-1)?.[0] as AppData;
        expect(saved.tasks.find((row) => row.id === 'child')).toMatchObject({ deletedAt: NOW, purgedAt: NOW });
        expect(saved.projects.find((row) => row.id === 'group')).toMatchObject({ deletedAt: NOW, purgedAt: NOW });
        expect(saved.sections.find((row) => row.id === 'part')?.deletedAt).toBe(NOW);
        expect(saved.tasks.find((row) => row.id === 'child')?.projectId).toBeUndefined(); // compact tombstone, never detached live
        expect(logs.filter((entry) => entry.context?.releaseCheck === 'v1.3.4/archive-retention')).toHaveLength(1);
        saveData.mockClear();
        expect((await useTaskStore.getState().runArchiveRetention({ syncConfigured: false })).success).toBe(true);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('keeps a purged archived Project\'s and task\'s legacy tokens in the saved list (#828)', async () => {
        install([task('standalone', { tags: ['#TaskOnly'], contexts: ['@TaskOnly'] })],
            [project('group', { tagIds: ['#ProjectOnly'] })]);
        expect((await useTaskStore.getState().runArchiveRetention({ syncConfigured: false })).success).toBe(true);
        const saved = saveData.mock.calls.at(-1)?.[0] as AppData;
        expect(saved.projects[0].purgedAt).toBe(NOW);
        expect(getSavedTaxonomyTokens(saved.settings, 'tag')).toEqual(['#ProjectOnly', '#TaskOnly']);
        expect(getSavedTaxonomyTokens(saved.settings, 'context')).toEqual(['@TaskOnly']);
    });

    it('waits for this session to sync so a restore on another device is not purged (R-2)', async () => {
        // Laptop was offline for days: its copy of the task is still archived (rev 2).
        // Meanwhile the phone un-archived and edited it (rev 4).
        install([task('restored-elsewhere', { rev: 2 }), task('still-archived')]);
        const phone = mockAppData([
            task('restored-elsewhere', { status: 'next', archivedAt: undefined, updatedAt: RECENT, rev: 4, revBy: 'phone' }),
            task('still-archived'),
        ]);
        expect((await useTaskStore.getState().runArchiveRetention({ syncConfigured: true })).success).toBe(true);
        expect(saveData).not.toHaveBeenCalled();
        expect(useTaskStore.getState()._allTasks.every((row) => !row.purgedAt)).toBe(true);
        await useTaskStore.getState().runArchiveRetention({ syncConfigured: true });
        expect(logs.filter((entry) => entry.context?.releaseCheck === 'v1.3.5/archive-retention-after-sync')).toHaveLength(1);

        // The first sync merges the phone's restore; only then may retention run.
        const state = useTaskStore.getState();
        const laptop = mockAppData(state._allTasks, state._allProjects);
        laptop.settings = state.settings;
        const merged = mergeAppDataWithStats(laptop, phone, { nowIso: NOW }).data;
        install(merged.tasks, merged.projects, merged.sections, state.settings);
        markArchiveRetentionSyncCompleted();
        expect((await useTaskStore.getState().runArchiveRetention({ syncConfigured: true })).success).toBe(true);
        const saved = saveData.mock.calls.at(-1)?.[0] as AppData;
        expect(saved.tasks.find((row) => row.id === 'restored-elsewhere')).toMatchObject({ status: 'next', rev: 4 });
        expect(saved.tasks.find((row) => row.id === 'restored-elsewhere')?.deletedAt).toBeUndefined();
        expect(saved.tasks.find((row) => row.id === 'still-archived')).toMatchObject({ deletedAt: NOW, purgedAt: NOW });
    });

    it('keeps shared attachment bytes when another task or project survives', async () => {
        const file = { id: 'file', kind: 'file' as const, title: 'file', uri: 'file:///archive-file',
            cloudKey: 'attachments/shared', createdAt: OLD, updatedAt: OLD };
        install([task('expire', { attachments: [file] }), task('keep', { status: 'next', attachments: [file] })],
            [project('keep-project', { status: 'active', attachments: [file] })]);
        await useTaskStore.getState().runArchiveRetention({ syncConfigured: false });
        expect(useTaskStore.getState().settings.attachments?.pendingRemoteDeletes).toBeUndefined();
        expect(useTaskStore.getState()._tasksById.get('keep')?.attachments).toEqual([file]);
        expect(useTaskStore.getState()._projectsById.get('keep-project')?.attachments).toEqual([file]);
    });

    it('defers manual Trash children and skips cleanup during an edit or failed persistence', async () => {
        const data = { tasks: [task('child', { projectId: 'group', deletedAt: RECENT })],
            projects: [project('group')], sections: [section('part', 'group')] };
        expect(getArchiveRetentionPreview(data, 30, Date.parse(NOW)).projectIds).toEqual([]);
        install([task('standalone')]);
        useTaskStore.setState({ editLockCount: 1 });
        expect((await useTaskStore.getState().runArchiveRetention({ syncConfigured: false })).success).toBe(true);
        expect((await useTaskStore.getState().setArchiveRetentionDays(10)).success).toBe(false);
        expect(saveData).not.toHaveBeenCalled();
        useTaskStore.setState({ editLockCount: 0, persistenceFailure: {
            message: 'disk unavailable', failedAt: NOW, retrying: false,
        } });
        expect((await useTaskStore.getState().runArchiveRetention({ syncConfigured: false })).success).toBe(true);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('does not claim successful cleanup when durable save fails', async () => {
        saveData.mockRejectedValue(new Error('disk unavailable'));
        install([task('standalone')]);
        const operation = useTaskStore.getState().runArchiveRetention({ syncConfigured: false });
        await vi.advanceTimersByTimeAsync(30_000);
        expect((await operation).success).toBe(false);
        expect(logs.some((entry) => entry.context?.releaseCheck === 'v1.3.4/archive-retention')).toBe(false);
        expect(useTaskStore.getState().persistenceFailure).not.toBeNull();
        resetForTests();
    });

    it('keeps an equivalent old-peer omission but defers a newer missing clock', () => {
        const current = mockAppData([
            task('sync-task'), task('sync-done', { status: 'done', projectId: 'sync-project' }),
            task('sync-reference', { status: 'reference', projectId: 'sync-project' }),
        ], [project('sync-project')]);
        const sameOldPeer = structuredClone(current);
        delete sameOldPeer.tasks[0].archivedAt;
        delete sameOldPeer.projects[0].archivedAt;
        const first = mergeAppDataWithStats(current, sameOldPeer, { nowIso: NOW }).data;
        expect(first.tasks[0].archivedAt).toBe(OLD);
        expect(first.tasks.slice(1).map((row) => row.archivedAt)).toEqual([OLD, OLD]);
        expect(first.projects[0].archivedAt).toBe(OLD);
        const second = mergeAppDataWithStats(first, current, { nowIso: NOW });
        expect(second.data).toEqual(first);
        expect(second.stats.tasks.conflicts).toBe(0);
        expect(second.stats.projects.conflicts).toBe(0);

        const newerOldPeer = structuredClone(sameOldPeer);
        newerOldPeer.tasks[0].rev = 2;
        newerOldPeer.tasks[0].updatedAt = RECENT;
        newerOldPeer.projects[0].rev = 2;
        newerOldPeer.projects[0].updatedAt = RECENT;
        const merged = mergeAppDataWithStats(current, newerOldPeer, { nowIso: NOW }).data;
        expect(merged.tasks[0].archivedAt).toBeUndefined();
        expect(merged.projects[0].archivedAt).toBeUndefined();
        expect(getArchiveRetentionPreview(merged, 30, Date.parse(NOW)).legacyProjectIds).toEqual(['sync-project']);
    });

    it('keeps explicit Never across a peer with no retention setting', () => {
        const local = mockAppData();
        local.settings.gtd = { archiveRetentionDays: 0 };
        local.settings.syncPreferencesUpdatedAt = { gtd: NOW };
        const oldPeer = mockAppData();
        oldPeer.settings.gtd = {};
        expect(mergeAppDataWithStats(local, oldPeer, { nowIso: NOW }).data.settings.gtd?.archiveRetentionDays).toBe(0);
    });
});
