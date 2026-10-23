import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations } from './i18n/i18n-loader';
import { createNativeHostContract } from './native-host-contract';
import {
    createReviewRecorder,
    loadReviewViewsFixture,
    projectObservation,
    replayReviewScenario,
    seedReviewStore,
    type ReviewPart,
} from './review-views-model.replay';
import {
    buildReviewSuggestionUpdates,
    decorateReviewOverviewGroups,
    filterReviewSuggestions,
    getWeeklyReviewCalendar,
    getReviewExpansionControl,
    getReviewOverviewText,
    getWeeklyReviewLabels,
    getWeeklyReviewProjects,
    planDailyReviewFollowUp,
    restoreReviewSession,
} from './review-views-model';
import { configureDateFormatting } from './date';
import { resetForTests } from './store';
import type { Task } from './types';

const fixture = loadReviewViewsFixture();
const PARTS: ReviewPart[] = ['review', 'weeklyReview', 'dailyReview'];

describe('review views parity with the frozen React Native fixture', () => {
    const originalTz = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = fixture.review.timeZone;
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.review.now));
    });
    afterAll(() => {
        vi.useRealTimers();
        configureDateFormatting();
        resetForTests();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    it('was captured from React Native before the screens changed', () => {
        expect(fixture.provenance.capturedAt).toMatch(/^[0-9a-f]{40}$/);
        for (const part of PARTS) expect(fixture[part].scenarios.length).toBe(Object.keys(fixture[part].observations).length);
    });

    for (const part of PARTS) {
        for (const scenario of fixture[part].scenarios) {
            it(`the native host contract reproduces ${part} "${scenario.name}"`, async () => {
                const recorder = createReviewRecorder();
                await seedReviewStore(fixture[part], scenario, recorder);
                const contract = createNativeHostContract();
                expect((await contract.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).ok).toBe(true);
                expect((await contract.activate({ writeSafetyReady: true })).ok).toBe(true);
                recorder.log.splice(0);
                const observed = await replayReviewScenario({ part, fixture: fixture[part], scenario, recorder, contract });
                expect(observed.map(projectObservation)).toEqual(fixture[part].observations[scenario.name].map(projectObservation));
            });
        }
    }
});

describe('review view models', () => {
    it('keeps every Weekly Review label on a typed key, with English when a key is missing', async () => {
        const keys: string[] = [];
        const translated = getWeeklyReviewLabels((key) => {
            keys.push(key);
            return `translated:${key}`;
        });
        expect(Object.values(translated).every((label) => label.startsWith('translated:'))).toBe(true);
        expect(keys).toEqual(expect.arrayContaining(['review.inboxGuide', 'review.calendarTasks', 'review.next', 'review.moreItems']));
        const english = getWeeklyReviewLabels((key) => key);
        expect(english.calendarTasks).toBe('Mindwtr tasks (next 7 days)');
        const strings = await loadTranslations('en');
        expect(getWeeklyReviewLabels((key) => strings[key] ?? key).calendar).toBe(strings['nav.calendar']);
    });

    it('cycles the expansion: areas, then projects, then nothing', () => {
        const text = getReviewOverviewText((key) => key);
        const groups = [{ id: 'area:a', projectGroups: [{ id: 'project:p' }, { id: 'single:area:a' }] }] as never;
        const none = { areaIds: new Set<string>(), projectIds: new Set<string>() };
        expect(getReviewExpansionControl(groups, none, text).next).toEqual({ areaIds: ['area:a'], projectIds: [] });
        const areas = { areaIds: new Set(['area:a']), projectIds: new Set<string>() };
        expect(getReviewExpansionControl(groups, areas, text).next).toEqual({ areaIds: ['area:a'], projectIds: ['project:p', 'single:area:a'] });
        const all = { areaIds: new Set(['area:a']), projectIds: new Set(['project:p', 'single:area:a']) };
        expect(getReviewExpansionControl(groups, all, text)).toMatchObject({ allExpanded: true, next: { areaIds: [], projectIds: [] } });
        expect(getReviewExpansionControl([], none, text)).toMatchObject({ disabled: true, next: null });
    });

    it('resumes a paused review only within its week or day', () => {
        const now = new Date(2026, 8, 23, 10);
        // Sunday: this week by default, last week when weeks start on Monday.
        const stored = JSON.stringify({ step: 'projects', startedAt: new Date(2026, 8, 20, 9).toISOString() });
        expect(restoreReviewSession('weekly', stored, { now })).toMatchObject({ resumed: true, session: { step: 'projects' } });
        expect(restoreReviewSession('weekly', stored, { now, weekStart: 'monday' })).toMatchObject({ resumed: false, session: { step: 'inbox' } });
        expect(restoreReviewSession('daily', stored, { now })).toEqual({ resumed: false, session: { step: 'today', startedAt: now.toISOString() } });
    });

    it('follows up a waiting item once, at the start of the review day', () => {
        const today = new Date(2026, 8, 23);
        const task = { id: 't', title: 'T', status: 'waiting', reviewAt: '2026-10-05' } as Task;
        expect(planDailyReviewFollowUp(task, today)).toEqual({ reviewAt: '2026-09-23' });
        expect(planDailyReviewFollowUp({ ...task, reviewAt: today.toISOString() }, today)).toBeNull();
    });

    it('keeps a date-only due date free of clock time', () => {
        const task = { id: 'due', title: 'Due', dueDate: '2026-09-23' } as Task;
        const labels = getWeeklyReviewLabels();
        const format = (_date: Date, pattern: string) => pattern;
        expect(getWeeklyReviewCalendar([], [{ task, date: new Date(2026, 8, 23), kind: 'due' }], labels, format).tasks[0].meta).toBe('Due · P');
    });

    it('uses theme tint for an area whose first project has only the placeholder color', () => {
        const text = getReviewOverviewText((key) => ({ 'list.countTaskSingular': 'task', 'list.countProjectSingular': 'project' }[key] ?? key));
        const groups = [{ areaId: 'area', taskCount: 1, projectCount: 1, needsActionCount: 0,
            projectGroups: [{ project: { id: 'project', title: 'Project', color: '#94a3b8' }, tasks: [{ id: 'task' }], nextActionState: 'next' }] }] as never;
        const [area] = decorateReviewOverviewGroups(groups, { areaById: new Map([['area', { id: 'area', name: 'Area' } as never]]), text, unassignedAreaColor: undefined });
        expect(area.color).toBeNull();
        expect(area.summary).toContain('1 project');
        expect(area.summary).toContain('1 task');
        expect(area.projectGroups[0].summary).toContain('1 active task');
    });

    it('does not borrow a chosen project color for an uncolored area', () => {
        const groups = [{ areaId: 'area', taskCount: 1, projectCount: 1, needsActionCount: 0,
            projectGroups: [{ project: { id: 'project', title: 'Project', color: '#f59e0b' },
                tasks: [{ id: 'task' }], nextActionState: 'next' }] }] as never;
        const [area] = decorateReviewOverviewGroups(groups, { areaById: new Map([['area', { id: 'area', name: 'Area' } as never]]),
            text: getReviewOverviewText((key) => key), unassignedAreaColor: undefined });
        expect(area.color).toBeNull();
    });

    it('does not claim a project lacks a next action from a due-only subset', () => {
        const groups = [{ areaId: 'area', taskCount: 1, projectCount: 1, needsActionCount: 1,
            projectGroups: [{ project: { id: 'project', title: 'Project' }, tasks: [{ id: 'due', status: 'someday' }], nextActionState: 'none' }] }] as never;
        const [area] = decorateReviewOverviewGroups(groups, {
            areaById: new Map([['area', { id: 'area', name: 'Area' } as never]]),
            text: getReviewOverviewText((key) => key), unassignedAreaColor: undefined, scope: 'due',
        });
        expect(area.summary).not.toContain('needs action');
        expect(area.projectGroups[0]).toMatchObject({ statusTone: null, summaryTone: 'secondary' });
        expect(area.projectGroups[0].summary).not.toContain('Needs Action');
    });

    it('shows a red Project override in a blue Area without changing next-action badges', () => {
        const [entry] = getWeeklyReviewProjects([{ project: { id: 'project', areaId: 'blue',
            color: '#ff0000', colorOverride: '#ff0000' }, tasks: [], nextActionState: 'none' }] as never,
        new Map([['blue', { id: 'blue', color: '#0000ff' } as never]]), getWeeklyReviewLabels((key) => key));
        expect(entry.areaColor).toBe('#ff0000');
        expect(entry.badge.color).toBe('#EF4444');
    });

    it('uses the singular active-task noun in Weekly Review Projects', () => {
        const labels = getWeeklyReviewLabels((key) => ({ 'review.activeTask': 'active task',
            'review.activeTasks': 'active tasks' }[key] ?? key));
        const [entry] = getWeeklyReviewProjects([{ project: { id: 'project' }, tasks: [{ id: 'task' }],
            nextActionState: 'next' }] as never, new Map(), labels);
        expect(entry.countLabel).toBe('1 active task');
    });

    it('applies only selected someday and archive suggestions for tasks', () => {
        const now = new Date('2026-09-23T14:00:00.000Z');
        const updates = buildReviewSuggestionUpdates([
            { id: 'a', action: 'someday', reason: '' },
            { id: 'b', action: 'archive', reason: '' },
            { id: 'project:p', action: 'archive', reason: '' },
            { id: 'c', action: 'keep', reason: '' },
            { id: 'd', action: 'someday', reason: '' },
        ], new Set(['a', 'b', 'project:p', 'c']), now);
        expect(updates).toEqual([
            { id: 'a', updates: { status: 'someday' } },
            { id: 'b', updates: { status: 'archived', completedAt: now.toISOString() } },
        ]);
    });

    it('keeps a suggestion title after its task leaves the stale bucket', () => {
        const [suggestion] = filterReviewSuggestions([{ id: 'task', action: 'someday', reason: 'old' }],
            [{ id: 'task', title: 'Fix bike' } as never]);
        expect(suggestion.title).toBe('Fix bike');
    });
});
