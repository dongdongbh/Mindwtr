import { afterEach, describe, expect, it, vi } from 'vitest';
import { drainPendingCaptureQueue, type PendingCaptureQueuePort } from './pending-captures';
import { parseQuickAdd } from './quick-add';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData } from './types';

// The Android Tasks widget pre-fills `@context ` / `#tag ` for a single-token list
// (WidgetListStore.captureText, #1418). It emits a simple token (`@Todd`), a hierarchical
// one as typed (`@person/todd`), or anything else in quoted form (`@"Two words"`), and
// skips names containing a quote or backslash, or whitespace before a marker or slash.
// These pin that each emitted form round-trips through quick-add with no known-token list.

const ID = '33333333-3333-4abc-8def-333333333333';

afterEach(async () => {
    await flushPendingSave();
    resetForTests();
});

describe('Android widget capture token pre-fill', () => {
    it.each(['@Todd', '#errand-1', '@Büro', '#2026_q4'])('parses the pre-filled %s unaided', (token) => {
        const parsed = parseQuickAdd(`${token} Call back`, [], new Date('2026-10-21T12:00:00Z'));
        expect([...(parsed.props.contexts ?? []), ...(parsed.props.tags ?? [])]).toEqual([token]);
    });

    it.each(['@person/todd', '#area/sub-1', '@Büro/Raum_2'])('parses the hierarchical pre-fill %s unaided (#1428)', (token) => {
        const parsed = parseQuickAdd(`${token} Call back`, [], new Date('2026-10-21T12:00:00Z'));
        expect([...(parsed.props.contexts ?? []), ...(parsed.props.tags ?? [])]).toEqual([token]);
        expect(parsed.title).toBe('Call back');
    });

    it.each([
        ['@"Two words"', '@Two words'],
        ['#"a.b"', '#a.b'],
        ['@"person/Todd Smith"', '@person/Todd Smith'],
        ['#"Tom\'s & co."', "#Tom's & co."],
        ['@"a/"', '@a/'],
    ])('parses the quoted pre-fill %s unaided', (prefill, token) => {
        const parsed = parseQuickAdd(`${prefill} Call back`, [], new Date('2026-10-21T12:00:00Z'));
        expect([...(parsed.props.contexts ?? []), ...(parsed.props.tags ?? [])]).toEqual([token]);
        expect(parsed.title).toBe('Call back');
    });

    // The dialog's Contexts button (QuickCaptureActivity.insertToken) drops the same forms mid-text, spaced on both sides.
    it.each([
        ['Call @person/gary back', '@person/gary'],
        ['Call @"Two words" back', '@Two words'],
        ['Call back @garage ', '@garage'],
    ])('parses the Contexts-button insertion in %s unaided', (text, token) => {
        const parsed = parseQuickAdd(text, [], new Date('2026-10-21T12:00:00Z'));
        expect(parsed.props.contexts).toEqual([token]);
        expect(parsed.title).toBe('Call back');
    });

    it.each([['#"x @y"', '#x @y'], ['@"x /link:https://a.b"', '@x /link:https://a.b']])('does not round-trip %s, so the widget skips a space before a marker or slash', (prefill, token) => {
        const parsed = parseQuickAdd(`${prefill} Call back`, [], new Date('2026-10-21T12:00:00Z'));
        expect([...(parsed.props.contexts ?? []), ...(parsed.props.tags ?? [])]).not.toEqual([token]);
    });

    it.each([['@Todd', 'contexts'], ['#errand', 'tags']] as const)('drains widget text %s into an Inbox task carrying it', async (token, field) => {
        await flushPendingSave();
        resetForTests();
        let persisted: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'widget-token' } };
        setStorageAdapter({
            getData: async () => structuredClone(persisted),
            saveData: async (data) => { persisted = structuredClone(data); },
        });
        useTaskStore.setState({
            _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
        } as never);
        await useTaskStore.getState().fetchData({ silent: true });
        // Exactly what QuickCaptureActivity queues after the user types behind the token.
        const files = new Map([[`${ID}.json`, JSON.stringify({
            kind: 'text', id: ID, title: `${token} Call back`, createdAt: '2026-10-21T12:00:00.000Z',
            source: 'android-quick-capture', defaultStatus: 'inbox',
        })]]);
        const queue: PendingCaptureQueuePort = {
            list: async () => [...files.keys()],
            read: async (name) => files.get(name) ?? '',
            delete: async (name) => { files.delete(name); },
        };
        let record: string | null = null;
        const { addTask, updateTask, addProject, projects, areas, tasks, people, settings } = useTaskStore.getState();
        expect(await drainPendingCaptureQueue({
            addTask, updateTask, addProject, projects, areas, tasks, people, settings,
            getTasks: () => useTaskStore.getState()._allTasks, flushPendingSave, queue,
            lastApplied: { read: async () => record, write: async (value) => { record = value; } },
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        })).toBe(1);
        await flushPendingSave();
        expect(persisted.tasks).toHaveLength(1);
        expect(persisted.tasks[0]).toMatchObject({ status: 'inbox', [field]: [token] });
        expect(persisted.tasks[0].title).toContain('Call back');
    });
});
