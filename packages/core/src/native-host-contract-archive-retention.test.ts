import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTranslator } from './i18n';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { markArchiveRetentionSyncCompleted } from './store-archive-retention';
import type { AppData, AppSettings, Project, Task } from './types';
import { generateUUID } from './uuid';

const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const archived = (id: string, days: number): Task => ({
    id, title: `Title ${id}`, status: 'archived', tags: [], contexts: [], createdAt: ago(days),
    updatedAt: ago(days), archivedAt: ago(days), rev: 1, revBy: 'device-a',
});

async function openHost(settings: AppSettings = {}, initial: Partial<AppData> = {}, fail = () => false) {
    await flushPendingSave();
    resetForTests();
    let data: AppData = { tasks: [archived('old', 100), archived('recent', 5)], projects: [], sections: [],
        areas: [], people: [], ...initial, settings: { deviceId: 'device-a', ...settings } };
    let saves = 0;
    setStorageAdapter({
        getData: async () => structuredClone(data),
        saveData: async (next) => {
            if (fail()) throw new Error('retention disk failure');
            data = structuredClone(next);
            saves++;
        },
    });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0 });
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' }));
    value(await host.activate({ writeSafetyReady: true }));
    return { host, data: () => structuredClone(data), saves: () => saves };
}

const purgedIds = () => useTaskStore.getState()._allTasks.filter((task) => task.purgedAt).map((task) => task.id);
const none = { tasks: 0, projects: 0, sections: 0 };
const lines: LogPayload[] = [];
const runLines = () => lines.filter((line) => line.context?.releaseCheck === 'v1.3.8/native-archive-retention');

afterEach(async () => {
    setLogger(consoleLogger);
    lines.length = 0;
    vi.useRealTimers();
    await flushPendingSave();
    resetForTests();
});

describe('native host contract: Archive retention runner', () => {
    it('waits for the actual session sync while a backend is selected, then durably purges only old items', async () => {
        const { host, data, saves } = await openHost({ gtd: { archiveRetentionDays: 30 } });
        const count = saves();
        expect(value(await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'webdav' })))
            .toEqual({ outcome: 'skipped', purged: none, skipped: 'waiting-for-sync' });
        expect(purgedIds()).toEqual([]);
        expect(saves()).toBe(count);
        markArchiveRetentionSyncCompleted();
        expect(value(await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'webdav' })))
            .toEqual({ outcome: 'purged', purged: { tasks: 1, projects: 0, sections: 0 }, skipped: null });
        expect(data().tasks.find((task) => task.id === 'old')).toMatchObject({ purgedAt: expect.any(String), rev: 2 });
        expect(data().tasks.find((task) => task.id === 'recent')?.purgedAt).toBeUndefined();
        const reopened = await openHost(data().settings, data());
        expect(value(await reopened.host.runArchiveRetention({ editorOpen: false, selectedBackend: 'webdav' })).skipped)
            .toBe('waiting-for-sync');
        expect(purgedIds()).toEqual(['old']);
    });

    it('treats disconnected, unknown, empty and unreadable selections as configured', async () => {
        const { host, saves } = await openHost({ gtd: { archiveRetentionDays: 30 } });
        const count = saves();
        for (const selectedBackend of ['cloudkit', 'cloud', 'unknown', '', null]) {
            expect(value(await host.runArchiveRetention({ editorOpen: false, selectedBackend })).skipped).toBe('waiting-for-sync');
        }
        expect(purgedIds()).toEqual([]);
        expect(saves()).toBe(count);
    });

    it('skips an open editor and the store editing lock; only explicit off permits an unsynced purge', async () => {
        const { host } = await openHost({ gtd: { archiveRetentionDays: 30 } });
        expect(value(await host.runArchiveRetention({ editorOpen: true, selectedBackend: 'off' })))
            .toEqual({ outcome: 'skipped', purged: none, skipped: 'editor-open' });
        useTaskStore.setState({ editLockCount: 1 });
        expect(value(await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'off' })).skipped).toBe('not-ready');
        expect(purgedIds()).toEqual([]);
        useTaskStore.setState({ editLockCount: 0 });
        expect(value(await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'off' })).outcome).toBe('purged');
        expect(purgedIds()).toEqual(['old']);
    });

    it('does no work for Never or an inactive host and strictly validates both input keys', async () => {
        const inactive = createNativeHostContract();
        expect(value(await inactive.runArchiveRetention({ editorOpen: false, selectedBackend: 'off' })).skipped).toBe('not-ready');
        const { host } = await openHost();
        expect(value(await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'off' })).skipped).toBe('off');
        for (const input of [{}, { editorOpen: false }, { editorOpen: 'no', selectedBackend: 'off' },
            { editorOpen: false, selectedBackend: 0 }, { editorOpen: false, selectedBackend: 'off', extra: true }]) {
            expect(await host.runArchiveRetention(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(purgedIds()).toEqual([]);
    });

    it('preserves tombstones and counts an eligible archived project, its section and children', async () => {
        const at = ago(100);
        const project: Project = { id: 'archived-project', title: 'Private project title', status: 'archived', color: '#123456',
            order: 0, tagIds: [], createdAt: at, updatedAt: at, archivedAt: at, rev: 3, revBy: 'device-a' };
        const child = { ...archived('child', 100), projectId: project.id, sectionId: 'archived-section' };
        const tombstone = { ...archived('prior-purge', 100), deletedAt: at, purgedAt: at, title: '', rev: 7 };
        const { host, data } = await openHost({ gtd: { archiveRetentionDays: 30 } }, {
            projects: [project], tasks: [archived('old', 100), archived('recent', 5), child, tombstone],
            sections: [{ id: 'archived-section', projectId: project.id, title: 'Private section title', order: 0,
                createdAt: at, updatedAt: at, deletedAt: at, projectArchivedAt: at, rev: 2, revBy: 'device-a' }],
        });
        const before = structuredClone(useTaskStore.getState()._allTasks.find((task) => task.id === 'prior-purge'));
        expect(value(await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'off' })))
            .toEqual({ outcome: 'purged', purged: { tasks: 2, projects: 1, sections: 1 }, skipped: null });
        expect(data().projects[0]).toMatchObject({ id: project.id, purgedAt: expect.any(String), rev: 4 });
        expect(data().sections?.[0]).toMatchObject({ id: 'archived-section', deletedAt: expect.any(String), rev: 3 });
        expect(data().tasks.find((task) => task.id === 'prior-purge')).toEqual(before);
        expect(value(await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'off' })))
            .toEqual({ outcome: 'unchanged', purged: none, skipped: null });
    });

    it('never reports a purge on failed persistence; retry saves the existing tombstone once', async () => {
        let failed = false;
        const { host, data } = await openHost({ gtd: { archiveRetentionDays: 30 } }, {}, () => failed);
        setLogger((payload) => lines.push(payload));
        failed = true;
        const result = value(await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'off' }));
        failed = false;
        expect(result).toEqual({ outcome: 'failed', purged: none, skipped: null });
        expect(data().tasks.find((task) => task.id === 'old')?.purgedAt).toBeUndefined();
        expect(runLines().some((line) => line.context?.outcome === 'purged')).toBe(false);
        expect(value(await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'off' })).skipped).toBe('not-ready');
        await useTaskStore.getState().retryPersistence();
        expect(data().tasks.find((task) => task.id === 'old')).toMatchObject({ purgedAt: expect.any(String), rev: 2 });
        expect(value(await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'off' })).outcome).toBe('unchanged');
        expect(data().tasks.find((task) => task.id === 'old')?.rev).toBe(2);
    });

    it('logs changed outcomes once and each durable purge, with counts and no titles', async () => {
        const { host } = await openHost({ gtd: { archiveRetentionDays: 30 } });
        setLogger((payload) => lines.push(payload));
        await host.runArchiveRetention({ editorOpen: true, selectedBackend: 'off' });
        await host.runArchiveRetention({ editorOpen: true, selectedBackend: 'off' });
        await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'off' });
        await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'off' });
        expect(runLines().map((line) => [line.context?.outcome, line.context?.skipped, line.context?.taskCount])).toEqual([
            ['skipped', 'editor-open', 0], ['purged', 'none', 1], ['unchanged', 'none', 0],
        ]);
        expect(JSON.stringify(runLines())).not.toContain('Title');
    });
});

describe('native host contract: separate Archive retention card', () => {
    const t = getTranslator('en');

    it('draws the RN card separately while keeping the exact legacy Data settings keys', async () => {
        const { host } = await openHost();
        const options = value(host.getArchiveRetentionOptions());
        expect(Object.keys(options).sort()).toEqual(['card', 'revision']);
        expect(options.card).toEqual({
            title: t('settings.archiveRetention'), description: t('settings.archiveRetentionDesc'), safety: t('settings.archiveRetentionSafety'),
            current: `${t('settings.archiveRetentionCurrent')}: ${t('settings.archiveRetentionNever')}`, days: 0,
            daysLabel: t('settings.archiveRetentionDaysLabel'), invalid: t('settings.archiveRetentionInvalid'), save: t('settings.archiveRetentionSave'),
            never: { label: t('settings.archiveRetentionNever'), edit: { type: 'archiveRetentionDays', value: 0 } },
            saveFailed: t('settings.archiveRetentionSaveFailed'),
        });
        expect(Object.keys(value(host.getDataSettings())).sort()).toEqual(['archiveRetention', 'backup', 'diagnostics', 'importData', 'revision', 'title', 'version']);
        const on = value((await openHost({ gtd: { archiveRetentionDays: 45 } })).host.getArchiveRetentionOptions()).card;
        expect([on.days, on.current]).toEqual([45, `${t('settings.archiveRetentionCurrent')}: 45 days`]);
    });

    it('keeps Data setting receipts and acknowledgments, no-ops, Never and integer boundaries', async () => {
        const { host, data, saves } = await openHost();
        const save = (days: unknown) => host.setDataSetting({ requestId: generateUUID(), edit: { type: 'archiveRetentionDays', value: days } as never });
        expect(value(await save(30))).toEqual({ changed: true, deviceWrites: [] });
        expect(data().settings.gtd?.archiveRetentionDays).toBe(30);
        expect(data().settings.syncPreferencesUpdatedAt?.gtd).toBeTruthy();
        const count = saves();
        expect(value(await save(30))).toEqual({ changed: false, deviceWrites: [] });
        expect(saves()).toBe(count);
        expect(value(await save(36500)).changed).toBe(true);
        expect(value(await save(0)).changed).toBe(true);
        expect(data().settings.gtd?.archiveRetentionDays).toBe(0);
        for (const bad of [36501, -1, 1.5, '30', false, null, NaN, Infinity]) {
            expect(await save(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(await host.setDataSetting({ requestId: generateUUID(), edit: { type: 'archiveRetentionDays', value: 30, extra: true } } as never))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('backfills legacy clocks through the real setting action and retries a failed save without restamping', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-29T12:00:00.000Z'));
        let failed = false;
        const legacy = { ...archived('legacy', 100), archivedAt: undefined };
        const { host, data } = await openHost({}, { tasks: [legacy] }, () => failed);
        const input = { requestId: generateUUID(), edit: { type: 'archiveRetentionDays', value: 30 } } as const;
        failed = true;
        const first = await host.setDataSetting(input);
        failed = false;
        expect(first).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(data().settings.gtd?.archiveRetentionDays).toBeUndefined();
        expect(data().tasks[0].archivedAt).toBeUndefined();
        const stamped = structuredClone(useTaskStore.getState()._allTasks[0]);
        expect(stamped).toMatchObject({ archivedAt: '2026-10-29T12:00:00.000Z', rev: 2 });
        vi.setSystemTime(new Date('2026-10-29T13:00:00.000Z'));
        expect(value(await host.setDataSetting(input))).toEqual({ changed: true, deviceWrites: [] });
        expect(data().tasks[0]).toEqual(stamped);
        expect(data().settings.gtd?.archiveRetentionDays).toBe(30);
        expect(value(await host.setDataSetting(input))).toEqual({ changed: true, deviceWrites: [] });
        expect(data().tasks[0]).toEqual(stamped);
    });

    it('reviews enabling or shortening retention with RN counts and titles, and saves longer/Never directly', async () => {
        const { host } = await openHost();
        expect(value(host.getArchiveRetentionReview({ days: 30 })).review).toEqual({
            days: 30, title: t('settings.archiveRetentionConfirmTitle'),
            description: t('settings.archiveRetentionConfirmDescription').replace('{days}', '30'),
            counts: 'Eligible now: 1 tasks, 0 projects, 0 sections.',
            legacy: t('settings.archiveRetentionLegacyCount').replace('{count}', '0'),
            heading: t('settings.archiveRetentionCandidates'), lines: [`${t('calendar.tasks')}: Title old`],
            cancel: t('common.cancel'), confirm: t('settings.archiveRetentionConfirmAction'),
            edit: { type: 'archiveRetentionDays', value: 30 },
        });
        expect(value(host.getArchiveRetentionReview({ days: 200 })).review?.heading).toBe(t('settings.archiveRetentionNoCandidates'));
        const { host: on } = await openHost({ gtd: { archiveRetentionDays: 30 } });
        expect(value(on.getArchiveRetentionReview({ days: 3 })).review?.lines).toHaveLength(2);
        expect(value(on.getArchiveRetentionReview({ days: 60 }))).toEqual({ review: null, edit: { type: 'archiveRetentionDays', value: 60 } });
        expect(value(on.getArchiveRetentionReview({ days: 30 })).review).toBeNull();
        expect(value(on.getArchiveRetentionReview({ days: 0 })).review).toBeNull();
        for (const input of [{ days: 1.5 }, { days: -1 }, { days: 36501 }, { days: 30, extra: true }, {}]) {
            expect(on.getArchiveRetentionReview(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });
});

describe('native host contract: the getDataSettings fields iOS reads', () => {
    it('keeps the version, revision, title, every backup label and the diagnostics card iOS checks', async () => {
        const view = value((await openHost({})).host.getDataSettings()) as unknown as Record<string, any>;
        expect(view.version).toEqual(expect.any(Number));
        for (const name of ['revision', 'title']) expect(view[name]).toMatch(/./);
        for (const name of ['title', 'exportLabel', 'description', 'failed', 'csvLabel', 'csvDescription', 'csvFailed', 'tasknotesLabel',
            'tasknotesDescription', 'tasknotesFailed', 'mergeLabel', 'mergeDescription', 'mergeFailed', 'restoreFileLabel', 'restoreFileDescription',
            'csvImportLabel', 'csvImportDescription', 'todoistImportLabel', 'todoistImportDescription', 'ticktickImportLabel', 'ticktickImportDescription',
            'dgtImportLabel', 'dgtImportDescription', 'omnifocusImportLabel', 'omnifocusImportDescription', 'snapshotsLabel', 'restoreLabel']) {
            expect([name, view.backup[name]]).toEqual([name, expect.stringMatching(/./)]);
        }
        const labels = view.diagnostics;
        expect(labels.title).toMatch(/./);
        expect(labels.debugLogging.value).toEqual(expect.any(Boolean));
        for (const name of ['toastTitle', 'logMissing', 'shareUnavailable', 'logCleared', 'logClearFailed']) expect([name, labels[name]]).toEqual([name, expect.any(String)]);
        for (const name of ['shareLog', 'clearLog']) expect([name, labels[name] === null || typeof labels[name] === 'object']).toEqual([name, true]);
    });
});
