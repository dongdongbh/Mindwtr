import { afterEach, describe, expect, it } from 'vitest';
import { getTranslator } from './i18n';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { markArchiveRetentionSyncCompleted } from './store-archive-retention';
import type { AppSettings, Task } from './types';
import { generateUUID } from './uuid';

/** Native Android's Archive retention (#1320): RN's Data card and its root-layout runner through the native host contract. */
const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const archived = (id: string, days: number): Task => ({
    id, title: `Title ${id}`, status: 'archived', tags: [], contexts: [], createdAt: ago(days),
    updatedAt: ago(days), archivedAt: ago(days), rev: 1, revBy: 'device-a',
} as Task);

async function openHost(settings: AppSettings, tasks: Task[] = [archived('old', 100), archived('recent', 5)]) {
    await flushPendingSave();
    resetForTests();
    let data = { tasks, projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device-a', ...settings } };
    setStorageAdapter({
        getData: async () => JSON.parse(JSON.stringify(data)),
        saveData: async (next) => { data = JSON.parse(JSON.stringify(next)); },
    });
    useTaskStore.setState({ error: null, persistenceFailure: null, isLoading: false, editLockCount: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' }));
    value(await host.activate({ writeSafetyReady: true }));
    return host;
}

const purgedIds = () => useTaskStore.getState()._allTasks.filter((task) => task.purgedAt).map((task) => task.id);
const lines: LogPayload[] = [];
const runLines = () => lines.filter((line) => line.context?.releaseCheck === 'v1.3.8/native-archive-retention');

describe('native host contract: Archive retention runner', () => {
    afterEach(() => {
        setLogger(consoleLogger);
        lines.length = 0;
    });

    it('waits for this session\'s first sync while a backend is selected, then purges only items past the period (afa31ae1b)', async () => {
        const host = await openHost({ gtd: { archiveRetentionDays: 30 } });
        expect(value(await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'webdav' })))
            .toEqual({ outcome: 'skipped', purged: { tasks: 0, projects: 0, sections: 0 }, skipped: 'waiting-for-sync' });
        expect(purgedIds()).toEqual([]);
        markArchiveRetentionSyncCompleted();
        expect(value(await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'webdav' })))
            .toEqual({ outcome: 'purged', purged: { tasks: 1, projects: 0, sections: 0 }, skipped: null });
        expect(purgedIds()).toEqual(['old']);
    });

    it('counts a disconnected, unsupported or unreadable backend as selected, so it waits too (e3cc650bd, a680d9594)', async () => {
        const host = await openHost({ gtd: { archiveRetentionDays: 30 } });
        for (const selectedBackend of ['cloudkit', 'cloud', null]) {
            expect(value(await host.runArchiveRetention({ editorOpen: false, selectedBackend })).skipped).toBe('waiting-for-sync');
        }
        expect(purgedIds()).toEqual([]);
    });

    it('never runs while an editor is open, as RN\'s lockEditing (b7d252745), and runs once it closed', async () => {
        const host = await openHost({ gtd: { archiveRetentionDays: 30 } });
        expect(value(await host.runArchiveRetention({ editorOpen: true, selectedBackend: 'off' })))
            .toEqual({ outcome: 'skipped', purged: { tasks: 0, projects: 0, sections: 0 }, skipped: 'editor-open' });
        expect(purgedIds()).toEqual([]);
        expect(value(await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'off' })).outcome).toBe('purged');
        expect(purgedIds()).toEqual(['old']);
    });

    it('does nothing while retention is Never, and refuses a malformed request', async () => {
        const host = await openHost({});
        expect(value(await host.runArchiveRetention({ editorOpen: false, selectedBackend: 'off' })).skipped).toBe('off');
        expect(purgedIds()).toEqual([]);
        expect(await host.runArchiveRetention({ editorOpen: 'no', selectedBackend: 'off' } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('logs each new outcome once and every purge, with counts and never a title', async () => {
        const host = await openHost({ gtd: { archiveRetentionDays: 30 } });
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

describe('native host contract: Settings › Data Archive retention card', () => {
    const t = getTranslator('en');

    it('draws RN\'s card with the stored days, Never when off', async () => {
        const off = value((await openHost({})).getDataSettings()).archiveRetention;
        expect(off).toEqual({
            title: t('settings.archiveRetention'), description: t('settings.archiveRetentionDesc'), safety: t('settings.archiveRetentionSafety'),
            current: `${t('settings.archiveRetentionCurrent')}: ${t('settings.archiveRetentionNever')}`, days: 0,
            daysLabel: t('settings.archiveRetentionDaysLabel'), invalid: t('settings.archiveRetentionInvalid'), save: t('settings.archiveRetentionSave'),
            never: { label: t('settings.archiveRetentionNever'), edit: { type: 'archiveRetentionDays', value: 0 } },
            saveFailed: t('settings.archiveRetentionSaveFailed'),
        });
        const on = value((await openHost({ gtd: { archiveRetentionDays: 45 } })).getDataSettings()).archiveRetention;
        expect([on.days, on.current]).toEqual([45, `${t('settings.archiveRetentionCurrent')}: 45 days`]);
    });

    it('stores RN\'s values: Save writes the days into the synced GTD settings, Never writes 0', async () => {
        const host = await openHost({});
        const save = (days: unknown) => host.setDataSetting({ requestId: generateUUID(), edit: { type: 'archiveRetentionDays', value: days } as never });
        expect(value(await save(30)).changed).toBe(true);
        expect(useTaskStore.getState().settings.gtd?.archiveRetentionDays).toBe(30);
        expect(useTaskStore.getState().settings.syncPreferencesUpdatedAt?.gtd).toBeTruthy();
        expect(value(await save(30)).changed).toBe(false);
        expect(value(await save(0)).changed).toBe(true);
        expect(useTaskStore.getState().settings.gtd?.archiveRetentionDays).toBe(0);
        for (const bad of [36501, -1, 1.5, '30']) expect(await save(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('reviews a Save that turns retention on or shortens it, with RN\'s counts and candidates; a longer period or Never saves at once', async () => {
        const host = await openHost({});
        const review = value(host.getArchiveRetentionReview({ days: 30 })).review;
        expect(review).toEqual({
            days: 30,
            title: t('settings.archiveRetentionConfirmTitle'),
            description: t('settings.archiveRetentionConfirmDescription').replace('{days}', '30'),
            counts: 'Eligible now: 1 tasks, 0 projects, 0 sections.',
            legacy: t('settings.archiveRetentionLegacyCount').replace('{count}', '0'),
            heading: t('settings.archiveRetentionCandidates'),
            lines: [`${t('calendar.tasks')}: Title old`],
            cancel: t('common.cancel'),
            confirm: t('settings.archiveRetentionConfirmAction'),
            edit: { type: 'archiveRetentionDays', value: 30 },
        });
        expect(value(host.getArchiveRetentionReview({ days: 200 })).review?.heading).toBe(t('settings.archiveRetentionNoCandidates'));
        const on = await openHost({ gtd: { archiveRetentionDays: 30 } });
        expect(value(on.getArchiveRetentionReview({ days: 3 })).review?.lines).toHaveLength(2);
        expect(value(on.getArchiveRetentionReview({ days: 60 }))).toEqual({ review: null, edit: { type: 'archiveRetentionDays', value: 60 } });
        expect(value(on.getArchiveRetentionReview({ days: 0 })).review).toBeNull();
        expect(on.getArchiveRetentionReview({ days: 1.5 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
});
