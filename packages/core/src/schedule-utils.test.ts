import { describe, expect, it } from 'vitest';

import {
    areDueDateRemindersEnabled,
    areStartDateRemindersEnabled,
    areTaskRemindersEnabled,
    buildReminderNotificationBody,
    buildReminderSchedule,
    getDigestSchedule,
    getDueReminderRepeatTimes,
    getNextScheduledAt,
    getProjectReviewReminderIntent,
    getReminderNotificationTag,
    getTaskReminderNotificationTag,
    getTaskReminderPlan,
    hasActiveMobileNotificationFeature,
    isWeeklyReviewReminderEnabled,
    normalizeRepeatReminderMinutes,
    REPEAT_REMINDER_INTERVAL_OPTIONS,
    resolveDueReminders,
} from './schedule-utils';
import type { Project, Task } from './types';

const buildTask = (overrides: Partial<Task>): Task => ({
    id: 'task-1',
    title: 'Reminder',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-03-16T12:00:00.000Z',
    updatedAt: '2026-03-16T12:00:00.000Z',
    ...overrides,
});

const buildProject = (overrides: Partial<Project>): Project => ({
    id: 'project-1',
    title: 'Launch',
    status: 'active',
    color: '#000000',
    order: 0,
    tagIds: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
});

describe('schedule-utils', () => {
    it('skips date-only start reminders', () => {
        const task = buildTask({ startTime: '2026-03-17' });
        const now = new Date(2026, 2, 16, 20, 0, 0, 0);

        const next = getNextScheduledAt(task, now);

        expect(next).toBeNull();
    });

    it('skips date-only due reminders', () => {
        const task = buildTask({ dueDate: '2026-03-17' });
        const now = new Date(2026, 2, 16, 20, 0, 0, 0);

        const next = getNextScheduledAt(task, now);

        expect(next).toBeNull();
    });

    it('keeps explicit start times unchanged', () => {
        const task = buildTask({ startTime: '2026-03-17T14:30:00.000Z' });
        const now = new Date('2026-03-16T12:00:00.000Z');

        const next = getNextScheduledAt(task, now);

        expect(next?.toISOString()).toBe('2026-03-17T14:30:00.000Z');
    });

    it('can ignore start reminders while keeping due reminders', () => {
        const task = buildTask({
            startTime: '2026-03-17T14:30:00.000Z',
            dueDate: '2026-03-18T09:00:00.000Z',
        });
        const now = new Date('2026-03-16T12:00:00.000Z');

        const next = getNextScheduledAt(task, now, { includeStartTime: false });

        expect(next?.toISOString()).toBe('2026-03-18T09:00:00.000Z');
    });

    it('can ignore due reminders while keeping start reminders', () => {
        const task = buildTask({
            startTime: '2026-03-17T14:30:00.000Z',
            dueDate: '2026-03-16T14:00:00.000Z',
        });
        const now = new Date('2026-03-16T12:00:00.000Z');

        const next = getNextScheduledAt(task, now, { includeDueDate: false });

        expect(next?.toISOString()).toBe('2026-03-17T14:30:00.000Z');
    });

    it('suppresses task start and due reminders when calendar handoff is enabled', () => {
        const task = buildTask({
            startTime: '2026-03-17T14:30:00.000Z',
            dueDate: '2026-03-18T09:00:00.000Z',
            suppressMindwtrReminders: true,
        });
        const now = new Date('2026-03-16T12:00:00.000Z');

        const next = getNextScheduledAt(task, now);

        expect(next).toBeNull();
    });

    it('keeps review reminders when task reminders are handed off to calendar', () => {
        const task = buildTask({
            startTime: '2026-03-17T14:30:00.000Z',
            dueDate: '2026-03-18T09:00:00.000Z',
            reviewAt: '2026-03-19T10:00:00.000Z',
            suppressMindwtrReminders: true,
        });
        const now = new Date('2026-03-16T12:00:00.000Z');

        const next = getNextScheduledAt(task, now, { includeReviewAt: true });

        expect(next?.toISOString()).toBe('2026-03-19T10:00:00.000Z');
    });
});

describe('normalizeRepeatReminderMinutes', () => {
    it('accepts the allowed presets', () => {
        for (const n of REPEAT_REMINDER_INTERVAL_OPTIONS) {
            expect(normalizeRepeatReminderMinutes(n)).toBe(n);
        }
    });

    it('rejects non-presets, junk, and falsy values', () => {
        for (const bad of [0, 1, 7, 45, 61, -5, NaN, '10', null, undefined, {}]) {
            expect(normalizeRepeatReminderMinutes(bad)).toBeUndefined();
        }
    });
});

describe('getDueReminderRepeatTimes', () => {
    const dueTask = (overrides: Partial<Task> = {}): Task =>
        buildTask({
            status: 'next',
            dueDate: '2026-06-17T09:00:00.000Z',
            repeatReminderMinutes: 10,
            ...overrides,
        });
    const dueMs = new Date('2026-06-17T09:00:00.000Z').getTime();

    it('returns [] when no repeat interval set', () => {
        expect(getDueReminderRepeatTimes(dueTask({ repeatReminderMinutes: undefined }))).toEqual([]);
    });

    it('returns [] for a date-only due date', () => {
        expect(getDueReminderRepeatTimes(dueTask({ dueDate: '2026-06-17' }))).toEqual([]);
    });

    it('returns [] when reminders are suppressed', () => {
        expect(getDueReminderRepeatTimes(dueTask({ suppressMindwtrReminders: true }))).toEqual([]);
    });

    it('returns [] when due-date notifications are disabled via options', () => {
        expect(getDueReminderRepeatTimes(dueTask(), { includeDueDate: false })).toEqual([]);
    });

    it.each(['done', 'archived', 'reference'] as const)('returns [] for %s tasks', (status) => {
        expect(getDueReminderRepeatTimes(dueTask({ status }))).toEqual([]);
    });

    it('returns [] for soft-deleted tasks', () => {
        expect(getDueReminderRepeatTimes(dueTask({ deletedAt: '2026-06-17T01:00:00.000Z' }))).toEqual([]);
    });

    it('caps by occurrence ceiling for short intervals (5min -> 8 occurrences over 40min)', () => {
        const times = getDueReminderRepeatTimes(dueTask({ repeatReminderMinutes: 5 }));
        expect(times).toHaveLength(8);
        expect(times[0].getTime()).toBe(dueMs + 5 * 60_000); // index 1, not the due moment
        expect(times[7].getTime()).toBe(dueMs + 40 * 60_000);
    });

    it('caps by window for long intervals (60min -> 2 occurrences over 120min)', () => {
        const times = getDueReminderRepeatTimes(dueTask({ repeatReminderMinutes: 60 }));
        expect(times.map((d) => d.getTime() - dueMs)).toEqual([60 * 60_000, 120 * 60_000]);
    });
});

describe('getReminderNotificationTag', () => {
    it('puts a task\'s start, due and every due-time repeat into one notification slot', () => {
        const tag = getTaskReminderNotificationTag('task-1');
        expect(getReminderNotificationTag('task:task-1')).toBe(tag);
        expect(getReminderNotificationTag('task:task-1:r1')).toBe(tag);
        expect(getReminderNotificationTag('task:task-1:r8')).toBe(tag);
        expect(getTaskReminderPlan(buildTask({ dueDate: '2026-06-17T09:00:00.000Z', repeatReminderMinutes: 10 })).repeats
            .every((repeat) => getReminderNotificationTag(repeat.key) === getTaskReminderNotificationTag(repeat.taskId))).toBe(true);
    });

    it('keeps tasks, projects and digests in separate slots', () => {
        const tags = ['task:a', 'task:b', 'project:a', 'digest:morning', 'digest:evening'].map(getReminderNotificationTag);
        expect(new Set(tags).size).toBe(tags.length);
        expect(getReminderNotificationTag('project:p:r1')).toBe('mindwtr-reminder:project:p:r1');
    });
});

describe('reminder intent planning', () => {
    it('returns a typed next intent and stable repeat keys', () => {
        const task = buildTask({
            startTime: '2026-06-17T08:30:00.000Z',
            dueDate: '2026-06-17T09:00:00.000Z',
            reviewAt: '2026-06-18T09:00:00.000Z',
            repeatReminderMinutes: 10,
        });

        const plan = getTaskReminderPlan(
            task,
            new Date('2026-06-17T08:00:00.000Z'),
            { includeReviewAt: true },
        );

        expect(plan.next).toMatchObject({
            key: 'task:task-1',
            taskId: 'task-1',
            kind: 'start',
            scheduledAt: new Date('2026-06-17T08:30:00.000Z'),
        });
        expect(plan.repeats[0]).toMatchObject({
            key: 'task:task-1:r1',
            dedupeKey: '2026-06-17T09:00:00.000Z#1',
            taskId: 'task-1',
            kind: 'due-repeat',
            repeatIndex: 1,
            scheduledAt: new Date('2026-06-17T09:10:00.000Z'),
        });
    });

    it('does not invent a time for date-only project reviews', () => {
        const project: Project = {
            id: 'project-1',
            title: 'Launch',
            status: 'active',
            color: '#000000',
            order: 0,
            tagIds: [],
            reviewAt: '2026-06-18',
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        expect(getProjectReviewReminderIntent(
            project,
            new Date('2026-06-17T08:00:00.000Z'),
        )).toBeNull();
        expect(getProjectReviewReminderIntent(
            { ...project, reviewAt: '2026-06-18T09:00:00.000Z' },
            new Date('2026-06-17T08:00:00.000Z'),
        )).toMatchObject({
            key: 'project:project-1',
            projectId: 'project-1',
            kind: 'project-review',
            scheduledAt: new Date('2026-06-18T09:00:00.000Z'),
        });
    });
});

describe('reminder gating predicates', () => {
    it('gates start/due reminders behind the master switch and their own flag', () => {
        expect(areTaskRemindersEnabled({})).toBe(true);
        expect(areTaskRemindersEnabled({ notificationsEnabled: false })).toBe(false);

        expect(areStartDateRemindersEnabled({})).toBe(true);
        expect(areStartDateRemindersEnabled({ startDateNotificationsEnabled: false })).toBe(false);
        expect(areStartDateRemindersEnabled({ notificationsEnabled: false, startDateNotificationsEnabled: true })).toBe(false);

        expect(areDueDateRemindersEnabled({ dueDateNotificationsEnabled: false })).toBe(false);
        expect(areDueDateRemindersEnabled({ notificationsEnabled: false })).toBe(false);
    });

    it('keeps explicitly enabled digests independent of the task-reminder master switch', () => {
        expect(isWeeklyReviewReminderEnabled({ notificationsEnabled: false, weeklyReviewEnabled: true })).toBe(true);
        expect(hasActiveMobileNotificationFeature({ notificationsEnabled: false, weeklyReviewEnabled: true })).toBe(true);
        expect(hasActiveMobileNotificationFeature({ notificationsEnabled: false, dailyDigestMorningEnabled: true })).toBe(true);
        expect(hasActiveMobileNotificationFeature({ notificationsEnabled: false, dailyDigestEveningEnabled: true })).toBe(true);
        expect(hasActiveMobileNotificationFeature({ notificationsEnabled: false, weeklyReviewEnabled: false })).toBe(false);
    });
});

describe('getDigestSchedule', () => {
    it('reads defaults, explicit config, and clamps an out-of-range weekly review day', () => {
        expect(getDigestSchedule({})).toEqual({
            morning: { enabled: false, hour: 9, minute: 0 },
            evening: { enabled: false, hour: 20, minute: 0 },
            weekly: { enabled: false, day: 0, hour: 18, minute: 0 },
        });

        expect(getDigestSchedule({
            dailyDigestMorningEnabled: true,
            dailyDigestMorningTime: '07:15',
            dailyDigestEveningEnabled: true,
            dailyDigestEveningTime: '21:45',
            weeklyReviewEnabled: true,
            weeklyReviewDay: 9, // out of range, clamps to 6
            weeklyReviewTime: '17:30',
        })).toEqual({
            morning: { enabled: true, hour: 7, minute: 15 },
            evening: { enabled: true, hour: 21, minute: 45 },
            weekly: { enabled: true, day: 6, hour: 17, minute: 30 },
        });

        expect(getDigestSchedule({ weeklyReviewDay: -3 }).weekly.day).toBe(0);
        expect(getDigestSchedule({ weeklyReviewDay: Number.NaN }).weekly.day).toBe(0);
    });
});

describe('buildReminderNotificationBody', () => {
    it('labels the body by kind and strips markdown from the description', () => {
        const task = buildTask({ description: '**Bring** notes' });
        expect(buildReminderNotificationBody(task, 'due', { 'settings.dueDateNotifications': 'Due date reminder' }))
            .toBe('Due date reminder\nBring notes');
    });

    it('falls back to a default English label when the translation key is missing', () => {
        const task = buildTask({ startTime: '2026-03-17T14:30:00.000Z' });
        expect(buildReminderNotificationBody(task, 'start', {})).toBe('Start date reminder');
    });

    it('treats a due-repeat kind the same as due for labelling', () => {
        expect(buildReminderNotificationBody(buildTask({}), 'due-repeat', {})).toBe('Due date reminder');
    });

    it('shows the label alone when there is no description', () => {
        expect(buildReminderNotificationBody(buildTask({}), 'review', {})).toBe('Review date reminder');
    });
});

describe('buildReminderSchedule', () => {
    const translations = {
        'digest.morningTitle': 'Morning',
        'digest.morningBody': 'Morning body',
        'digest.eveningTitle': 'Evening',
        'digest.eveningBody': 'Evening body',
        'digest.weeklyReviewTitle': 'Weekly review',
        'digest.weeklyReviewBody': 'Weekly review body',
        'settings.dueDateNotifications': 'Due date reminder',
        'settings.reviewAtNotifications': 'Review date reminder',
        'review.projectsStep': 'Review project',
    };

    it('schedules the morning/evening digests at local wall-clock time, rolling to tomorrow once today\'s slot has passed', () => {
        const now = new Date();
        now.setHours(12, 0, 0, 0); // fixed local midday, independent of the runner's timezone

        const { requests } = buildReminderSchedule({
            settings: {
                dailyDigestMorningEnabled: true,
                dailyDigestMorningTime: '09:00', // already passed today -> tomorrow
                dailyDigestEveningEnabled: true,
                dailyDigestEveningTime: '20:00', // still ahead today -> today
            },
            tasks: [],
            projects: [],
            now,
            translations,
        });

        const morning = requests.find((request) => request.key === 'digest:morning');
        const evening = requests.find((request) => request.key === 'digest:evening');
        expect(morning).toMatchObject({ title: 'Morning', message: 'Morning body', repeatInterval: 'daily' });
        expect(evening).toMatchObject({ title: 'Evening', message: 'Evening body', repeatInterval: 'daily' });
        expect(morning!.fireAt.getHours()).toBe(9);
        expect(morning!.fireAt.getDate()).not.toBe(now.getDate());
        expect(evening!.fireAt.getHours()).toBe(20);
        expect(evening!.fireAt.getDate()).toBe(now.getDate());
    });

    it.each([
        {
            label: 'morning only',
            settings: { dailyDigestMorningEnabled: true },
            expectedKeys: ['digest:morning'],
        },
        {
            label: 'evening only',
            settings: { dailyDigestEveningEnabled: true },
            expectedKeys: ['digest:evening'],
        },
        {
            label: 'both daily digests',
            settings: { dailyDigestMorningEnabled: true, dailyDigestEveningEnabled: true },
            expectedKeys: ['digest:morning', 'digest:evening'],
        },
        {
            label: 'weekly review only',
            settings: { weeklyReviewEnabled: true },
            expectedKeys: ['digest:weekly-review'],
        },
        {
            label: 'no digest enabled',
            settings: {},
            expectedKeys: [],
        },
    ])('keeps $label active while task reminders are disabled', ({ settings, expectedKeys }) => {
        const { requests, diagnostics } = buildReminderSchedule({
            settings: { notificationsEnabled: false, ...settings },
            tasks: [
                buildTask({ id: 'timed', dueDate: '2026-06-17T10:00:00.000Z' }),
                buildTask({ id: 'date-only', dueDate: '2026-06-18' }),
            ],
            projects: [],
            now: new Date('2026-06-17T08:00:00.000Z'),
            translations,
        });

        expect(diagnostics.taskRemindersEnabled).toBe(false);
        expect(requests.map((request) => request.key)).toEqual(expectedKeys);
        expect(requests.some((request) => request.data.kind === 'task-reminder')).toBe(false);
    });

    it('schedules the weekly review independent of the task-reminder master switch', () => {
        const now = new Date();
        now.setHours(12, 0, 0, 0);
        const targetDay = (now.getDay() + 2) % 7;

        const { requests, diagnostics } = buildReminderSchedule({
            settings: {
                notificationsEnabled: false, // task reminders off entirely
                weeklyReviewEnabled: true,
                weeklyReviewDay: targetDay,
                weeklyReviewTime: '18:00',
            },
            tasks: [],
            projects: [],
            now,
            translations,
        });

        expect(requests).toEqual([expect.objectContaining({
            key: 'digest:weekly-review',
            repeatInterval: 'weekly',
        })]);
        expect(diagnostics.weeklyReviewEnabled).toBe(true);
        expect(diagnostics.taskRemindersEnabled).toBe(false);
    });

    const now = new Date('2026-06-17T08:00:00.000Z');

    it('derives a due reminder and its bounded repeats through the real getTaskReminderPlan seam, with a labelled markdown-stripped body', () => {
        const task = buildTask({
            id: 'task-1',
            title: 'Pay rent',
            description: '**Important**',
            dueDate: '2026-06-17T09:00:00.000Z',
            repeatReminderMinutes: 30,
        });

        const { requests, diagnostics } = buildReminderSchedule({
            settings: {},
            tasks: [task],
            projects: [],
            now,
            translations,
        });

        const due = requests.find((request) => request.key === 'task:task-1');
        expect(due).toMatchObject({
            title: 'Pay rent',
            message: 'Due date reminder\nImportant',
            data: { kind: 'task-reminder', taskId: 'task-1' },
            hasCompleteAction: true,
        });
        expect(due!.fireAt).toEqual(new Date('2026-06-17T09:00:00.000Z'));

        const repeatKeys = requests.filter((request) => request.key.startsWith('task:task-1:r')).map((request) => request.key);
        expect(repeatKeys).toEqual(['task:task-1:r1', 'task:task-1:r2', 'task:task-1:r3', 'task:task-1:r4']);

        expect(diagnostics.taskReminderCount).toBe(1);
        expect(diagnostics.taskReviewReminderCount).toBe(0);
        expect(diagnostics.futureDueDateReminderCount).toBe(1);
    });

    it('picks the review kind and disables the complete action when reviewAt wins the plan', () => {
        const task = buildTask({
            id: 'task-2',
            title: 'Review proposal',
            reviewAt: '2026-06-17T09:00:00.000Z',
        });

        const { requests, diagnostics } = buildReminderSchedule({
            settings: {},
            tasks: [task],
            projects: [],
            now,
            translations,
        });

        const review = requests.find((request) => request.key === 'task:task-2');
        expect(review).toMatchObject({
            message: 'Review date reminder',
            data: { kind: 'task-review', taskId: 'task-2' },
            hasCompleteAction: false,
        });
        expect(diagnostics.taskReviewReminderCount).toBe(1);
        expect(diagnostics.taskReminderCount).toBe(0);
    });

    it('derives project review reminders', () => {
        const project = buildProject({ reviewAt: '2026-06-18T09:00:00.000Z' });
        const { requests, diagnostics } = buildReminderSchedule({
            settings: {},
            tasks: [],
            projects: [project],
            now,
            translations,
        });
        expect(requests).toEqual([
            expect.objectContaining({
                key: 'project:project-1',
                title: 'Launch',
                message: 'Review project',
                data: { kind: 'project-review', projectId: 'project-1' },
            }),
        ]);
        expect(diagnostics.projectReviewReminderCount).toBe(1);
    });

    it('sorts one-shot reminders by fire time and applies the platform cap without ever dropping a digest', () => {
        const tasks = Array.from({ length: 5 }, (_, index) => buildTask({
            id: `task-${index}`,
            title: `Task ${index}`,
            dueDate: new Date(now.getTime() + (5 - index) * 60_000).toISOString(), // reverse order on purpose
        }));

        const { requests } = buildReminderSchedule({
            settings: { weeklyReviewEnabled: true, weeklyReviewDay: 0 },
            tasks,
            projects: [],
            now,
            translations,
            maxOneShotReminders: 2,
        });

        expect(requests.some((request) => request.key === 'digest:weekly-review')).toBe(true);
        const taskRequests = requests.filter((request) => request.data.taskId);
        expect(taskRequests).toHaveLength(2);
        // earliest fire times survive the cap, in fire-time order
        expect(taskRequests.map((request) => request.data.taskId)).toEqual(['task-4', 'task-3']);
    });

    it('keeps diagnostics counts in lockstep with the requests they describe, so they cannot drift', () => {
        const tasks = [
            buildTask({ id: 'due-task', dueDate: '2026-06-17T09:00:00.000Z' }),
            buildTask({ id: 'review-task', reviewAt: '2026-06-17T09:30:00.000Z' }),
            buildTask({ id: 'inactive-task', status: 'done', dueDate: '2026-06-17T09:00:00.000Z' }),
        ];
        const projects = [buildProject({ id: 'project-a', reviewAt: '2026-06-17T10:00:00.000Z' })];

        const { requests, diagnostics } = buildReminderSchedule({
            settings: {},
            tasks,
            projects,
            now,
            translations,
        });

        const taskReminderRequests = requests.filter((request) => request.data.kind === 'task-reminder' && request.data.taskId);
        const taskReviewRequests = requests.filter((request) => request.data.kind === 'task-review');
        const projectReviewRequests = requests.filter((request) => request.data.kind === 'project-review');

        expect(taskReminderRequests).toHaveLength(diagnostics.taskReminderCount);
        expect(taskReviewRequests).toHaveLength(diagnostics.taskReviewReminderCount);
        expect(projectReviewRequests).toHaveLength(diagnostics.projectReviewReminderCount);
    });

    // Pins mobile's existing call site (notification-service-local.ts: bare buildReminderSchedule,
    // no window) against a multi-kind input, so a future change to this file cannot silently shift
    // what mobile arms. If this ever needs updating, mobile's alarm scheduling changed too.
    it('is a stable pin for mobile\'s unwindowed call site across digest, task, repeat, and project-review kinds', () => {
        const task = buildTask({
            id: 'task-1',
            title: 'Pay rent',
            dueDate: '2026-06-17T09:00:00.000Z',
            repeatReminderMinutes: 30,
        });
        const project = buildProject({ id: 'project-1', reviewAt: '2026-06-18T09:00:00.000Z' });

        const { requests } = buildReminderSchedule({
            settings: {
                dailyDigestMorningEnabled: true,
                dailyDigestMorningTime: '09:00',
                weeklyReviewEnabled: true,
                weeklyReviewDay: 5,
                weeklyReviewTime: '18:00',
            },
            tasks: [task],
            projects: [project],
            now,
            translations,
            maxOneShotReminders: 60,
        });

        expect(requests.map((request) => request.key)).toEqual([
            'digest:morning',
            'digest:weekly-review',
            'task:task-1',
            'task:task-1:r1',
            'task:task-1:r2',
            'task:task-1:r3',
            'task:task-1:r4',
            'project:project-1',
        ]);
    });
});

describe('resolveDueReminders', () => {
    const translations = {
        'settings.dueDateNotifications': 'Due date reminder',
        'review.projectsStep': 'Review project',
    };

    it('anchors the schedule at window.from so a reminder due while the app was asleep is still caught, then bounds it by window.to', () => {
        const task = buildTask({ id: 'task-1', dueDate: '2026-06-17T09:00:00.000Z' });
        // Poll ran 4 minutes late (now=09:04:00); window.to = now + one poll interval.

        const caught = resolveDueReminders(
            { settings: {}, tasks: [task], projects: [], translations },
            { from: new Date('2026-06-17T08:59:00.000Z'), to: new Date('2026-06-17T09:04:15.000Z') },
        );
        expect(caught.map((request) => request.key)).toEqual(['task:task-1']);

        // A window whose "from" is already past the due time means an earlier poll would have
        // caught it already -- this cycle must not resend it.
        const alreadyPast = resolveDueReminders(
            { settings: {}, tasks: [task], projects: [], translations },
            { from: new Date('2026-06-17T09:01:00.000Z'), to: new Date('2026-06-17T09:04:15.000Z') },
        );
        expect(alreadyPast).toEqual([]);
    });

    it('excludes due-time repeat occurrences -- desktop resolves which one fires via its own resolveDueRepeatToFire', () => {
        const task = buildTask({
            id: 'task-1',
            dueDate: '2026-06-17T09:00:00.000Z',
            repeatReminderMinutes: 10,
        });
        // The due+20min repeat (index 2) would be the only entry buildReminderSchedule has for
        // this task in this window -- the base "next" reminder is long past window.from.
        const due = resolveDueReminders(
            { settings: {}, tasks: [task], projects: [], translations },
            { from: new Date('2026-06-17T09:19:50.000Z'), to: new Date('2026-06-17T09:20:20.000Z') },
        );
        expect(due).toEqual([]);
    });

    it('excludes digest/weekly-review entries -- a polling platform tracks those on its own per-day cadence', () => {
        const now = new Date();
        now.setHours(9, 0, 5, 0); // just past the default 09:00 morning digest slot
        const due = resolveDueReminders(
            {
                settings: { dailyDigestMorningEnabled: true, weeklyReviewEnabled: true },
                tasks: [],
                projects: [],
                translations,
            },
            { from: new Date(now.getTime() - 15_000), to: new Date(now.getTime() + 15_000) },
        );
        expect(due).toEqual([]);
    });

    it('includes project review reminders within the window', () => {
        const project = buildProject({ reviewAt: '2026-06-18T09:00:00.000Z' });
        const now = new Date('2026-06-18T08:59:50.000Z');

        const due = resolveDueReminders(
            { settings: {}, tasks: [], projects: [project], translations },
            { from: new Date(now.getTime() - 15_000), to: new Date(now.getTime() + 15_000) },
        );
        expect(due).toEqual([expect.objectContaining({ key: 'project:project-1' })]);
    });
});
