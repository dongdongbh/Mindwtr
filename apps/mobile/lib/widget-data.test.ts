import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppData } from '@mindwtr/core';
import { buildShortcutsSnapshot, buildWidgetPayload, resolveWidgetLanguage, SHORTCUTS_SNAPSHOT_ITEM_CAP, SHORTCUTS_SNAPSHOT_PROJECT_CAP } from './widget-data';

const baseData: AppData = {
    tasks: [],
    projects: [],
    areas: [],
    sections: [],
    settings: {},
};

const pad = (n: number) => String(n).padStart(2, '0');
const toDateOnly = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysFromNow = (n: number): Date => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d;
};
const buildDueItem = (dueDate: string, language = 'en') => {
    const now = new Date().toISOString();
    const payload = buildWidgetPayload(
        {
            ...baseData,
            tasks: [
                {
                    id: 'due-task',
                    title: 'Due task',
                    status: 'next',
                    isFocusedToday: true,
                    dueDate,
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
        },
        language as Parameters<typeof buildWidgetPayload>[1],
    );
    return payload.items[0];
};

describe('widget-data', () => {
    it('resolves widget language with fallback', () => {
        expect(resolveWidgetLanguage('zh', undefined)).toBe('zh');
        expect(resolveWidgetLanguage('unknown', undefined)).toBe('en');
        expect(resolveWidgetLanguage(null, 'es')).toBe('es');
    });

    it('builds payload with focus-list tasks and defaults to three items', () => {
        const now = new Date().toISOString();
        const data: AppData = {
            ...baseData,
            tasks: [
                { id: '1', title: 'Focused 1', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '2', title: 'Focused 2', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '3', title: 'Focused 3', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '4', title: 'Focused 4', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '5', title: 'Next', status: 'next', isFocusedToday: false, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '6', title: 'Inbox', status: 'inbox', isFocusedToday: false, tags: [], contexts: [], createdAt: now, updatedAt: now },
            ],
        };
        const payload = buildWidgetPayload(data, 'en');
        expect(payload.headerTitle).toBeTruthy();
        expect(payload.items).toHaveLength(3);
        expect(payload.items.map((item) => item.title)).toEqual(['Focused 1', 'Focused 2', 'Focused 3']);
        // Widget rows open the task itself (Android row tap, #1173 seam).
        expect(payload.items.map((item) => item.openUri)).toEqual(['mindwtr://open?task=1', 'mindwtr://open?task=2', 'mindwtr://open?task=3']);
        expect(payload.inboxCount).toBe(1);
        expect(payload.subtitle).toBe('Inbox: 1 · +2 More');
    });

    it('builds the requested GTD lists and a sectioned project list in the screens\' orders (#1173)', () => {
        const now = new Date().toISOString();
        const data: AppData = {
            ...baseData,
            projects: [{ id: 'proj-1', title: 'Launch', status: 'active', color: '#8b5cf6', order: 0, tagIds: [], createdAt: now, updatedAt: now }],
            sections: [{ id: 'sec-1', projectId: 'proj-1', title: 'Prep', order: 0, createdAt: now, updatedAt: now }],
            tasks: [
                { id: '1', title: 'In prep', status: 'next', projectId: 'proj-1', sectionId: 'sec-1', order: 1, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '2', title: 'Loose', status: 'next', projectId: 'proj-1', order: 0, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '3', title: 'Older wait', status: 'waiting', tags: [], contexts: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: now },
                { id: '4', title: 'Newer wait', status: 'waiting', tags: [], contexts: [], createdAt: '2026-02-01T00:00:00.000Z', updatedAt: now },
                { id: '5', title: 'Inbox item', status: 'inbox', tags: [], contexts: [], createdAt: now, updatedAt: now },
            ],
        };
        const payload = buildWidgetPayload(data, 'en', { maxItems: 5, listIds: ['project:proj-1', 'waiting', 'inbox', 'project:nope'] });
        expect(Object.keys(payload.lists)).toEqual(['focus', 'project:proj-1', 'waiting', 'inbox']);
        expect(payload.lists['project:proj-1'].title).toBe('Launch');
        expect(payload.lists['project:proj-1'].sections?.map((section) => [section.title, section.items.map((item) => item.title)])).toEqual([
            ['Prep', ['In prep']],
            ['No Section', ['Loose']],
        ]);
        expect(payload.lists.waiting.items.map((item) => item.title)).toEqual(['Newer wait', 'Older wait']);
        expect(payload.lists.inbox.items.map((item) => item.title)).toEqual(['Inbox item']);
        expect(payload.projects).toEqual([{ id: 'proj-1', title: 'Launch', identityColor: '#8b5cf6' }]);
        expect(payload.lists.focus.sections).toBe(payload.sections);
    });

    it('carries the Focus screen sections with the shared cap, priority colour and project or area (#1173)', () => {
        const now = new Date().toISOString();
        const today = new Date(); today.setHours(23, 0, 0, 0);
        const data: AppData = {
            ...baseData,
            areas: [{ id: 'area-1', name: 'Home', order: 0, createdAt: now, updatedAt: now }],
            projects: [{ id: 'proj-1', title: 'Launch', status: 'active', color: '#8b5cf6', order: 0, tagIds: [], createdAt: now, updatedAt: now }],
            settings: { features: { priorities: true } } as AppData['settings'],
            tasks: [
                { id: '1', title: 'Starred', status: 'next', isFocusedToday: true, priority: 'urgent', projectId: 'proj-1', tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '2', title: 'Due today', status: 'next', dueDate: today.toISOString(), areaId: 'area-1', tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '3', title: 'Alpha next', status: 'next', tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '4', title: 'Beta next', status: 'next', tags: [], contexts: [], createdAt: now, updatedAt: now },
            ],
        };
        const payload = buildWidgetPayload(data, 'en', { maxItems: 3 });
        expect(payload.sections.map((section) => [section.key, section.title, section.items.map((item) => item.title)])).toEqual([
            ['focus', "Today's Focus", ['Starred']],
            ['schedule', 'Today', ['Due today']],
            ['next', 'Next Actions', ['Alpha next']],
        ]);
        const [starred] = payload.sections[0].items;
        expect(starred.priorityColor).toBe('#dc2626');
        expect(starred.contextLabel).toBe('Launch');
        expect(starred.identityColor).toBe('#8b5cf6');
        expect(payload.sections[1].items[0]).toMatchObject({ dueTone: 'today', dueEmphasis: true, identityColor: null });
        expect(payload.sections[1].detail).toMatch(/\d/);
        expect(payload.sections[2].detail).toBeNull();
        expect(payload.dateLabel).toMatch(/\d/);
        expect(payload.palette.warning).toMatch(/^#/);
        expect(payload.sections[1].items[0].contextLabel).toBe('Home');
        expect(payload.sections[2].items[0]).toMatchObject({ priorityColor: null, contextLabel: null });
        // Priorities off: the colour is gated with the feature.
        const gated = buildWidgetPayload({ ...data, settings: { features: { priorities: false } } as AppData['settings'] }, 'en', { maxItems: 3 });
        expect(gated.sections[0].items[0].priorityColor).toBeNull();
    });

    it('honors maxItems option for larger widgets', () => {
        const now = new Date().toISOString();
        const data: AppData = {
            ...baseData,
            tasks: [
                { id: '1', title: 'Focused 1', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '2', title: 'Focused 2', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '3', title: 'Focused 3', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '4', title: 'Focused 4', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '5', title: 'Focused 5', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
            ],
        };
        const payload = buildWidgetPayload(data, 'en', { maxItems: 5 });
        expect(payload.items).toHaveLength(5);
        expect(payload.items.map((item) => item.title)).toEqual([
            'Focused 1',
            'Focused 2',
            'Focused 3',
            'Focused 4',
            'Focused 5',
        ]);
        expect(payload.subtitle).toBe('Inbox: 0');
    });

    it('puts starred tasks first and counts them in focusedCount regardless of maxItems (#821)', () => {
        const now = new Date().toISOString();
        const data: AppData = {
            ...baseData,
            tasks: [
                { id: '1', title: 'Next A', status: 'next', isFocusedToday: false, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '2', title: 'Starred next', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '3', title: 'Starred waiting', status: 'waiting', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '4', title: 'Next B', status: 'next', isFocusedToday: false, tags: [], contexts: [], createdAt: now, updatedAt: now },
            ],
        };
        const payload = buildWidgetPayload(data, 'en', { maxItems: 2 });
        expect(payload.items.map((item) => item.title)).toEqual(['Starred next', 'Starred waiting']);
        expect(payload.focusedCount).toBe(2);
    });

    it('reports zero focusedCount when nothing is starred while still listing next actions (#821)', () => {
        const now = new Date().toISOString();
        const data: AppData = {
            ...baseData,
            tasks: [
                { id: '1', title: 'Test1', status: 'next', isFocusedToday: false, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '2', title: 'Test 2', status: 'next', isFocusedToday: false, tags: [], contexts: [], createdAt: now, updatedAt: now },
            ],
        };
        const payload = buildWidgetPayload(data, 'en');
        expect(payload.items.map((item) => item.title)).toEqual(['Test1', 'Test 2']);
        expect(payload.focusedCount).toBe(0);
    });

    it('keeps the widget palette aligned with Sepia theme settings', () => {
        const payload = buildWidgetPayload(
            {
                ...baseData,
                settings: { theme: 'sepia' },
            },
            'en'
        );

        expect(payload.palette.background).toBe('#FAF3E3');
        expect(payload.palette.text).toBe('#3B2F2F');
        expect(payload.palette.mutedText).toBe('#7A5C3E');
        expect(payload.palette.accent).toBe('#956735');
    });

    // These preset themes all classify as "dark" or "light" under
    // resolveThemeColorScheme, but the widget must render their real preset
    // colors, not the generic dark/light fallback (the Android/iOS parity bug).
    it('keeps the widget palette aligned with Nord theme settings', () => {
        const payload = buildWidgetPayload({ ...baseData, settings: { theme: 'nord' } }, 'en');
        expect(payload.palette.background).toBe('#3B4252');
        expect(payload.palette.text).toBe('#ECEFF4');
        expect(payload.palette.mutedText).toBe('#D8DEE9');
        expect(payload.palette.accent).toBe('#88C0D0');
    });

    it('keeps the widget palette aligned with Catppuccin Macchiato theme settings', () => {
        const payload = buildWidgetPayload({ ...baseData, settings: { theme: 'catppuccin-macchiato' } }, 'en');
        expect(payload.palette.background).toBe('#363A4F');
        expect(payload.palette.text).toBe('#CAD3F5');
        expect(payload.palette.mutedText).toBe('#A5ADCB');
        expect(payload.palette.accent).toBe('#C6A0F6');
    });

    it('keeps the widget palette aligned with Dracula theme settings', () => {
        const payload = buildWidgetPayload({ ...baseData, settings: { theme: 'dracula' } }, 'en');
        expect(payload.palette.background).toBe('#343746');
        expect(payload.palette.text).toBe('#F8F8F2');
        expect(payload.palette.mutedText).toBe('#ADB5CB');
        expect(payload.palette.accent).toBe('#BD93F9');
    });

    it('keeps the widget palette aligned with OLED theme settings', () => {
        const payload = buildWidgetPayload({ ...baseData, settings: { theme: 'oled' } }, 'en');
        expect(payload.palette.background).toBe('#000000');
        expect(payload.palette.text).toBe('#E5E7EB');
        expect(payload.palette.mutedText).toBe('#9CA3AF');
        expect(payload.palette.accent).toBe('#4F9DFF');
    });

    it('keeps the widget palette aligned with E-ink theme settings', () => {
        const payload = buildWidgetPayload({ ...baseData, settings: { theme: 'eink' } }, 'en');
        expect(payload.palette.background).toBe('#FFFFFF');
        expect(payload.palette.text).toBe('#000000');
        expect(payload.palette.accent).toBe('#000000');
    });

    it('falls back to the generic dark palette for plain dark/system themes', () => {
        const payload = buildWidgetPayload(
            { ...baseData, settings: { theme: 'dark' } },
            'en',
            { systemColorScheme: 'light' },
        );
        expect(payload.palette.background).toBe('#111827');
        expect(payload.palette.text).toBe('#F9FAFB');
    });

    it('includes focus-page schedule/next tasks even when none are explicitly focused', () => {
        const now = new Date().toISOString();
        const data: AppData = {
            ...baseData,
            tasks: [
                {
                    id: 'next-due',
                    title: 'Next due today',
                    status: 'next',
                    dueDate: '2000-01-01',
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'next-now',
                    title: 'Next action',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'next-future',
                    title: 'Future next action',
                    status: 'next',
                    startTime: '2999-01-01T00:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
        };
        const payload = buildWidgetPayload(data, 'en');
        expect(payload.items.map((item) => item.id)).toEqual(['next-due', 'next-now']);
    });

    it('keeps deferred project tasks out of widget focus items and inbox count', () => {
        const now = new Date().toISOString();
        const data: AppData = {
            ...baseData,
            projects: [
                {
                    id: 'active-project',
                    title: 'Active project',
                    status: 'active',
                    color: '#123456',
                    order: 0,
                    tagIds: [],
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'someday-project',
                    title: 'Someday project',
                    status: 'someday',
                    color: '#654321',
                    order: 1,
                    tagIds: [],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            tasks: [
                {
                    id: 'active-next',
                    title: 'Active next',
                    status: 'next',
                    projectId: 'active-project',
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'deferred-next',
                    title: 'Deferred next',
                    status: 'next',
                    projectId: 'someday-project',
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'deferred-inbox',
                    title: 'Deferred inbox',
                    status: 'inbox',
                    projectId: 'someday-project',
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
        };

        const payload = buildWidgetPayload(data, 'en');

        expect(payload.items.map((item) => item.id)).toEqual(['active-next']);
        expect(payload.inboxCount).toBe(0);
    });

    it('does not let earlier non-widget tasks block a sequential project next task', () => {
        const now = new Date().toISOString();
        const data: AppData = {
            ...baseData,
            projects: [
                {
                    id: 'project-1',
                    title: 'Sequential project',
                    status: 'active',
                    isSequential: true,
                    color: '#123456',
                    order: 0,
                    tagIds: [],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            tasks: [
                {
                    id: 'inbox-before',
                    title: 'Inbox before',
                    status: 'inbox',
                    projectId: 'project-1',
                    order: 0,
                    orderNum: 0,
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'available-next',
                    title: 'Available next',
                    status: 'next',
                    projectId: 'project-1',
                    order: 1,
                    orderNum: 1,
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
        };

        const payload = buildWidgetPayload(data, 'en');

        expect(payload.items.map((item) => item.id)).toEqual(['available-next']);
    });

    it('gives the sequential project slot to the later step that is due today', () => {
        // The widget must name the same next action the Focus screen does
        // (#1090). Selecting by chain order alone showed 'step-1' here.
        const now = new Date().toISOString();
        const dueToday = daysFromNow(0);
        dueToday.setHours(17, 0, 0, 0);
        const data: AppData = {
            ...baseData,
            projects: [
                {
                    id: 'project-1',
                    title: 'Sequential project',
                    status: 'active',
                    isSequential: true,
                    color: '#123456',
                    order: 0,
                    tagIds: [],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            tasks: [
                {
                    id: 'step-1',
                    title: 'Step 1',
                    status: 'next',
                    projectId: 'project-1',
                    order: 0,
                    orderNum: 0,
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'step-3',
                    title: 'Step 3',
                    status: 'next',
                    projectId: 'project-1',
                    order: 2,
                    orderNum: 2,
                    dueDate: dueToday.toISOString(),
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
        };

        const payload = buildWidgetPayload(data, 'en');

        expect(payload.items.map((item) => item.id)).toEqual(['step-3']);
    });

    it('includes the first widget task from each section for section-scoped sequential projects', () => {
        const now = new Date().toISOString();
        const data: AppData = {
            ...baseData,
            projects: [
                {
                    id: 'project-1',
                    title: 'Sequential project',
                    status: 'active',
                    isSequential: true,
                    sequentialScope: 'section',
                    color: '#123456',
                    order: 0,
                    tagIds: [],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            tasks: [
                {
                    id: 'section-a-first',
                    title: 'Section A first',
                    status: 'next',
                    projectId: 'project-1',
                    sectionId: 'section-a',
                    order: 0,
                    orderNum: 0,
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'section-a-second',
                    title: 'Section A second',
                    status: 'next',
                    projectId: 'project-1',
                    sectionId: 'section-a',
                    order: 1,
                    orderNum: 1,
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'section-b-first',
                    title: 'Section B first',
                    status: 'next',
                    projectId: 'project-1',
                    sectionId: 'section-b',
                    order: 2,
                    orderNum: 2,
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
        };

        const payload = buildWidgetPayload(data, 'en');

        expect(payload.items.map((item) => item.id)).toEqual(['section-a-first', 'section-b-first']);
    });

    it('keeps future-start tasks out of the widget payload even when focused', () => {
        const created = new Date().toISOString();
        const future = '2999-01-01T09:00:00.000Z';
        const data: AppData = {
            ...baseData,
            tasks: [
                {
                    id: 'focus-future',
                    title: 'Focused future',
                    status: 'next',
                    isFocusedToday: true,
                    startTime: future,
                    tags: [],
                    contexts: [],
                    createdAt: created,
                    updatedAt: created,
                },
                {
                    id: 'non-focus-future',
                    title: 'Non-focus future',
                    status: 'next',
                    isFocusedToday: false,
                    startTime: future,
                    tags: [],
                    contexts: [],
                    createdAt: created,
                    updatedAt: created,
                },
            ],
        };
        const payload = buildWidgetPayload(data, 'en');
        expect(payload.items).toHaveLength(0);
    });

    it('orders focused tasks using task sort setting before taking top three', () => {
        const data: AppData = {
            ...baseData,
            settings: { taskSortBy: 'created-desc' },
            tasks: [
                {
                    id: 'old',
                    title: 'Old',
                    status: 'next',
                    isFocusedToday: true,
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-20T10:00:00.000Z',
                    updatedAt: '2026-02-20T10:00:00.000Z',
                },
                {
                    id: 'newest',
                    title: 'Newest',
                    status: 'next',
                    isFocusedToday: true,
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-22T10:00:00.000Z',
                    updatedAt: '2026-02-22T10:00:00.000Z',
                },
                {
                    id: 'middle',
                    title: 'Middle',
                    status: 'next',
                    isFocusedToday: true,
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-21T10:00:00.000Z',
                    updatedAt: '2026-02-21T10:00:00.000Z',
                },
                {
                    id: 'older',
                    title: 'Older',
                    status: 'next',
                    isFocusedToday: true,
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-19T10:00:00.000Z',
                    updatedAt: '2026-02-19T10:00:00.000Z',
                },
            ],
        };
        const payload = buildWidgetPayload(data, 'en');
        expect(payload.items.map((item) => item.id)).toEqual(['newest', 'middle', 'old']);
    });

    describe('due labels', () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('labels a task due today with emphasis (date-only string)', () => {
            const item = buildDueItem(toDateOnly(new Date()));
            expect(item.dueLabel).toBe('Today');
            expect(item.dueEmphasis).toBe(true);
        });

        it('labels an overdue task with a compact numeric date and emphasis', () => {
            const item = buildDueItem('2000-01-01');
            expect(item.dueLabel).toBe(
                new Intl.DateTimeFormat('en', { month: 'numeric', day: 'numeric' }).format(
                    new Date(2000, 0, 1),
                ),
            );
            expect(item.dueEmphasis).toBe(true);
        });

        it('labels a task due tomorrow without emphasis', () => {
            const item = buildDueItem(toDateOnly(daysFromNow(1)));
            expect(item.dueLabel).toBe('Tomorrow');
            expect(item.dueEmphasis).toBe(false);
        });

        it('labels a task due within the week with a short weekday', () => {
            const target = daysFromNow(3);
            const item = buildDueItem(toDateOnly(target));
            const expected = new Intl.DateTimeFormat('en', { weekday: 'short' }).format(target);
            expect(item.dueLabel).toBe(expected);
            expect(item.dueLabel).not.toBe('Tomorrow');
            expect(item.dueEmphasis).toBe(false);
        });

        it('labels a far-future task with a compact numeric date, no emphasis', () => {
            const target = daysFromNow(30);
            const item = buildDueItem(toDateOnly(target));
            const expected = new Intl.DateTimeFormat('en', { month: 'numeric', day: 'numeric' }).format(target);
            expect(item.dueLabel).toBe(expected);
            expect(item.dueEmphasis).toBe(false);
        });

        it('returns a null label for a task with no due date', () => {
            const item = buildDueItem('');
            expect(item.dueLabel).toBeNull();
            expect(item.dueEmphasis).toBe(false);
        });

        it('falls back to plain strings when Intl throws', () => {
            vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((() => {
                throw new Error('no intl');
            }) as unknown as typeof Intl.DateTimeFormat);

            const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const weekTarget = daysFromNow(3);
            const weekItem = buildDueItem(toDateOnly(weekTarget));
            expect(weekItem.dueLabel).toBe(weekday[weekTarget.getDay()]);

            const farTarget = daysFromNow(30);
            const farItem = buildDueItem(toDateOnly(farTarget));
            expect(farItem.dueLabel).toBe(`${farTarget.getMonth() + 1}/${farTarget.getDate()}`);
        });
    });

    describe('buildShortcutsSnapshot', () => {
        const now = new Date().toISOString();
        const task = (overrides: Partial<AppData['tasks'][number]>): AppData['tasks'][number] => ({
            id: overrides.id ?? 'task',
            title: overrides.title ?? 'Task',
            status: overrides.status ?? 'next',
            tags: [],
            contexts: [],
            createdAt: now,
            updatedAt: now,
            ...overrides,
        });

        it('buckets tasks by list, dropping done/archived/reference/deleted', () => {
            const data: AppData = {
                ...baseData,
                tasks: [
                    task({ id: 'i1', status: 'inbox' }),
                    task({ id: 'n1', status: 'next' }),
                    task({ id: 'w1', status: 'waiting' }),
                    task({ id: 's1', status: 'someday' }),
                    task({ id: 'd1', status: 'done' }),
                    task({ id: 'a1', status: 'archived' }),
                    task({ id: 'r1', status: 'reference' }),
                    task({ id: 'del1', status: 'next', deletedAt: now }),
                ],
            };

            const snapshot = buildShortcutsSnapshot(data);

            expect(snapshot.lists.inbox.map((item) => item.id)).toEqual(['i1']);
            expect(snapshot.lists.next.map((item) => item.id)).toEqual(['n1']);
            expect(snapshot.lists.waiting.map((item) => item.id)).toEqual(['w1']);
            expect(snapshot.lists.someday.map((item) => item.id)).toEqual(['s1']);
            const allIds = Object.values(snapshot.lists).flat().map((item) => item.id);
            expect(allIds).not.toContain('d1');
            expect(allIds).not.toContain('a1');
            expect(allIds).not.toContain('r1');
            expect(allIds).not.toContain('del1');
        });

        it('puts starred next-action tasks in the focus list', () => {
            const data: AppData = {
                ...baseData,
                tasks: [task({ id: 'star1', status: 'next', isFocusedToday: true })],
            };

            const snapshot = buildShortcutsSnapshot(data);

            expect(snapshot.lists.focus.map((item) => item.id)).toEqual(['star1']);
        });

        it('groups active-project tasks and carries dueDate/startDate/project fields', () => {
            const data: AppData = {
                ...baseData,
                projects: [
                    { id: 'p1', title: 'Errands', status: 'active', color: '#000', order: 0, tagIds: [], createdAt: now, updatedAt: now },
                    { id: 'p2', title: 'Old', status: 'archived', color: '#000', order: 1, tagIds: [], createdAt: now, updatedAt: now },
                ],
                tasks: [
                    task({ id: 't1', projectId: 'p1', dueDate: '2026-08-14', startTime: '2026-08-01' }),
                    task({ id: 't2', projectId: 'p2' }),
                ],
            };

            const snapshot = buildShortcutsSnapshot(data);

            expect(snapshot.projects).toHaveLength(1);
            expect(snapshot.projects[0].id).toBe('p1');
            expect(snapshot.projects[0].name).toBe('Errands');
            const item = snapshot.projects[0].items[0];
            expect(item.id).toBe('t1');
            expect(item.projectId).toBe('p1');
            expect(item.projectName).toBe('Errands');
            expect(item.dueDate).toBe('2026-08-14');
            expect(item.startDate).toBe('2026-08-01');
            // The archived project's task is neither an active-project group
            // nor, on its own, excluded from list buckets by project status --
            // but only active projects get a group at all.
            expect(snapshot.projects.some((group) => group.id === 'p2')).toBe(false);
        });

        it('groups each project from a single pass without cross-contaminating other projects', () => {
            const data: AppData = {
                ...baseData,
                projects: [
                    { id: 'p1', title: 'Errands', status: 'active', color: '#000', order: 0, tagIds: [], createdAt: now, updatedAt: now },
                    { id: 'p2', title: 'Home', status: 'active', color: '#000', order: 1, tagIds: [], createdAt: now, updatedAt: now },
                ],
                tasks: [
                    task({ id: 't1', projectId: 'p1' }),
                    task({ id: 't2', projectId: 'p2' }),
                    task({ id: 't3', projectId: 'p1' }),
                    task({ id: 't4' }), // no project at all
                ],
            };

            const snapshot = buildShortcutsSnapshot(data);

            const p1 = snapshot.projects.find((group) => group.id === 'p1');
            const p2 = snapshot.projects.find((group) => group.id === 'p2');
            expect(p1?.items.map((item) => item.id).sort()).toEqual(['t1', 't3']);
            expect(p2?.items.map((item) => item.id)).toEqual(['t2']);
        });

        it('caps the number of project groups deterministically by project order', () => {
            const manyProjects = Array.from({ length: SHORTCUTS_SNAPSHOT_PROJECT_CAP + 10 }, (_, index) => ({
                id: `p${index}`,
                title: `Project ${index}`,
                status: 'active' as const,
                color: '#000',
                // Reverse order so the survivors (lowest order) are NOT simply
                // "first in the array" -- proves the cap sorts by order.
                order: SHORTCUTS_SNAPSHOT_PROJECT_CAP + 10 - index,
                tagIds: [],
                createdAt: now,
                updatedAt: now,
            }));
            const tasksOnePerProject = manyProjects.map((project, index) => (
                task({ id: `t${index}`, projectId: project.id })
            ));

            const snapshot = buildShortcutsSnapshot({ ...baseData, projects: manyProjects, tasks: tasksOnePerProject });

            expect(snapshot.projects).toHaveLength(SHORTCUTS_SNAPSHOT_PROJECT_CAP);
            // The lowest `order` values are the last projects in the array
            // (reversed order above), so they must be the ones that survive.
            const survivingIds = new Set(snapshot.projects.map((group) => group.id));
            for (let index = manyProjects.length - SHORTCUTS_SNAPSHOT_PROJECT_CAP; index < manyProjects.length; index += 1) {
                expect(survivingIds.has(manyProjects[index].id)).toBe(true);
            }
        });

        it('caps each list and project at the shared item cap', () => {
            const manyTasks = Array.from({ length: SHORTCUTS_SNAPSHOT_ITEM_CAP + 10 }, (_, index) => (
                task({ id: `n${index}`, status: 'next' })
            ));
            const snapshot = buildShortcutsSnapshot({ ...baseData, tasks: manyTasks });

            expect(snapshot.lists.next).toHaveLength(SHORTCUTS_SNAPSHOT_ITEM_CAP);
        });

        it('never includes a generatedAt-dependent field inside lists/projects', () => {
            const snapshot = buildShortcutsSnapshot({ ...baseData, tasks: [task({ id: 't1' })] });
            expect(typeof snapshot.generatedAt).toBe('string');
            expect(new Date(snapshot.generatedAt).toString()).not.toBe('Invalid Date');
        });
    });
});
