import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations } from './i18n/i18n-loader';
import type { AppData, AppSettings, Task } from './types';
import {
    buildAndroidWidgetPublication,
    buildAndroidQuickCaptureLabels,
    buildWidgetPayload,
    createWidgetPayloadProjection,
    IOS_WIDGET_FAMILY_CACHE_ITEMS,
    iosWidgetProjectionOptions,
    resolveWidgetLanguage,
} from './widget-payload';

describe('Android quick capture destinations', () => {
    it('publishes localized creation choices and queue feedback without an Inbox-only placeholder', async () => {
        await loadTranslations('de');
        const labels = buildAndroidQuickCaptureLabels('de');
        expect(labels.statusLabels).toEqual({ inbox: 'Eingang', next: 'Nächste Aktionen', waiting: 'Warten', someday: 'Irgendwann/Vielleicht' });
        expect(labels.statusLabel).toBe('Status');
        expect(labels.placeholder).not.toContain('Eingang');
        expect(buildAndroidQuickCaptureLabels('en').queued).toContain('will be added');
    });
});

describe('resolveWidgetLanguage', () => {
    it('falls back to the device language, as the app does, when no language was chosen', () => {
        expect(resolveWidgetLanguage(null, undefined, 'es')).toBe('es');
        expect(resolveWidgetLanguage(null, 'system', 'ja')).toBe('ja');
        expect(resolveWidgetLanguage('system', 'system', 'zh')).toBe('zh');
        expect(resolveWidgetLanguage('unknown', undefined, 'uk')).toBe('uk');
    });

    it('keeps a chosen language ahead of the device language', () => {
        expect(resolveWidgetLanguage('zh', 'system', 'es')).toBe('zh');
        expect(resolveWidgetLanguage('en', undefined, 'es')).toBe('en');
        expect(resolveWidgetLanguage('en', 'de', 'es')).toBe('de');
        expect(resolveWidgetLanguage(null, undefined)).toBe('en');
    });
});

describe('iOS widget task contexts', () => {
    it('publishes existing contexts in every home-screen family alongside project and due metadata', () => {
        const now = new Date().toISOString();
        const contexts = ['@office', '@calls', '@电话'];
        const data: AppData = {
            tasks: [{
                id: 'context-task', title: 'Task', status: 'next', tags: [], contexts,
                projectId: 'project-1', isFocusedToday: true, dueDate: '2000-01-01',
                createdAt: now, updatedAt: now,
            }],
            projects: [{
                id: 'project-1', title: 'Launch', status: 'active', color: '#ABCDEF',
                order: 0, tagIds: [], createdAt: now, updatedAt: now,
            }],
            sections: [], areas: [], settings: {} as AppSettings,
        };
        const projection = createWidgetPayloadProjection(data, 'en', iosWidgetProjectionOptions({}));
        for (const maxItems of Object.values(IOS_WIDGET_FAMILY_CACHE_ITEMS)) {
            // Exercise the JSON boundary used by the native widget cache.
            const payload = JSON.parse(JSON.stringify(projection.build(maxItems)));
            const row = payload.sections.flatMap((section: { items: unknown[] }) => section.items)[0];
            expect(row).toMatchObject({
                id: 'context-task', contexts, contextLabel: 'Launch', identityColor: '#ABCDEF',
                dueTone: 'overdue', openUri: 'mindwtr://open?task=context-task',
            });
            expect(row.completionToken).toBeTruthy();
        }
        expect(data.tasks[0].contexts).toEqual(contexts);
    });

    it('keeps context-free cached rows small', () => {
        const now = new Date().toISOString();
        const data: AppData = {
            tasks: [{
                id: 'bare-task', title: 'Task', status: 'next', tags: [], contexts: [],
                isFocusedToday: true, createdAt: now, updatedAt: now,
            }],
            projects: [], sections: [], areas: [], settings: {} as AppSettings,
        };
        const payload = createWidgetPayloadProjection(data, 'en', iosWidgetProjectionOptions({})).build(3);
        expect(payload.items[0]).not.toHaveProperty('contexts');
    });
});

describe('widget times', () => {
    const originalTz = process.env.TZ;
    beforeAll(async () => {
        process.env.TZ = 'UTC';
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-28T15:30:00.000Z'));
        await loadTranslations('en');
        await loadTranslations('de');
    });
    afterAll(() => {
        vi.useRealTimers();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    const task = (id: string, extra: Partial<Task>): Task => ({
        id, title: id, status: 'next', tags: [], contexts: [],
        createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z', ...extra,
    });
    const times = (settings: Partial<AppSettings>, systemLocale = 'en-US', language: 'en' | 'de' = 'en') => {
        const data: AppData = {
            tasks: [task('due-tonight', { dueDate: '2026-09-28T21:30:00', startTime: '2026-09-28T08:05:00' })],
            projects: [], sections: [], areas: [], settings: settings as AppSettings,
        };
        const payload = buildWidgetPayload(data, language, { systemLocale });
        const row = payload.sections.find((section) => section.key === 'schedule')?.items[0];
        return { due: row?.dueLabel, start: row?.startLabel };
    };

    it('reads a 24-hour or 12-hour setting as the app does', () => {
        expect(times({ timeFormat: '24h' })).toEqual({ due: '21:30', start: 'Today 08:05' });
        expect(times({ timeFormat: '12h' })).toEqual({ due: '09:30 PM', start: 'Today 08:05 AM' });
    });

    it('reads the System setting as the app does on that device', () => {
        // The app formats 'p' in the device locale (configureDateFormatting's systemLocale).
        expect(times({}, 'en-US')).toEqual({ due: '9:30 PM', start: 'Today 8:05 AM' });
        expect(times({}, 'en-GB')).toEqual({ due: '21:30', start: 'Today 08:05' });
        expect(times({ timeFormat: 'system' }, 'de-DE', 'de')).toEqual({ due: '21:30', start: 'Heute 08:05' });
        // An explicit date format picks the locale, as it does in the app.
        expect(times({ dateFormat: 'dmy' }, 'en-US')).toEqual({ due: '21:30', start: 'Today 08:05' });
        expect(times({ dateFormat: 'mdy' }, 'en-GB')).toEqual({ due: '9:30 PM', start: 'Today 8:05 AM' });
    });

    it('formats times without Intl, as an engine without it must', () => {
        const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((() => {
            throw new Error('no Intl in this engine');
        }) as unknown as typeof Intl.DateTimeFormat);
        try {
            expect(times({}, 'en-GB')).toEqual({ due: '21:30', start: 'Today 08:05' });
        } finally {
            spy.mockRestore();
        }
    });

    it('reaches the device locale through the platform publications', () => {
        // A host without Intl names the device locale itself; both publication
        // paths must hand it to the builder.
        const data: AppData = {
            tasks: [
                task('due-tonight', { dueDate: '2026-09-28T21:30:00' }),
                task('overdue', { dueDate: '2026-09-25', isFocusedToday: true }),
            ],
            projects: [], sections: [], areas: [], settings: {} as AppSettings,
        };
        const labels = (payload: { sections: { items: { id: string; dueLabel: string | null }[] }[] }) => Object.fromEntries(
            payload.sections.flatMap((section) => section.items).map((item) => [item.id, item.dueLabel]),
        );
        const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((() => {
            throw new Error('no Intl in this engine');
        }) as unknown as typeof Intl.DateTimeFormat);
        try {
            const android = buildAndroidWidgetPublication(data, 'en', { systemLocale: 'en-GB', listSelections: [] });
            expect(labels(android)).toEqual({ 'due-tonight': '21:30', overdue: '25/9' });
            const ios = createWidgetPayloadProjection(data, 'en', iosWidgetProjectionOptions({ systemLocale: 'en-GB' })).build(20);
            expect(labels(ios)).toEqual({ 'due-tonight': '21:30', overdue: '25/9' });
        } finally {
            spy.mockRestore();
        }
    });
});


describe('Focus widget area selection', () => {
    it('keeps only selected-area stars while the occupied count remains global before criteria', () => {
        const stamp = '2026-10-01T12:00:00.000Z';
        const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'next',
            tags: [], contexts: [], isFocusedToday: true, createdAt: stamp, updatedAt: stamp, ...extra });
        const data: AppData = { tasks: [task('direct', { areaId: 'work' }), task('project', { projectId: 'p' }),
            task('home', { areaId: 'home' })], projects: [{ id: 'p', title: 'P', areaId: 'work', status: 'active',
                color: '#123456', order: 0, tagIds: [], createdAt: stamp, updatedAt: stamp }], sections: [],
            areas: ['work', 'home'].map((id, order) => ({ id, name: id, order, createdAt: stamp, updatedAt: stamp })),
            settings: { filters: { areaIds: ['work'] } } };
        const payload = createWidgetPayloadProjection(data, 'en').build(10);
        expect(payload.items.map((row) => row.id)).toEqual(['direct', 'project']);
        expect(payload.focusedCount).toBe(3);
        const filtered = createWidgetPayloadProjection(data, 'en', { focusFilter: { criteria: { hasDescription: true }, sortBy: 'default' } }).build(10);
        expect(filtered.items).toEqual([]);
        expect(filtered.focusedCount).toBe(3);
    });
});
