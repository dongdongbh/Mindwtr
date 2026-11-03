import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectBulkTaskTokens } from './bulk-task-tokens';
import type { NativeBulkActionsView } from './native-host-contract-bulk-actions';
import { openSqliteHost } from './screen-parity.replay';
import { buildSaveSnapshot } from './store-helpers';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { AppData, Task } from './types';

const NOW = '2026-10-03T13:00:15.000Z';
const BEFORE = '2026-10-02T12:34:56.789Z';
const SELECTED = ['selected-a', 'selected-b'];
const params = (list: List) => ({ groupBy: 'none', ...(list === 'reference' ? { includeArchivedProjects: true } : {}) });
const TAGS = Array.from({ length: 210 }, (_, index) => `tag ${String(index).padStart(3, '0')}`);
const ORIGINAL_TZ = process.env.TZ;
type List = 'reference' | 'done';
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
type Host = Sqlite['host'];
type Input = Parameters<Host['getBulkActions']>[0];

const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const copy = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
const seed = (list: List): Partial<AppData> => {
    const task = (id: string, fields: Partial<Task>): Task => ({
        id, title: `Picker ${id}`, status: list, createdAt: BEFORE, updatedAt: BEFORE,
        rev: 1, revBy: 'picker-device', tags: [], contexts: [],
        ...(list === 'done' ? { completedAt: BEFORE } : {}), ...fields,
    });
    return {
        tasks: [task(SELECTED[0], { projectId: 'parent', tags: TAGS }),
            task(SELECTED[1], { projectId: 'parent', tags: [TAGS[0]] }), task('unselected', {})],
        projects: [{ id: 'parent', title: 'Parent', status: 'active', color: '#94a3b8', order: 0,
            createdAt: BEFORE, updatedAt: BEFORE, rev: 1, revBy: 'picker-device', tagIds: [] }],
        settings: { deviceId: 'picker-device', gtd: { autoArchiveDays: 0 } },
    };
};
const open = (list: List) => openSqliteHost(seed(list), undefined, undefined, { rejectConcurrentWrites: true });
const pickerInput = (list: List, fields: Partial<Input> = {}): Input => ({
    list, params: params(list), taskIds: SELECTED, picker: { kind: 'removeTag', offset: 0, limit: 100 }, ...fields,
});
const first = (host: Host, list: List): NativeBulkActionsView => value(host.getBulkActions(pickerInput(list)));
const more = (host: Host, list: List, revision: string, fields: Partial<Input> = {}) => host.getBulkActions({
    ...pickerInput(list), ...fields,
    picker: { kind: 'removeTag', offset: 100, limit: 100, revision, ...fields.picker },
});
const rawDomain = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all([
    'tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync',
    'native_request_receipts',
].map(async (table) => [table, await sqlite.sql(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`)])));

afterEach(async () => {
    await flushPendingSave();
    resetForTests();
    vi.useRealTimers();
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
});
const clock = () => {
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
};

describe('Remove tag picker paging keeps data authority across a display minute', () => {
    it.each(['reference', 'done'] as const)('%s: pages 100 and 200 survive elapsed minutes without restarting page zero', async (list) => {
        clock();

        const sqlite = await open(list);
        try {
            const host = sqlite.host;
            const expected = collectBulkTaskTokens(SELECTED, useTaskStore.getState()._tasksById, 'tags');
            const displayBefore = value(host.getBulkActions({ list, params: params(list), taskIds: SELECTED })).revision;
            const page0 = first(host, list);
            expect(page0.selectedIds).toEqual(SELECTED);
            expect(page0.picker).toMatchObject({ kind: 'removeTag', total: 210 });
            expect(page0.picker!.items.map((item) => item.value)).toEqual(expected.slice(0, 100));
            const memoryBefore = copy(buildSaveSnapshot(useTaskStore.getState()));
            const rawBefore = await rawDomain(sqlite);

            vi.setSystemTime(new Date(Date.parse(NOW) + 120_000));
            const reply100 = more(host, list, page0.revision);
            expect(reply100).toMatchObject({ ok: true });
            const page100 = value(reply100);
            expect(page100.revision).toBe(page0.revision);
            expect(page100.picker!.items.map((item) => item.value)).toEqual(expected.slice(100, 200));
            vi.setSystemTime(new Date(Date.parse(NOW) + 240_000));
            const page200 = value(more(host, list, page100.revision, { picker: { kind: 'removeTag', offset: 200 } }));
            expect(page200.revision).toBe(page0.revision);
            expect(page200.picker!.items.map((item) => item.value)).toEqual(expected.slice(200));
            expect([...page0.picker!.items, ...page100.picker!.items, ...page200.picker!.items].map((item) => item.value)).toEqual(expected);
            expect(page200.selectedIds).toEqual(SELECTED);
            expect(page200.taskRevisions).toEqual(page0.taskRevisions);

            expect(value(host.getBulkActions({ list, params: params(list), taskIds: SELECTED })).revision).not.toBe(displayBefore);
            expect(buildSaveSnapshot(useTaskStore.getState())).toEqual(memoryBefore);
            expect(await rawDomain(sqlite)).toEqual(rawBefore);
        } finally { await sqlite.close(); }
    });
});

describe.each(['reference', 'done'] as const)('%s Remove tag picker refuses real authority changes', (list) => {
    it.each(['tag', 'selected-row', 'parent', 'editability'] as const)('%s edit invalidates the old page even when the minute stays fixed', async (change) => {
        clock();
        const sqlite = await open(list);
        try {
            const page0 = first(sqlite.host, list);
            if (change === 'tag') expect((await useTaskStore.getState().updateTask(SELECTED[0], { tags: [...TAGS, 'new tag'] })).success).toBe(true);
            if (change === 'selected-row') expect((await useTaskStore.getState().updateTask(SELECTED[0], { description: 'Actual changed row' })).success).toBe(true);
            if (change === 'parent') expect((await useTaskStore.getState().updateProject('parent', { title: 'Actual changed parent' })).success).toBe(true);
            if (change === 'editability') expect((await useTaskStore.getState().updateProject('parent', { status: 'archived' })).success).toBe(true);
            await flushPendingSave();
            const beforeRead = await rawDomain(sqlite);
            expect(more(sqlite.host, list, page0.revision)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await rawDomain(sqlite)).toEqual(beforeRead);
        } finally { await sqlite.close(); }
    });

    it('a changed list scope invalidates the old page', async () => {
        clock(); const sqlite = await open(list);
        try {
            const page0 = first(sqlite.host, list);
            expect(more(sqlite.host, list, page0.revision, { params: { ...params(list), filters: { searchQuery: 'selected-a' } } }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        } finally { await sqlite.close(); }
    });

    it('a changed eligible selected set invalidates the old page, even when its tag union happens to match', async () => {
        clock(); const sqlite = await open(list);
        try {
            const page0 = first(sqlite.host, list);
            expect(more(sqlite.host, list, page0.revision, { taskIds: [SELECTED[0]] }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        } finally { await sqlite.close(); }
    });

    it('a changed picker query invalidates the old page before mixing filtered and unfiltered pages', async () => {
        clock(); const sqlite = await open(list);
        try {
            const page0 = first(sqlite.host, list);
            expect(more(sqlite.host, list, page0.revision, { picker: { kind: 'removeTag', query: 'tag 1' } }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        } finally { await sqlite.close(); }
    });
});
