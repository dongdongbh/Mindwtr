import { describe, expect, it } from 'vitest';
import { performSyncCycle } from './sync';
import { mergeSettingsForSync } from './sync-merge-settings';
import { buildLoadContext, runLoadMigrations } from './store-load-migrations';
import { DEFAULT_TASK_EDITOR_HIDDEN } from './task-editor-layout';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import type { AppData, TaskEditorSettings } from './types';

const NOW = '2026-09-12T12:00:00.000Z';
const layoutA: TaskEditorSettings = { order: ['status', 'project', 'priority'], hidden: ['location'], defaultsVersion: 5 };
const layoutB: TaskEditorSettings = { order: ['status', 'project', 'location'], hidden: ['priority'], defaultsVersion: 5 };
const defaults: TaskEditorSettings = { hidden: [...DEFAULT_TASK_EDITOR_HIDDEN], defaultsVersion: 5 };
const settings = (taskEditor: TaskEditorSettings, at?: string): AppData['settings'] => ({
    gtd: { taskEditor },
    syncPreferences: { gtd: true },
    ...(at ? { syncPreferencesUpdatedAt: { gtd: at } } : {}),
});
const document = (value: AppData['settings']): AppData => ({
    tasks: [], projects: [], sections: [], areas: [], people: [], settings: value,
});

describe('Task Editor Layout upgrade sync', () => {
    it.each([undefined, NOW, 'invalid'])('converges differing layouts with tied clocks (%s) without an edit', (at) => {
        const a = settings(layoutA, at);
        const b = settings(layoutB, at);
        const ab = mergeSettingsForSync(a, b);
        const ba = mergeSettingsForSync(b, a);
        expect(ab.gtd?.taskEditor).toEqual(ba.gtd?.taskEditor);
        expect([layoutA, layoutB]).toContainEqual(ab.gtd?.taskEditor);
        expect(mergeSettingsForSync(ab, ba)).toEqual(ab);
    });

    it.each([undefined, NOW])('preserves customization against migration defaults with clock %s', (at) => {
        const configured = settings(layoutA);
        const untouched = settings(defaults, at);
        expect(mergeSettingsForSync(configured, untouched).gtd?.taskEditor).toEqual(layoutA);
        expect(mergeSettingsForSync(untouched, configured).gtd?.taskEditor).toEqual(layoutA);
    });

    it('lets a newer explicit reset to default visibility win', () => {
        const reset = { ...defaults, order: layoutB.order };
        expect(mergeSettingsForSync(settings(layoutA), settings(reset, NOW)).gtd?.taskEditor).toEqual(reset);
    });

    it('converges when only field order differs', () => {
        const a = settings(layoutA);
        const b = settings({ ...layoutA, order: layoutB.order });
        expect(mergeSettingsForSync(a, b).gtd?.taskEditor).toEqual(mergeSettingsForSync(b, a).gtd?.taskEditor);
    });

    it.each([
        { ...defaults, presentation: 'modal' as const },
        { ...defaults, sectionOpen: { details: true } },
        { ...defaults, sections: { priority: 'basic' as const } },
    ])('preserves a newer customization of default visibility (%j)', (layout) => {
        const incoming = settings(layout, NOW);
        expect(mergeSettingsForSync(settings(layoutA), incoming).gtd?.taskEditor).toEqual(layout);
    });

    it('logs the upgrade resolution without layout values and stops once aligned', () => {
        const logs: LogPayload[] = [];
        setLogger((payload) => logs.push(payload));
        try {
            const configured = settings(layoutA);
            const merged = mergeSettingsForSync(settings(defaults), configured);
            expect(logs).toEqual([{
                level: 'info',
                message: 'Task editor layout sync conflict resolved',
                scope: 'sync',
                context: { releaseCheck: 'v1.3.0/task-editor-upgrade-sync', reason: 'explicit-layout' },
            }]);
            expect(merged.syncPreferencesUpdatedAt?.gtd).toBeUndefined();
            logs.length = 0;
            expect(mergeSettingsForSync(merged, configured)).toEqual(merged);
            expect(logs).toEqual([]);
        } finally {
            setLogger(consoleLogger);
        }
    });

    it('preserves the local layout when GTD sync is explicitly disabled', () => {
        const local = { ...settings(defaults), syncPreferences: { gtd: false } };
        expect(mergeSettingsForSync(local, settings(layoutA, NOW)).gtd?.taskEditor).toEqual(defaults);
    });

    it('syncs upgraded clients through an existing remote and stays aligned after reload', async () => {
        const upgrade = (data: AppData) => runLoadMigrations(
            data, buildLoadContext(data.settings, false, NOW, Date.parse(NOW)),
        ).data;
        let a = upgrade(document(settings({ ...layoutA, defaultsVersion: 4 })));
        let b = upgrade(document(settings({ ...layoutB, defaultsVersion: 4 })));
        let remote = document({}); // Server created before layouts entered the sync payload.
        expect(a.settings.syncPreferencesUpdatedAt?.gtd).toBeUndefined();
        expect(b.settings.syncPreferencesUpdatedAt?.gtd).toBeUndefined();
        const cycle = async (local: AppData): Promise<AppData> => {
            const result = await performSyncCycle({
                readLocal: async () => local,
                readRemote: async () => structuredClone(remote),
                writeLocal: async (data) => { local = structuredClone(data); },
                writeRemote: async (data) => { remote = JSON.parse(JSON.stringify(data)) as AppData; },
                now: () => NOW,
            });
            expect(result.status).toBe('success');
            return upgrade(local);
        };
        a = await cycle(a);
        b = await cycle(b);
        a = await cycle(a);
        b = await cycle(b);
        expect(a.settings.gtd?.taskEditor).toEqual(b.settings.gtd?.taskEditor);
        expect(remote.settings.gtd?.taskEditor).toEqual(a.settings.gtd?.taskEditor);
        const aligned = structuredClone(a.settings.gtd?.taskEditor);
        a = await cycle(a);
        b = await cycle(b);
        expect(a.settings.gtd?.taskEditor).toEqual(aligned);
        expect(b.settings.gtd?.taskEditor).toEqual(aligned);
    });
});
