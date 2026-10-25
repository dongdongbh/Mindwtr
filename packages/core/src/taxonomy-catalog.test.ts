import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { addSavedTaxonomyToken, getSavedTaxonomyTokens, isTaxonomyCatalog, mergeTaxonomyCatalog, normalizeTaxonomyToken,
    planTaxonomyCatalogChange, retainProjectTaxonomy, retainTaskTaxonomy, retainTaxonomyEffects } from './taxonomy-catalog';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { SqliteAdapter } from './sqlite-adapter';
import { mergeSettingsForSync } from './sync-merge-settings';
import { areSyncPayloadsEqual, sanitizeAppDataForRemote } from './sync-helpers';
import { prepareRestoredBackupDataForSync, validateBackupJson } from './backup-transfer';
import { parseSyncDocument } from './sync-document';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import type { AppData, AppSettings, Project, Task } from './types';

const AT = '2026-10-20T12:00:00.000Z';
const task = (extra: Partial<Task> = {}): Task => ({ id: 'task', title: 'task', status: 'next',
    contexts: ['@Legacy'], tags: [], rev: 1, revBy: 'device', createdAt: AT, updatedAt: AT, ...extra });
const document = (settings: AppSettings = { deviceId: 'device' }, tasks: Task[] = []): AppData =>
    ({ tasks, projects: [], sections: [], areas: [], people: [], settings });

async function open(data = document()) {
    await flushPendingSave(); resetForTests();
    let saved = structuredClone(data);
    const saveTask = vi.fn(async () => undefined);
    setStorageAdapter({ getData: async () => structuredClone(saved), saveTask,
        saveData: async (next) => { saved = structuredClone(next); } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
    return { saved: () => saved, saveTask };
}

afterEach(async () => { await flushPendingSave(); resetForTests(); setLogger(consoleLogger); });

describe('saved contexts and tags', () => {
    it('rejects a failed durable create and emits no persisted diagnostic', async () => {
        const env = await open();
        const lines: LogPayload[] = [];
        setLogger((line) => { lines.push(line); });
        setStorageAdapter({ getData: async () => env.saved(), saveData: async () => { throw new Error('disk unavailable'); } });
        try {
            await expect(useTaskStore.getState().addContext('@Unsaved')).rejects.toThrow();
            expect(env.saved().settings.taxonomy).toBeUndefined();
            expect(lines.filter((line) => line.context?.releaseCheck === 'v1.3.7/saved-taxonomy')).toEqual([]);
        } finally { resetForTests(); }
    }, 15_000);
    it('keeps token length bounds and tied merges independent of JSON object property order', () => {
        expect(normalizeTaxonomyToken('context', 'x'.repeat(500))).toBe('');
        expect(normalizeTaxonomyToken('context', 'x'.repeat(499))).toHaveLength(500);
        const entry = { token: '@Work', rev: 1, revBy: 'b', updatedAt: AT };
        const left = { contexts: [entry] };
        const right = { contexts: [{ updatedAt: AT, revBy: 'a', rev: 1, token: '@Home' }] };
        expect(mergeTaxonomyCatalog(left, right)).toEqual(mergeTaxonomyCatalog(right, left));
        const reordered = { contexts: [{ updatedAt: AT, revBy: 'b', rev: 1, token: '@work' }] };
        expect(mergeTaxonomyCatalog(left, reordered)).toEqual(mergeTaxonomyCatalog(reordered, left));
        expect(isTaxonomyCatalog({ contexts: [{ ...entry, updatedAt: 'Oct 20 2026' }] })).toBe(false);
        expect(parseSyncDocument(document({ taxonomy: { contexts: [{ ...entry, rev: -1 }] } }), 'remote').ok).toBe(false);
    });

    it('retains large distinct-token batches with one catalogue publication', () => {
        const effects = Array.from({ length: 5_000 }, (_, index) => ({ after: task({ id: String(index),
            contexts: [`@context${index}`], tags: [`#tag${index}`] }) }));
        const before = performance.now();
        const settings = retainTaxonomyEffects({ deviceId: 'device' }, effects);
        expect(settings.taxonomy?.contexts).toHaveLength(5_000);
        expect(settings.taxonomy?.tags).toHaveLength(5_000);
        expect(performance.now() - before).toBeLessThan(2_000);
    });

    it('restores catalogue revisions above current tombstones and enrolls an old backup only during restore', () => {
        const saved = addSavedTaxonomyToken({ deviceId: 'a' }, 'context', '@Legacy', 'a', AT);
        const previous = document(addSavedTaxonomyToken(saved, 'context', '@Legacy', 'a', AT, true));
        const restored = prepareRestoredBackupDataForSync(document(saved, [task()]), { previousData: previous, restoredAt: AT });
        expect(restored.settings.taxonomy?.contexts?.[0].rev).toBeGreaterThan(previous.settings.taxonomy!.contexts![0].rev);
        expect(getSavedTaxonomyTokens(mergeSettingsForSync(restored.settings, previous.settings), 'context')).toEqual(['@Legacy']);
        const old = prepareRestoredBackupDataForSync(document({ deviceId: 'a' }, [task()]), { restoredAt: AT });
        expect(getSavedTaxonomyTokens(old.settings, 'context')).toEqual(['@Legacy']);
    });
    it('creates unused values durably, dedupes case, and refreshes derived suggestions', async () => {
        const env = await open();
        expect(useTaskStore.getState().getDerivedState().allContexts).toEqual([]);
        await useTaskStore.getState().addContext(' Home ');
        await useTaskStore.getState().addContext('@home');
        await useTaskStore.getState().addTag('＃Work');
        expect(getSavedTaxonomyTokens(env.saved().settings, 'context')).toEqual(['@Home']);
        expect(env.saved().settings.taxonomy?.contexts).toHaveLength(1);
        expect(useTaskStore.getState().getDerivedState().allContexts).toEqual(['@Home']);
        expect(useTaskStore.getState().getDerivedState().allTags).toEqual(['#Work']);
        await useTaskStore.getState().fetchData({ throwOnError: true });
        expect(useTaskStore.getState().getDerivedState().allContexts).toEqual(['@Home']);
        for (const name of ['', ' @# ', 'bad\nname', 'x'.repeat(501)])
            await expect(useTaskStore.getState().addContext(name)).rejects.toThrow('Invalid context');
    });

    it('saves inline assignment and catalogue together, including the single-row fast path', async () => {
        const env = await open(document({ deviceId: 'device' }, [task({ contexts: [] })]));
        await useTaskStore.getState().updateTask('task', { contexts: ['@New'], tags: ['#Inline'] });
        await flushPendingSave();
        expect(env.saveTask).not.toHaveBeenCalled();
        expect(env.saved().tasks[0].contexts).toEqual(['@New']);
        expect(getSavedTaxonomyTokens(env.saved().settings, 'context')).toEqual(['@New']);
        await useTaskStore.getState().updateTask('task', { contexts: [], tags: [] });
        await flushPendingSave();
        expect(getSavedTaxonomyTokens(useTaskStore.getState().settings, 'context')).toEqual(['@New']);
    });

    it('retains tokens introduced by a native prepared capture in its exact saved snapshot', async () => {
        const env = await open();
        const prepared = task({ id: 'native-created', contexts: ['@Prepared'], tags: ['#Native'] });
        const applied = await useTaskStore.getState().commitPreparedCapture({ task: prepared, project: null,
            deviceIdBefore: 'device', deviceIdToInitialize: null });
        expect(applied).toMatchObject({ success: true });
        await flushPendingSave();
        expect(env.saved().tasks.find((row) => row.id === prepared.id)).toEqual(prepared);
        expect(env.saved().settings.taxonomy).toEqual(useTaskStore.getState().settings.taxonomy);
        expect(getSavedTaxonomyTokens(env.saved().settings, 'context')).toEqual(['@Prepared']);
        expect(getSavedTaxonomyTokens(env.saved().settings, 'tag')).toEqual(['#Native']);
        await useTaskStore.getState().deleteTask(prepared.id);
        await flushPendingSave();
        expect(getSavedTaxonomyTokens(env.saved().settings, 'context')).toEqual(['@Prepared']);
    });

    it.each(['edit', 'delete'] as const)('retains legacy last-use values on explicit %s without a load migration', async (action) => {
        const env = await open(document({ deviceId: 'device' }, [task()]));
        expect(useTaskStore.getState().settings.taxonomy).toBeUndefined();
        if (action === 'edit') await useTaskStore.getState().updateTask('task', { contexts: [] });
        else await useTaskStore.getState().deleteTask('task');
        await flushPendingSave();
        expect(getSavedTaxonomyTokens(env.saved().settings, 'context')).toEqual(['@Legacy']);
    });

    it('retains a task token only when the write can make it unused', () => {
        const settings: AppSettings = { deviceId: 'device' };
        const before = task({ contexts: ['@Kept', '@Dropped'], tags: ['#Legacy'] });
        const later = { updatedAt: '2026-10-21T12:00:00.000Z', rev: 2 };
        // Status, focus, title and order writes leave every token in use: settings stay the same object.
        for (const change of [{ status: 'waiting' as const }, { status: 'reference' as const }, { isFocusedToday: true },
            { title: 'renamed' }, { order: 3 }]) expect(retainTaskTaxonomy(settings, before, { ...before, ...later, ...change })).toBe(settings);
        const removed = retainTaskTaxonomy(settings, before, { ...before, ...later, contexts: ['@Kept'] });
        expect(getSavedTaxonomyTokens(removed, 'context')).toEqual(['@Dropped']);
        expect(getSavedTaxonomyTokens(removed, 'tag')).toEqual([]);
        // Delete leaves every list; Done leaves the Contexts pickers; Archived leaves the visible task list.
        for (const change of [{ deletedAt: later.updatedAt }, { status: 'done' as const }, { status: 'archived' as const }]) {
            const left = retainTaskTaxonomy(settings, before, { ...before, ...later, ...change });
            expect(getSavedTaxonomyTokens(left, 'context')).toEqual(['@Dropped', '@Kept']);
            expect(getSavedTaxonomyTokens(left, 'tag')).toEqual(['#Legacy']);
        }
        expect(getSavedTaxonomyTokens(retainTaskTaxonomy(settings, before, { ...before, ...later, tags: ['#Legacy', '#New'] }), 'tag'))
            .toEqual(['#New']);
        // A row already Done or Archived left those lists earlier: editing it again writes nothing.
        for (const status of ['done', 'archived'] as const) {
            const finished = { ...before, status };
            expect(retainTaskTaxonomy(settings, finished, { ...finished, ...later, title: 'renamed' })).toBe(settings);
        }
        const done = { ...before, status: 'done' as const };
        expect(getSavedTaxonomyTokens(retainTaskTaxonomy(settings, done, { ...done, ...later, status: 'archived' }), 'tag'))
            .toEqual(['#Legacy']);
    });

    it('retains a Project tag only when it is removed or the Project is deleted', () => {
        const settings: AppSettings = { deviceId: 'device' };
        const before: Project = { id: 'project', title: 'Project', status: 'active', color: '#94a3b8', order: 0,
            tagIds: ['#Kept', '#Dropped'], rev: 1, revBy: 'device', createdAt: AT, updatedAt: AT };
        const later = { updatedAt: '2026-10-21T12:00:00.000Z', rev: 2 };
        for (const change of [{ title: 'renamed' }, { status: 'someday' as const }, { status: 'archived' as const }, { isFocused: true }])
            expect(retainProjectTaxonomy(settings, before, { ...before, ...later, ...change })).toBe(settings);
        expect(getSavedTaxonomyTokens(retainProjectTaxonomy(settings, before, { ...before, ...later, tagIds: ['#Kept'] }), 'tag'))
            .toEqual(['#Dropped']);
        expect(getSavedTaxonomyTokens(retainProjectTaxonomy(settings, before, { ...before, ...later, deletedAt: later.updatedAt }), 'tag'))
            .toEqual(['#Dropped', '#Kept']);
    });

    it('saves a status-only edit of a legacy-tagged task as one row and retains its tokens on completion', async () => {
        const env = await open(document({ deviceId: 'device' }, [task({ tags: ['#Legacy'] })]));
        await useTaskStore.getState().updateTask('task', { status: 'waiting' });
        await flushPendingSave();
        expect(env.saveTask).toHaveBeenCalledTimes(1);
        expect(env.saved().settings.taxonomy).toBeUndefined();
        await useTaskStore.getState().updateTask('task', { status: 'done' });
        await flushPendingSave();
        expect(getSavedTaxonomyTokens(env.saved().settings, 'context')).toEqual(['@Legacy']);
        expect(getSavedTaxonomyTokens(env.saved().settings, 'tag')).toEqual(['#Legacy']);
    });

    it('retains the tokens of tasks that completing a Project archives', async () => {
        const project: Project = { id: 'project', title: 'Project', status: 'active', color: '#94a3b8', order: 0,
            rev: 1, revBy: 'device', createdAt: AT, updatedAt: AT };
        const env = await open({ ...document({ deviceId: 'device' }, [task({ projectId: 'project', tags: ['#Legacy'] })]),
            projects: [project] });
        const logs: LogPayload[] = [];
        setLogger((payload) => { logs.push(payload); });
        expect((await useTaskStore.getState().updateProject('project', { status: 'archived' })).success).toBe(true);
        await flushPendingSave();
        expect(logs.filter((log) => log.message === 'Project archive taxonomy retained').map((log) => log.context))
            .toEqual([{ releaseCheck: 'v1.3.8/project-archive-taxonomy', operation: 'update' }]);
        expect(env.saved().tasks[0].status).toBe('done');
        expect(getSavedTaxonomyTokens(env.saved().settings, 'context')).toEqual(['@Legacy']);
        expect(getSavedTaxonomyTokens(env.saved().settings, 'tag')).toEqual(['#Legacy']);
    });

    it('keeps a legacy token through the automatic Done-to-Archived pass on load and on a settings change', async () => {
        const stale = task({ status: 'done', tags: ['#Legacy'], completedAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z' });
        const loaded = await open(document({ deviceId: 'device', gtd: { autoArchiveDays: 7 } }, [stale]));
        expect(loaded.saved().tasks[0].status).toBe('archived');
        expect(getSavedTaxonomyTokens(loaded.saved().settings, 'tag')).toEqual(['#Legacy']);
        // A library with no device ID gets one from an earlier load step, so it keeps the token too.
        const anonymous = await open(document({ gtd: { autoArchiveDays: 7 } }, [stale]));
        expect(anonymous.saved().tasks[0].status).toBe('archived');
        expect(getSavedTaxonomyTokens(anonymous.saved().settings, 'tag')).toEqual(['#Legacy']);
        const changed = await open(document({ deviceId: 'device', gtd: { autoArchiveDays: 0 } }, [stale]));
        await useTaskStore.getState().updateSettings({ gtd: { autoArchiveDays: 7 } });
        await flushPendingSave();
        expect(changed.saved().tasks[0].status).toBe('archived');
        expect(getSavedTaxonomyTokens(changed.saved().settings, 'tag')).toEqual(['#Legacy']);
    });

    it('keeps a skipped recurring occurrence\'s tokens in use through its follow-up', async () => {
        const env = await open(document({ deviceId: 'device' }, [task({ tags: ['#Legacy'], dueDate: '2026-10-20',
            recurrence: { rule: 'daily', strategy: 'strict' } })]));
        expect((await useTaskStore.getState().skipRecurringTaskOccurrence('task')).success).toBe(true);
        await flushPendingSave();
        const live = env.saved().tasks.filter((row) => !row.deletedAt && row.status !== 'archived');
        expect(live.map((row) => [row.contexts, row.tags])).toEqual([[['@Legacy'], ['#Legacy']]]);
        expect(useTaskStore.getState().getDerivedState().allTags).toEqual(['#Legacy']);
    });

    it('keeps deletion tombstones through unrelated edits and permits intentional assignment again', () => {
        const initial = addSavedTaxonomyToken({ deviceId: 'a' }, 'context', '@Legacy', 'a', AT, true);
        const before = task();
        expect(retainTaskTaxonomy(initial, before, { ...before, title: 'edited' })).toBe(initial);
        expect(retainTaskTaxonomy(initial, before, { ...before, contexts: [] })).toBe(initial);
        const restored = retainTaskTaxonomy(initial, { ...before, contexts: [] }, before);
        expect(getSavedTaxonomyTokens(restored, 'context')).toEqual(['@Legacy']);
        expect(restored.taxonomy?.contexts?.[0].rev).toBe(2);
    });

    it('renames and deletes unused and assigned values without changing unrelated assignments', async () => {
        const env = await open();
        await useTaskStore.getState().addContext('@Unused');
        await useTaskStore.getState().renameContext('@unused', '@Renamed');
        expect(getSavedTaxonomyTokens(env.saved().settings, 'context')).toEqual(['@Renamed']);
        await useTaskStore.getState().deleteContext('@Renamed');
        expect(useTaskStore.getState().getDerivedState().allContexts).toEqual([]);
        const result = await useTaskStore.getState().addTask('assigned', { contexts: ['@Home', '@Other'] });
        await useTaskStore.getState().renameContext('@Home', '@Office');
        expect(env.saved().tasks.find((row) => row.id === result.id)?.contexts).toEqual(['@Office', '@Other']);
        expect(getSavedTaxonomyTokens(env.saved().settings, 'context')).toContain('@Office');
        expect(getSavedTaxonomyTokens(env.saved().settings, 'context')).not.toContain('@Home');
    });

    it('merges independent edits, retains tombstones, and converges with an omitted old-peer field', () => {
        const left = addSavedTaxonomyToken({}, 'context', '@Home', 'a', AT);
        const right = addSavedTaxonomyToken({}, 'tag', '#Work', 'b', AT);
        const merged = mergeSettingsForSync(left, right);
        expect(merged.taxonomy).toEqual(mergeSettingsForSync(right, left).taxonomy);
        const deleted = addSavedTaxonomyToken(left, 'context', '@Home', 'a', AT, true);
        expect(getSavedTaxonomyTokens(mergeSettingsForSync(deleted, merged), 'context')).toEqual([]);
        expect(mergeTaxonomyCatalog(merged.taxonomy, undefined)).toEqual(merged.taxonomy);
        const again = mergeSettingsForSync(merged, {});
        expect(again.taxonomy).toEqual(merged.taxonomy);
        expect(mergeSettingsForSync(again, merged).taxonomy).toEqual(merged.taxonomy);
        expect(areSyncPayloadsEqual(document(again), document(merged))).toBe(true);
    });

    it('converges concurrent rename destinations and a tied create/delete without restoring removed names', () => {
        const base = addSavedTaxonomyToken({}, 'context', '@Old', 'a', AT).taxonomy!;
        const left = planTaxonomyCatalogChange(base, 'context', 'rename', '@Old', '@Left', 'a', AT);
        const right = planTaxonomyCatalogChange(base, 'context', 'rename', '@Old', '@Right', 'b', AT);
        const merged = mergeTaxonomyCatalog(left, right);
        expect(merged).toEqual(mergeTaxonomyCatalog(right, left));
        expect(getSavedTaxonomyTokens({ taxonomy: merged }, 'context')).toEqual(['@Left', '@Right']);
        expect(merged?.contexts?.find((entry) => entry.token === '@Old')?.deletedAt).toBe(AT);
        expect(mergeTaxonomyCatalog(merged, left)).toEqual(merged);
        const created = addSavedTaxonomyToken({}, 'tag', '#Concurrent', 'b', AT).taxonomy!;
        const deleted = addSavedTaxonomyToken({}, 'tag', '#Concurrent', 'a', AT, true).taxonomy!;
        const removed = mergeTaxonomyCatalog(created, deleted);
        expect(removed).toEqual(mergeTaxonomyCatalog(deleted, created));
        expect(getSavedTaxonomyTokens({ taxonomy: removed }, 'tag')).toEqual([]);
        const readded = addSavedTaxonomyToken({ taxonomy: removed }, 'tag', '#Concurrent', 'b', AT).taxonomy!;
        expect(getSavedTaxonomyTokens({ taxonomy: mergeTaxonomyCatalog(removed, readded) }, 'tag')).toEqual(['#Concurrent']);
    });

    it('round-trips through SQLite, backup JSON and the synced settings record', async () => {
        const db = new DatabaseSync(':memory:');
        try {
            const adapter = new SqliteAdapter({ exec: async (sql) => { db.exec(sql); },
                run: async (sql, params = []) => { db.prepare(sql).run(...params as SQLInputValue[]); },
                all: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params as SQLInputValue[]) as T[],
                get: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params as SQLInputValue[]) as T | undefined });
            const settings = addSavedTaxonomyToken({ deviceId: 'a' }, 'tag', '#Unused', 'a', AT);
            const data = document(settings);
            await adapter.saveData(data);
            const loaded = await adapter.getData();
            expect(loaded?.settings.taxonomy).toEqual(settings.taxonomy);
            const backup = validateBackupJson(JSON.stringify(loaded));
            expect(backup.valid).toBe(true);
            expect(backup.data?.settings.taxonomy).toEqual(settings.taxonomy);
            const remote = sanitizeAppDataForRemote(data);
            expect(remote.settings.taxonomy).toEqual(settings.taxonomy);
            expect(mergeSettingsForSync({}, remote.settings).taxonomy).toEqual(settings.taxonomy);
        } finally { db.close(); }
    });
});
