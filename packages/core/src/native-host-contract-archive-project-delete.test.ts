import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { revisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { AppData, Project, Section, Task } from './types';
import * as logger from './logger';

const AT = '2026-09-30T12:00:00.000Z';
const NOW = '2026-10-02T13:00:00.000Z';
const PROJECT_ID = 'archive-project';
const DELETE_ID = '00000000-0000-4000-8000-000000000175';
const clone = <T,>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const project = (extra: Partial<Project> = {}): Project => ({
    id: PROJECT_ID, title: 'Archived parent', status: 'archived', color: '#123456', order: 4,
    tagIds: ['#kept'], supportNotes: 'Keep full Project notes',
    attachments: [{ id: 'project-file', kind: 'file', title: 'plan.pdf', uri: 'file:///owned/plan.pdf',
        createdAt: AT, updatedAt: AT }],
    createdAt: AT, updatedAt: AT, archivedAt: AT, rev: 7, revBy: 'device-a', ...extra,
});
const section = (id: string, extra: Partial<Section> = {}): Section => ({
    id, projectId: PROJECT_ID, title: id, order: 0, createdAt: AT, updatedAt: AT,
    rev: 2, revBy: 'device-a', ...extra,
});
const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: id, status: 'archived', projectId: PROJECT_ID, sectionId: 'section-live',
    description: 'Keep Task notes', contexts: ['@home'], tags: ['#kept'],
    attachments: [{ id: `${id}-link`, kind: 'link', title: 'Source', uri: 'https://example.test/source',
        createdAt: AT, updatedAt: AT }],
    createdAt: AT, updatedAt: AT, rev: 3, revBy: 'device-a', ...extra,
});
const seed = (parent: Project = project()): Partial<AppData> => ({
    projects: [parent],
    sections: [section('section-live'), section('section-prior', { deletedAt: AT })],
    tasks: [task('task-active', { status: 'next' }), task('task-done', { status: 'done', completedAt: AT }),
        task('task-archived'), task('task-prior', { deletedAt: AT }),
        task('task-section-only', { projectId: undefined }),
        task('task-unrelated', { projectId: undefined, sectionId: undefined })],
    settings: { deviceId: 'device-a', analyticsProfileId: '00000000-0000-4000-8000-000000000177' },
});
const rows = () => {
    const state = useTaskStore.getState();
    return clone({ tasks: state._allTasks, projects: state._allProjects, sections: state._allSections,
        areas: state._allAreas, people: state._allPeople, settings: state.settings });
};
const request = () => ({ requestId: DELETE_ID, projectId: PROJECT_ID,
    projectRevision: revisionOf(useTaskStore.getState()._projectsById.get(PROJECT_ID)!), source: 'archive' as const });
const insertLegacySectionOnly = () => {
    const state = useTaskStore.getState();
    const row = task('legacy-section-only', { projectId: undefined, sectionId: 'section-live' });
    useTaskStore.setState({ _allTasks: [...state._allTasks, row],
        _tasksById: new Map([...state._tasksById, [row.id, row]]) } as never);
};

afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });

describe('Archive Project Delete through the prepared Project Delete writer', () => {
    it.each([
        ['completed archived', project()],
        ['cancelled archived', project({ cancelledAt: AT })],
    ])('matches the RN deleteProject whole-data effect for %s', async (_name, parent) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const rn = await openSqliteHost(seed(parent));
        let expectedBefore: ReturnType<typeof rows>;
        let expectedSettingsBefore: unknown;
        let expected: ReturnType<typeof rows>;
        let expectedCold: ReturnType<typeof rows>;
        try {
            expectedBefore = rows();
            expectedSettingsBefore = await rn.sql('SELECT rowid, * FROM settings');
            expect((await useTaskStore.getState().deleteProject(PROJECT_ID)).success).toBe(true);
            await flushPendingSave();
            expected = rows();
            await rn.restart();
            expectedCold = rows();
        } finally { await rn.close(); }
        const native = await openSqliteHost(seed(parent));
        try {
            const before = rows();
            expect(before).toEqual(expectedBefore);
            expect(await native.sql('SELECT rowid, * FROM settings')).toEqual(expectedSettingsBefore);
            const proposed = request();
            const prepared = value(native.host.prepareProjectDelete(proposed)).prepared;
            expect(prepared.scope.project.status).toBe('archived');
            expect(value(await native.host.commitPreparedProjectDelete({ request: proposed, prepared })))
                .toEqual(prepared.result);
            expect(rows()).toEqual(expected);
            expect(rows().projects[0]).toMatchObject({ status: 'archived', supportNotes: 'Keep full Project notes',
                attachments: before.projects[0].attachments });
            expect(rows().tasks.find((row) => row.id === 'task-prior')).toEqual(before.tasks.find((row) => row.id === 'task-prior'));
            expect(rows().sections.find((row) => row.id === 'section-prior'))
                .toEqual(before.sections.find((row) => row.id === 'section-prior'));
            expect(rows().tasks.find((row) => row.id === 'task-active')).toMatchObject({
                description: 'Keep Task notes', attachments: before.tasks.find((row) => row.id === 'task-active')?.attachments });
            expect(rows().tasks.find((row) => row.id === 'task-active')?.deletedAt).toBeUndefined();
            await native.restart();
            expect(rows()).toEqual(expectedCold);
        } finally { await native.close(); }
    });

    it('matches RN detachment of a legacy Section-only child while retaining independent tombstones', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const rn = await openSqliteHost(seed());
        let expected: ReturnType<typeof rows>;
        let expectedBefore: ReturnType<typeof rows>;
        let expectedSettingsBefore: unknown;
        try {
            insertLegacySectionOnly();
            expectedBefore = rows();
            expectedSettingsBefore = await rn.sql('SELECT rowid, * FROM settings');
            expect((await useTaskStore.getState().deleteProject(PROJECT_ID)).success).toBe(true);
            await flushPendingSave();
            expected = rows();
        } finally { await rn.close(); }
        const native = await openSqliteHost(seed());
        try {
            insertLegacySectionOnly();
            expect(rows()).toEqual(expectedBefore);
            expect(await native.sql('SELECT rowid, * FROM settings')).toEqual(expectedSettingsBefore);
            const original = request();
            const prepared = value(native.host.prepareProjectDelete(original)).prepared;
            expect(prepared.scope.tasks.map((row) => row.id)).toContain('legacy-section-only');
            expect(prepared.effect.tasks.map((pair) => pair.before.id)).toContain('legacy-section-only');
            expect(value(await native.host.commitPreparedProjectDelete({ request: original, prepared })))
                .toEqual(prepared.result);
            expect(rows()).toEqual(expected);
            expect(useTaskStore.getState()._tasksById.get('legacy-section-only'))
                .toMatchObject({ title: 'legacy-section-only', status: 'archived' });
            expect(useTaskStore.getState()._tasksById.get('legacy-section-only')?.projectId).toBeUndefined();
            expect(useTaskStore.getState()._tasksById.get('legacy-section-only')?.sectionId).toBeUndefined();
        } finally { await native.close(); }
    });

    it('rejects malformed source, non-archived and tombstoned Projects, and forged effects', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const original = request();
            expect(sqlite.host.prepareProjectDelete({ ...original, source: 'other' as never }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(sqlite.host.prepareProjectDelete({ ...original, source: undefined }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const prepared = value(sqlite.host.prepareProjectDelete(original)).prepared;
            const envelope = { request: original, prepared };
            const forged = clone(envelope);
            forged.prepared.effect.project.after.title = 'Forged title';
            expect(sqlite.host.validatePreparedProjectDelete(forged))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const fakeSource = clone(envelope);
            fakeSource.prepared.scope.project.status = 'active';
            fakeSource.prepared.effect.project.before.status = 'active';
            fakeSource.prepared.effect.project.after.status = 'active';
            expect(sqlite.host.validatePreparedProjectDelete(fakeSource))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const before = rows();
            expect(await sqlite.host.commitPreparedProjectDelete(forged))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(rows()).toEqual(before);
        } finally { await sqlite.close(); }
        for (const bad of [project({ status: 'active', archivedAt: undefined }),
            project({ deletedAt: AT }), project({ purgedAt: AT })]) {
            const next = await openSqliteHost(seed(bad));
            try {
                expect(next.host.prepareProjectDelete(request()))
                    .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            } finally { await next.close(); }
        }
    });

    it('refuses a changed Project or new owned child after preparation', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const original = request();
            const prepared = value(sqlite.host.prepareProjectDelete(original)).prepared;
            await sqlite.client().run('UPDATE projects SET title = ?, rev = rev + 1, updatedAt = ? WHERE id = ?',
                ['Changed after confirmation', '2026-10-02T13:00:01.000Z', PROJECT_ID]);
            await sqlite.restart();
            const changed = rows();
            expect(await sqlite.host.commitPreparedProjectDelete({ request: original, prepared }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(rows()).toEqual(changed);
        } finally { await sqlite.close(); }

        const withChild = await openSqliteHost(seed());
        try {
            const original = request();
            const prepared = value(withChild.host.prepareProjectDelete(original)).prepared;
            const state = useTaskStore.getState();
            const added = task('later-owned-task');
            useTaskStore.setState({ _allTasks: [...state._allTasks, added],
                _tasksById: new Map([...state._tasksById, [added.id, added]]) } as never);
            const changed = rows();
            expect(await withChild.host.commitPreparedProjectDelete({ request: original, prepared }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(rows()).toEqual(changed);
        } finally { await withChild.close(); }
    });

    it('requires an exact saved UUID receipt, never an equal after-state, across later edits and cold boot', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const original = request();
            const prepared = value(sqlite.host.prepareProjectDelete(original)).prepared;
            const envelope = { request: original, prepared };
            expect(value(sqlite.host.projectDeleteOutcome(envelope))).toBeNull();
            const alternate = clone(envelope);
            alternate.request.requestId = '00000000-0000-4000-8000-000000000176';
            alternate.prepared.request.requestId = alternate.request.requestId;
            expect(value(sqlite.host.validatePreparedProjectDelete(alternate))).toEqual(prepared.result);
            expect(value(await sqlite.host.commitPreparedProjectDelete(envelope))).toEqual(prepared.result);
            expect(value(sqlite.host.projectDeleteOutcome(envelope))).toEqual(prepared.result);
            expect(value(sqlite.host.projectDeleteOutcome(alternate))).toBeNull();
            const after = rows();
            expect(await sqlite.host.commitPreparedProjectDelete(alternate))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(rows()).toEqual(after);
            await sqlite.client().run('UPDATE projects SET supportNotes = ?, rev = rev + 1, updatedAt = ? WHERE id = ?',
                ['Later Trash notes', '2026-10-02T13:00:01.000Z', PROJECT_ID]);
            await sqlite.restart();
            const beforeReplay = rows();
            const receipts = await sqlite.receiptIds();
            expect(value(sqlite.host.projectDeleteOutcome(envelope))).toEqual(prepared.result);
            expect(value(await sqlite.host.commitPreparedProjectDelete(envelope))).toEqual(prepared.result);
            expect(rows()).toEqual(beforeReplay);
            expect(await sqlite.receiptIds()).toEqual(receipts);
            expect(useTaskStore.getState()._projectsById.get(PROJECT_ID)?.supportNotes).toBe('Later Trash notes');
            const forged = clone(envelope);
            forged.prepared.result.deletion.message = 'Another notice';
            expect(sqlite.host.projectDeleteOutcome(forged))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        } finally { await sqlite.close(); }
    });

    it('cold-retries failed SQLite COMMIT without partial Project, children or receipt', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const fault = { commits: 0 };
        const writes: string[] = [];
        const diagnostic = vi.spyOn(logger, 'logInfo');
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            writes.push(sql);
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected commit failure'); }
            return client.run(sql, params);
        } }));
        try {
            const original = request();
            const prepared = value(sqlite.host.prepareProjectDelete(original)).prepared;
            const tables = async () => ({ projects: await sqlite.sql('SELECT * FROM projects ORDER BY id'),
                tasks: await sqlite.sql('SELECT * FROM tasks ORDER BY id'),
                sections: await sqlite.sql('SELECT * FROM sections ORDER BY id'),
                settings: await sqlite.sql('SELECT * FROM settings') });
            const before = await tables();
            const receiptIds = await sqlite.receiptIds();
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedProjectDelete({ request: original, prepared }))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await tables()).toEqual(before);
            expect(await sqlite.receiptIds()).toEqual(receiptIds);
            expect(diagnostic.mock.calls.filter(([message]) => message === 'Native Project delete taxonomy retained')).toEqual([]);
            fault.commits = 0;
            resetForTests();
            await sqlite.client().run("UPDATE settings SET data=json_set(data, '$.theme', 'dark') WHERE id=1");
            await sqlite.restart();
            expect(value(sqlite.host.projectDeleteOutcome({ request: original, prepared }))).toBeNull();
            expect(value(await sqlite.host.commitPreparedProjectDelete({ request: original, prepared })))
                .toEqual(prepared.result);
            expect(useTaskStore.getState()._projectsById.get(PROJECT_ID)?.deletedAt).toBe(NOW);
            // Delete detaches the tasks, so only the deleted Project's own tag can become unused.
            expect(useTaskStore.getState().settings).toMatchObject({ theme: 'dark', taxonomy: {
                tags: [{ token: '#kept', rev: 1, revBy: 'device-a', updatedAt: NOW }],
            } });
            expect(useTaskStore.getState().settings.taxonomy?.contexts).toBeUndefined();
            expect(diagnostic).toHaveBeenCalledWith('Native Project delete taxonomy retained', {
                scope: 'native-host', category: 'storage', context: {
                    releaseCheck: 'v1.3.7/native-project-delete-taxonomy', operation: 'delete', outcome: 'confirmed',
                },
            });
            const durable = await tables();
            await sqlite.restart();
            expect(await tables()).toEqual(durable);
            writes.length = 0;
            expect(value(sqlite.host.projectDeleteOutcome({ request: original, prepared }))).toEqual(prepared.result);
            expect(value(await sqlite.host.commitPreparedProjectDelete({ request: original, prepared }))).toEqual(prepared.result);
            expect(writes).toEqual([]);
            expect(diagnostic.mock.calls.filter(([message]) => message === 'Native Project delete taxonomy retained')).toHaveLength(1);
        } finally { await sqlite.close(); diagnostic.mockRestore(); }
    });
});
