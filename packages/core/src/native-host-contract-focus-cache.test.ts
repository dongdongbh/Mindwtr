import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FOCUS_CONTROL_STATE } from './focus-controls';
import { createNativeHostContract } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Task } from './types';

// The contract's kept Focus model (focusSections): a host that keeps it answers every Focus read exactly as one that builds it
// fresh each time, across a timed start, a midnight, a write, a settings change and a clock that went back.

const AT = '2026-01-01T00:00:00.000Z';
const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', tags: [], contexts: [], createdAt: AT, updatedAt: AT, ...extra,
});

describe('native host contract: the kept Focus model', () => {
    const originalTz = process.env.TZ;
    beforeAll(() => { process.env.TZ = 'America/New_York'; });
    afterAll(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });
    afterEach(async () => {
        vi.useRealTimers();
        await flushPendingSave();
        resetForTests();
    });

    const seed = async (tasks: Task[] = [
        task('later', { startTime: '2026-03-07T21:30:00' }),
        task('tomorrow', { startTime: '2026-03-08' }),
        task('due-soon', { dueDate: '2026-04-06T21:45:00' }),
        task('review', { reviewAt: '2026-03-07T22:15:00' }),
        task('focused', { isFocusedToday: true }),
        ...Array.from({ length: 300 }, (_, index) => task(`n${index}`, index % 3 === 0 ? { dueDate: '2026-03-08' } : {})),
    ]) => {
        let data: AppData = { tasks, projects: [], sections: [], areas: [], people: [], settings: {} } as AppData;
        setStorageAdapter({ getData: async () => data, saveData: async (next) => { data = JSON.parse(JSON.stringify(next)); } });
        useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
            error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
        await useTaskStore.getState().fetchData({ throwOnError: true });
        await flushPendingSave();
        const open = async (focusModelCache: boolean) => {
            const host = createNativeHostContract({ focusModelCache });
            expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
            expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
            return host;
        };
        return open;
    };

    it('answers each read as a fresh build would', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 2, 7, 21, 0));
        const open = await seed();
        // The model is kept per control state, so each pair of hosts reads one: the screen's controls, and a flat read.
        const controls = { ...DEFAULT_FOCUS_CONTROL_STATE, sortBy: 'due' as const };
        const pairs = [
            { kept: await open(true), fresh: await open(false), input: { limit: 100, controls } },
            { kept: await open(true), fresh: await open(false), input: { limit: 100 } },
        ];
        // Each host's revision names its own process; everything else must match.
        const read = (host: ReturnType<typeof createNativeHostContract>, input: Parameters<typeof host.getFocus>[0]) => (
            JSON.stringify(host.getFocus(input), (key, value) => (key === 'revision' ? undefined : value))
        );
        const same = () => { for (const { kept, fresh, input } of pairs) expect(read(kept, input)).toBe(read(fresh, input)); };
        same();
        // Minutes inside one window, then the timed start, the review instant, midnight and the next day.
        for (const [hour, minute] of [[21, 10], [21, 29], [21, 30], [21, 31], [22, 15], [23, 59], [24, 0], [24, 1], [25, 0]]) {
            vi.setSystemTime(new Date(2026, 2, 7, hour, minute));
            same();
        }
        // A write and a settings change rebuild in the same minute.
        await useTaskStore.getState().updateTask('n1', { dueDate: '2026-03-08T01:30:00' });
        same();
        await useTaskStore.getState().updateSettings({ gtd: { focusIncludeStartDates: false } });
        same();
        // The clock went back: rebuild.
        vi.setSystemTime(new Date(2026, 2, 7, 20, 0));
        same();
    });

    // A time zone change while the app runs moves the local day: Today must follow at once, not at the old zone's midnight.
    it('follows a time zone change at the next read', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-03-07T15:00:00Z'));
        try {
            const open = await seed([
                task('due-tokyo-day', { dueDate: '2026-03-08' }),
                task('starts-tokyo-day', { startTime: '2026-03-08' }),
                ...Array.from({ length: 20 }, (_, index) => task(`n${index}`)),
            ]);
            const kept = await open(true);
            const fresh = await open(false);
            const read = (host: ReturnType<typeof createNativeHostContract>) => (
                JSON.stringify(host.getFocus({ limit: 100 }), (key, value) => (key === 'revision' ? undefined : value)));
            expect(read(kept)).toBe(read(fresh));
            // 10:00 in New York is 00:00 on 03-08 in Tokyo.
            process.env.TZ = 'Asia/Tokyo';
            vi.setSystemTime(new Date('2026-03-07T15:30:00Z'));
            expect(read(kept)).toBe(read(fresh));
            expect(read(kept)).toContain('due-tokyo-day');
        } finally {
            process.env.TZ = 'America/New_York';
        }
    });

    // The kept model rebuilds at an instant with seconds (a start at 21:30:30): paging opened before it must be refused.
    it('refuses paging opened before a rebuild inside the same minute', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 2, 7, 21, 30, 10));
        const open = await seed([
            ...Array.from({ length: 10 }, (_, index) => task(`late${index}`, { startTime: '2026-03-07T21:30:30' })),
            ...Array.from({ length: 30 }, (_, index) => task(`today${index}`, { startTime: '2026-03-07' })),
        ]);
        const host = await open(true);
        const first = host.getFocus({ limit: 20 });
        if (!first.ok) throw new Error(first.error.message);
        const schedule = first.value.sections.find((section) => section.key === 'schedule')!;
        expect(schedule.total).toBe(40);
        vi.setSystemTime(new Date(2026, 2, 7, 21, 30, 40));
        const page = host.getFocusSectionWindow({ key: 'schedule', offset: 20, limit: 20, revision: first.value.revision });
        expect(page).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });
});

