import { pickSandboxDisplaySettings } from './sandbox';
import { getSandboxContent, type SandboxContent } from './sandbox-data-locales';
import { normalizeTaskForLoad } from './task-status';
import { buildNewProject } from './store-projects/project-actions';
import type {
    AppData,
    AppSettings,
    Area,
    Person,
    Project,
    Section,
    Task,
} from './types';

export type CreateSandboxDataOptions = {
    now?: Date;
    settings?: AppSettings;
};

const SANDBOX_REV_BY = 'sandbox-sample';

const AREA = {
    community: 'sandbox-area-community',
    home: 'sandbox-area-home',
    learning: 'sandbox-area-learning',
    wellbeing: 'sandbox-area-wellbeing',
} as const;

const PROJECT = {
    garden: 'sandbox-project-garden',
    kitchen: 'sandbox-project-kitchen',
    reading: 'sandbox-project-reading',
    picnic: 'sandbox-project-picnic',
    maintenance: 'sandbox-project-maintenance',
    studio: 'sandbox-project-studio',
    donation: 'sandbox-project-donation',
    pottery: 'sandbox-project-pottery',
} as const;

const SECTION = {
    gardenPlan: 'sandbox-section-garden-plan',
    gardenSupplies: 'sandbox-section-garden-supplies',
    gardenWorkdays: 'sandbox-section-garden-workdays',
    gardenIdeas: 'sandbox-section-garden-ideas',
    kitchenResearch: 'sandbox-section-kitchen-research',
    kitchenBuy: 'sandbox-section-kitchen-buy',
    kitchenInstall: 'sandbox-section-kitchen-install',
    kitchenAfter: 'sandbox-section-kitchen-after',
    readingCurrent: 'sandbox-section-reading-current',
    readingReviews: 'sandbox-section-reading-reviews',
    readingWishlist: 'sandbox-section-reading-wishlist',
    maintenanceMonthly: 'sandbox-section-maintenance-monthly',
    maintenanceSeasonal: 'sandbox-section-maintenance-seasonal',
    picnicVenue: 'sandbox-section-picnic-venue',
    picnicFood: 'sandbox-section-picnic-food',
} as const;

const addUtcDays = (date: Date, days: number): Date => {
    const result = new Date(date.getTime());
    result.setUTCDate(result.getUTCDate() + days);
    return result;
};

const atUtcTime = (date: Date, days: number, hours: number, minutes = 0): string => {
    const result = addUtcDays(date, days);
    result.setUTCHours(hours, minutes, 0, 0);
    return result.toISOString();
};

const utcDateOnly = (date: Date, days: number): string => addUtcDays(date, days).toISOString().slice(0, 10);

const nextUtcWeekday = (date: Date, weekdays: readonly number[]): string => {
    for (let offset = 1; offset <= 7; offset += 1) {
        const candidate = addUtcDays(date, offset);
        if (weekdays.includes(candidate.getUTCDay())) return candidate.toISOString().slice(0, 10);
    }
    throw new Error('Sandbox weekday fixture requires at least one weekday.');
};

const utcMonthDay = (date: Date, day: number, direction: 'previous' | 'next'): string => {
    const currentDayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    let year = date.getUTCFullYear();
    let month = date.getUTCMonth();
    let candidate = Date.UTC(year, month, day);
    if (direction === 'previous' ? candidate >= currentDayStart : candidate <= currentDayStart) {
        month += direction === 'previous' ? -1 : 1;
        const shifted = new Date(Date.UTC(year, month, 1));
        year = shifted.getUTCFullYear();
        month = shifted.getUTCMonth();
        candidate = Date.UTC(year, month, day);
    }
    return new Date(candidate).toISOString().slice(0, 10);
};

const atUtcDateOnlyTime = (dateOnly: string, hours: number): string =>
    `${dateOnly}T${String(hours).padStart(2, '0')}:00:00.000Z`;

const createAreas = (createdAt: string, content: SandboxContent): Area[] => [
    { id: AREA.community, name: content.areas.community, color: '#4F8A5B', icon: '🌱', order: 0, rev: 1, revBy: SANDBOX_REV_BY, createdAt, updatedAt: createdAt },
    { id: AREA.home, name: content.areas.home, color: '#C77845', icon: '🏠', order: 1, rev: 1, revBy: SANDBOX_REV_BY, createdAt, updatedAt: createdAt },
    { id: AREA.learning, name: content.areas.learning, color: '#6677CC', icon: '📚', order: 2, rev: 1, revBy: SANDBOX_REV_BY, createdAt, updatedAt: createdAt },
    { id: AREA.wellbeing, name: content.areas.wellbeing, color: '#8A6FB5', icon: '☀️', order: 3, rev: 1, revBy: SANDBOX_REV_BY, createdAt, updatedAt: createdAt },
];

const createProjects = (
    now: Date,
    settings: AppSettings,
    areas: Area[],
    content: SandboxContent,
): Project[] => {
    const createdAt = atUtcTime(now, -60, 9);
    const projects: Project[] = [];
    const add = (
        id: string,
        title: string,
        color: string,
        initialProps: Partial<Project>,
    ) => {
        projects.push(buildNewProject({
            id,
            title,
            color,
            initialProps,
            existingProjects: projects,
            existingAreas: areas,
            settings,
            deviceId: SANDBOX_REV_BY,
            now: createdAt,
        }));
    };

    add(PROJECT.garden, content.projects.garden, '#4F8A5B', {
        areaId: AREA.community,
        order: 0,
        isFocused: true,
        isSequential: false,
        status: 'active',
        startDate: utcDateOnly(now, -14),
        dueDate: utcDateOnly(now, 45),
        reviewAt: atUtcTime(now, 4, 9),
        supportNotes: content.text.gardenProjectNote,
        tagIds: [content.tags.garden, content.tags.community],
    });
    add(PROJECT.kitchen, content.projects.kitchen, '#C77845', {
        areaId: AREA.home,
        order: 0,
        isFocused: true,
        isSequential: true,
        sequentialScope: 'project',
        status: 'active',
        startDate: utcDateOnly(now, -3),
        dueDate: utcDateOnly(now, 21),
        supportNotes: content.text.kitchenProjectNote,
        tagIds: [content.tags.home],
    });
    add(PROJECT.reading, content.projects.reading, '#6677CC', {
        areaId: AREA.learning,
        order: 0,
        isSequential: true,
        sequentialScope: 'section',
        status: 'active',
        taskSortBy: 'due',
        tagIds: [content.tags.reading],
    });
    add(PROJECT.picnic, content.projects.picnic, '#D69B3A', {
        areaId: AREA.community,
        order: 1,
        isSequential: false,
        status: 'waiting',
        dueDate: utcDateOnly(now, 18),
        reviewAt: atUtcTime(now, 2, 10),
        tagIds: [content.tags.community, content.tags.event],
    });
    add(PROJECT.maintenance, content.projects.maintenance, '#8C6A4A', {
        areaId: AREA.home,
        order: 1,
        isSequential: false,
        status: 'active',
        tagIds: [content.tags.maintenance],
    });
    add(PROJECT.studio, content.projects.studio, '#8A6FB5', {
        areaId: AREA.home,
        order: 2,
        isSequential: false,
        status: 'someday',
        tagIds: [content.tags.someday],
    });
    add(PROJECT.donation, content.projects.donation, '#3F7C85', {
        areaId: AREA.community,
        order: 2,
        isSequential: false,
        status: 'archived',
        tagIds: [content.tags.community],
        updatedAt: atUtcTime(now, -20, 16),
    });
    add(PROJECT.pottery, content.projects.pottery, '#A16E83', {
        areaId: AREA.wellbeing,
        order: 0,
        isSequential: false,
        status: 'archived',
        cancelledAt: atUtcTime(now, -12, 11),
        tagIds: [content.tags.creative],
    });

    return projects;
};

const createSections = (createdAt: string, content: SandboxContent): Section[] => {
    const make = (
        id: string,
        projectId: string,
        title: string,
        order: number,
        description?: string,
        isCollapsed = false,
    ): Section => ({
        id,
        projectId,
        title,
        order,
        description,
        isCollapsed,
        rev: 1,
        revBy: SANDBOX_REV_BY,
        createdAt,
        updatedAt: createdAt,
    });

    return [
        make(SECTION.gardenPlan, PROJECT.garden, content.sections.gardenPlan, 0, content.text.gardenPlanDescription),
        make(SECTION.gardenSupplies, PROJECT.garden, content.sections.gardenSupplies, 1),
        make(SECTION.gardenWorkdays, PROJECT.garden, content.sections.gardenWorkdays, 2),
        make(SECTION.gardenIdeas, PROJECT.garden, content.sections.gardenIdeas, 3, content.text.emptySectionDescription),
        make(SECTION.kitchenResearch, PROJECT.kitchen, content.sections.kitchenResearch, 0),
        make(SECTION.kitchenBuy, PROJECT.kitchen, content.sections.kitchenBuy, 1),
        make(SECTION.kitchenInstall, PROJECT.kitchen, content.sections.kitchenInstall, 2),
        make(SECTION.kitchenAfter, PROJECT.kitchen, content.sections.kitchenAfter, 3, content.text.emptySectionDescription),
        make(SECTION.readingCurrent, PROJECT.reading, content.sections.readingCurrent, 0),
        make(SECTION.readingReviews, PROJECT.reading, content.sections.readingReviews, 1),
        make(SECTION.readingWishlist, PROJECT.reading, content.sections.readingWishlist, 2, content.text.emptySectionDescription, true),
        make(SECTION.maintenanceMonthly, PROJECT.maintenance, content.sections.maintenanceMonthly, 0),
        make(SECTION.maintenanceSeasonal, PROJECT.maintenance, content.sections.maintenanceSeasonal, 1),
        make(SECTION.picnicVenue, PROJECT.picnic, content.sections.picnicVenue, 0),
        make(SECTION.picnicFood, PROJECT.picnic, content.sections.picnicFood, 1),
    ];
};

const createPeople = (createdAt: string, content: SandboxContent): Person[] => [
    { id: 'sandbox-person-alex', name: content.people.alex, note: content.personNotes.alex, referenceLink: 'https://example.com/sandbox/community-center', rev: 1, revBy: SANDBOX_REV_BY, createdAt, updatedAt: createdAt },
    { id: 'sandbox-person-jordan', name: content.people.jordan, note: content.personNotes.jordan, rev: 1, revBy: SANDBOX_REV_BY, createdAt, updatedAt: createdAt },
    { id: 'sandbox-person-priya', name: content.people.priya, note: content.personNotes.priya, rev: 1, revBy: SANDBOX_REV_BY, createdAt, updatedAt: createdAt },
    { id: 'sandbox-person-mateo', name: content.people.mateo, note: content.personNotes.mateo, rev: 1, revBy: SANDBOX_REV_BY, createdAt, updatedAt: createdAt },
];

type TaskSeed = Pick<Task, 'id' | 'title' | 'status'>
    & Partial<Omit<Task, 'id' | 'title' | 'status' | 'createdAt' | 'updatedAt'>>
    & { createdAt?: string; updatedAt?: string };

const createTasks = (now: Date, content: SandboxContent): Task[] => {
    const nowIso = now.toISOString();
    const projectOrders = new Map<string, number>();
    const makeTask = (seed: TaskSeed, index: number): Task => {
        const nextProjectOrder = seed.projectId ? (projectOrders.get(seed.projectId) ?? 0) : undefined;
        if (seed.projectId) projectOrders.set(seed.projectId, (nextProjectOrder ?? 0) + 1);
        const order = seed.order ?? nextProjectOrder;
        const raw: Task = {
            ...seed,
            tags: [...(seed.tags ?? [])],
            contexts: [...(seed.contexts ?? [])],
            taskMode: seed.taskMode ?? 'task',
            checklist: seed.checklist?.map((item) => ({ ...item })),
            attachments: seed.attachments?.map((attachment) => ({ ...attachment })),
            recurrence: typeof seed.recurrence === 'object'
                ? {
                    ...seed.recurrence,
                    byDay: seed.recurrence.byDay ? [...seed.recurrence.byDay] : undefined,
                    byMonthDay: seed.recurrence.byMonthDay ? [...seed.recurrence.byMonthDay] : undefined,
                }
                : seed.recurrence,
            relativeStartOffset: seed.relativeStartOffset ? { ...seed.relativeStartOffset } : undefined,
            viewSectionIds: seed.viewSectionIds ? { ...seed.viewSectionIds } : undefined,
            pushCount: seed.pushCount ?? 0,
            isFocusedToday: seed.isFocusedToday ?? false,
            suppressMindwtrReminders: seed.suppressMindwtrReminders ?? false,
            rev: seed.rev ?? 1,
            revBy: seed.revBy ?? SANDBOX_REV_BY,
            createdAt: seed.createdAt ?? atUtcTime(now, -50 + (index % 30), 9),
            updatedAt: seed.updatedAt ?? atUtcTime(now, -(index % 7), 10),
            order,
            orderNum: order,
        };
        return normalizeTaskForLoad(raw, nowIso);
    };

    const archivedProjectAt = atUtcTime(now, -20, 16);
    const deletedAt = atUtcTime(now, -6, 13);
    const linkedSeriesId = 'sandbox-series-reading-review';
    const previousReadingReviewDate = utcMonthDay(now, 15, 'previous');
    const nextReadingReviewDate = utcMonthDay(now, 15, 'next');
    const seeds: TaskSeed[] = [
        // Inbox, loose actions, lifecycle examples, and reference material.
        { id: 'sandbox-task-inbox-measurements', title: content.tasks.inboxMeasurements, status: 'inbox', contexts: [content.contexts.home], tags: [content.tags.capture] },
        { id: 'sandbox-task-inbox-seed-trays', title: content.tasks.inboxSeedTrays, status: 'inbox', contexts: [content.contexts.errands], tags: [content.tags.garden] },
        { id: 'sandbox-task-inbox-notes', title: content.tasks.inboxNotes, status: 'inbox', contexts: [content.contexts.computer] },
        { id: 'sandbox-task-someday-home-screen', title: content.tasks.somedayHomeScreen, status: 'someday', areaId: AREA.home, tags: [content.tags.someday], energyLevel: 'low', timeEstimate: '30min' },
        {
            id: 'sandbox-task-reference-raised-beds',
            title: content.tasks.referenceRaisedBeds,
            status: 'reference',
            areaId: AREA.community,
            tags: [content.tags.garden, content.tags.reference],
            description: content.text.gardenReference,
            attachments: [{
                id: 'sandbox-attachment-raised-bed-guide',
                kind: 'link',
                title: content.text.attachmentGuide,
                uri: 'https://example.com/sandbox/raised-bed-guide',
                createdAt: atUtcTime(now, -24, 9),
                updatedAt: atUtcTime(now, -24, 9),
            }],
        },
        { id: 'sandbox-task-done-label-bins', title: content.tasks.doneLabelBins, status: 'done', areaId: AREA.home, tags: [content.tags.home], completedAt: atUtcTime(now, -5, 15) },
        { id: 'sandbox-task-archived-paint', title: content.tasks.archivedPaint, status: 'archived', areaId: AREA.home, tags: [content.tags.home], completedAt: atUtcTime(now, -32, 12) },
        { id: 'sandbox-task-cancelled-tool-library', title: content.tasks.cancelledToolLibrary, status: 'archived', areaId: AREA.home, cancelledAt: atUtcTime(now, -9, 14), tags: [content.tags.cancelled] },
        { id: 'sandbox-task-deleted-batteries', title: content.tasks.deletedBatteries, status: 'next', areaId: AREA.home, deletedAt, updatedAt: deletedAt, contexts: [content.contexts.errands] },
        { id: 'sandbox-task-focus-room', title: content.tasks.focusRoom, status: 'next', areaId: AREA.community, priority: 'urgent', energyLevel: 'medium', timeEstimate: '10min', isFocusedToday: true, focusOrder: 0, contexts: [content.contexts.phone], dueDate: utcDateOnly(now, 1) },

        // Spring Community Garden — a parallel project with several sections.
        { id: 'sandbox-task-garden-map', title: content.tasks.gardenMap, status: 'done', projectId: PROJECT.garden, sectionId: SECTION.gardenPlan, tags: [content.tags.garden], completedAt: atUtcTime(now, -8, 17) },
        { id: 'sandbox-task-garden-water-access', title: content.tasks.gardenWaterAccess, status: 'waiting', projectId: PROJECT.garden, sectionId: SECTION.gardenPlan, assignedTo: content.people.alex, contexts: [content.contexts.phone], tags: [content.tags.garden], reviewAt: atUtcTime(now, 2, 9), priority: 'high' },
        { id: 'sandbox-task-garden-lumber', title: content.tasks.gardenLumber, status: 'next', projectId: PROJECT.garden, sectionId: SECTION.gardenSupplies, contexts: [content.contexts.computer], tags: [content.tags.garden], priority: 'high', energyLevel: 'medium', timeEstimate: '30min', isFocusedToday: true, focusOrder: 1 },
        { id: 'sandbox-task-garden-compost', title: content.tasks.gardenCompost, status: 'next', projectId: PROJECT.garden, sectionId: SECTION.gardenSupplies, contexts: [content.contexts.errands], tags: [content.tags.garden], priority: 'medium', energyLevel: 'high', timeEstimate: '1hr', dueDate: utcDateOnly(now, 4) },
        { id: 'sandbox-task-garden-water-seedlings', title: content.tasks.gardenWaterSeedlings, status: 'next', projectId: PROJECT.garden, sectionId: SECTION.gardenWorkdays, contexts: [content.contexts.home], tags: [content.tags.garden, content.tags.routine], priority: 'low', energyLevel: 'low', timeEstimate: '5min', dueDate: atUtcTime(now, 0, 18), recurrence: { rule: 'daily', strategy: 'strict', seriesId: 'sandbox-series-seed-water', rrule: 'FREQ=DAILY' }, showFutureRecurrence: true },
        { id: 'sandbox-task-garden-workday', title: content.tasks.gardenWorkday, status: 'next', projectId: PROJECT.garden, sectionId: SECTION.gardenWorkdays, assignedTo: content.people.jordan, contexts: [content.contexts.garden], tags: [content.tags.garden, content.tags.community], priority: 'urgent', energyLevel: 'high', timeEstimate: '3hr', startTime: atUtcTime(now, 6, 9), dueDate: atUtcTime(now, 6, 12), location: content.text.gardenLocation },
        {
            id: 'sandbox-task-garden-signs',
            title: content.tasks.gardenSigns,
            status: 'next',
            projectId: PROJECT.garden,
            sectionId: SECTION.gardenWorkdays,
            contexts: [content.contexts.computer],
            tags: [content.tags.garden],
            taskMode: 'list',
            textDirection: 'auto',
            checklist: [
                { id: 'sandbox-check-sign-copy', title: content.checklist.signCopy, isCompleted: true },
                { id: 'sandbox-check-sign-translate', title: content.checklist.signTranslate, isCompleted: false },
                { id: 'sandbox-check-sign-print', title: content.checklist.signPrint, isCompleted: false },
            ],
        },
        { id: 'sandbox-task-garden-harvest-ideas', title: content.tasks.gardenHarvestIdeas, status: 'someday', projectId: PROJECT.garden, tags: [content.tags.garden, content.tags.someday] },
        { id: 'sandbox-task-garden-budget', title: content.tasks.gardenBudget, status: 'waiting', projectId: PROJECT.garden, sectionId: SECTION.gardenPlan, assignedTo: content.people.jordan, tags: [content.tags.garden], reviewAt: utcDateOnly(now, 5) },
        { id: 'sandbox-task-garden-decisions', title: content.tasks.gardenDecisions, status: 'reference', projectId: PROJECT.garden, tags: [content.tags.garden, content.tags.reference], description: content.text.gardenDecisions },

        // Kitchen refresh — order demonstrates project-wide sequential flow.
        { id: 'sandbox-task-kitchen-measure', title: content.tasks.kitchenMeasure, status: 'done', projectId: PROJECT.kitchen, sectionId: SECTION.kitchenResearch, tags: [content.tags.home], completedAt: atUtcTime(now, -3, 18), timeSpentMinutes: 22 },
        { id: 'sandbox-task-kitchen-faucet', title: content.tasks.kitchenFaucet, status: 'next', projectId: PROJECT.kitchen, sectionId: SECTION.kitchenResearch, contexts: [content.contexts.computer], tags: [content.tags.home], priority: 'high', energyLevel: 'medium', timeEstimate: '30min', isFocusedToday: true, focusOrder: 2 },
        { id: 'sandbox-task-kitchen-quote', title: content.tasks.kitchenQuote, status: 'waiting', projectId: PROJECT.kitchen, sectionId: SECTION.kitchenBuy, assignedTo: content.people.priya, contexts: [content.contexts.phone], tags: [content.tags.home], reviewAt: atUtcTime(now, 3, 9) },
        { id: 'sandbox-task-kitchen-liners', title: content.tasks.kitchenLiners, status: 'next', projectId: PROJECT.kitchen, sectionId: SECTION.kitchenBuy, contexts: [content.contexts.computer], tags: [content.tags.home], priority: 'low', energyLevel: 'low', timeEstimate: '15min', startTime: utcDateOnly(now, 5), dueDate: utcDateOnly(now, 8), relativeStartOffset: { amount: -3, unit: 'day' } },
        { id: 'sandbox-task-kitchen-install', title: content.tasks.kitchenInstall, status: 'next', projectId: PROJECT.kitchen, sectionId: SECTION.kitchenInstall, tags: [content.tags.home], priority: 'urgent', energyLevel: 'high', timeEstimate: '2hr', dueDate: utcDateOnly(now, 14) },
        { id: 'sandbox-task-kitchen-wipe', title: content.tasks.kitchenWipe, status: 'next', projectId: PROJECT.kitchen, sectionId: SECTION.kitchenInstall, tags: [content.tags.home], energyLevel: 'medium', timeEstimate: 'custom:75' },

        // Reading — recurring examples include a linked completed occurrence.
        { id: 'sandbox-task-reading-chapter', title: content.tasks.readingChapter, status: 'next', projectId: PROJECT.reading, sectionId: SECTION.readingCurrent, contexts: [content.contexts.reading], tags: [content.tags.reading], priority: 'medium', energyLevel: 'medium', timeEstimate: '1hr', isFocusedToday: true, focusOrder: 3, dueDate: utcDateOnly(now, 2) },
        { id: 'sandbox-task-reading-session', title: content.tasks.readingSession, status: 'next', projectId: PROJECT.reading, sectionId: SECTION.readingCurrent, contexts: [content.contexts.library], tags: [content.tags.reading, content.tags.routine], timeEstimate: '30min', dueDate: nextUtcWeekday(now, [2, 6]), recurrence: { rule: 'weekly', strategy: 'strict', seriesId: 'sandbox-series-reading-session', byDay: ['TU', 'SA'], weekStart: 'MO', rrule: 'FREQ=WEEKLY;BYDAY=TU,SA;WKST=MO' } },
        { id: 'sandbox-task-reading-review-previous', title: content.tasks.readingReviewPrevious, status: 'done', projectId: PROJECT.reading, sectionId: SECTION.readingReviews, tags: [content.tags.reading, content.tags.review], completedAt: atUtcDateOnlyTime(previousReadingReviewDate, 19), dueDate: previousReadingReviewDate, recurrence: { rule: 'monthly', strategy: 'strict', seriesId: linkedSeriesId, byMonthDay: [15], count: 6, completedOccurrences: 0, rrule: 'FREQ=MONTHLY;BYMONTHDAY=15;COUNT=6' } },
        { id: 'sandbox-task-reading-review-next', title: content.tasks.readingReviewNext, status: 'next', projectId: PROJECT.reading, sectionId: SECTION.readingReviews, tags: [content.tags.reading, content.tags.review], dueDate: nextReadingReviewDate, recurrence: { rule: 'monthly', strategy: 'strict', seriesId: linkedSeriesId, byMonthDay: [15], count: 6, completedOccurrences: 1, rrule: 'FREQ=MONTHLY;BYMONTHDAY=15;COUNT=6' } },
        { id: 'sandbox-task-library-renewal', title: content.tasks.libraryRenewal, status: 'next', projectId: PROJECT.reading, sectionId: SECTION.readingReviews, contexts: [content.contexts.errands], tags: [content.tags.reading], dueDate: utcDateOnly(now, 120), recurrence: { rule: 'yearly', strategy: 'strict', seriesId: 'sandbox-series-library-card', rrule: 'FREQ=YEARLY' }, showFutureRecurrence: true },
        { id: 'sandbox-task-reading-takeaway', title: content.tasks.readingTakeaway, status: 'next', projectId: PROJECT.reading, sectionId: SECTION.readingCurrent, contexts: [content.contexts.computer], tags: [content.tags.reading], energyLevel: 'high', timeEstimate: '30min' },
        { id: 'sandbox-task-reading-next-book', title: content.tasks.readingNextBook, status: 'someday', projectId: PROJECT.reading, tags: [content.tags.reading, content.tags.someday] },

        // Home maintenance — strict and after-completion schedules coexist.
        { id: 'sandbox-task-maintenance-smoke', title: content.tasks.maintenanceSmoke, status: 'next', projectId: PROJECT.maintenance, sectionId: SECTION.maintenanceMonthly, contexts: [content.contexts.home], tags: [content.tags.maintenance], priority: 'high', energyLevel: 'low', timeEstimate: '15min', dueDate: utcDateOnly(now, -2) },
        { id: 'sandbox-task-maintenance-fridge', title: content.tasks.maintenanceFridge, status: 'next', projectId: PROJECT.maintenance, sectionId: SECTION.maintenanceMonthly, contexts: [content.contexts.home], tags: [content.tags.maintenance, content.tags.routine], energyLevel: 'medium', timeEstimate: '1hr', dueDate: utcDateOnly(now, 7), recurrence: { rule: 'monthly', strategy: 'fluid', seriesId: 'sandbox-series-fridge', rrule: 'FREQ=MONTHLY' } },
        { id: 'sandbox-task-maintenance-filter', title: content.tasks.maintenanceFilter, status: 'next', projectId: PROJECT.maintenance, sectionId: SECTION.maintenanceSeasonal, contexts: [content.contexts.home], tags: [content.tags.maintenance], priority: 'medium', energyLevel: 'low', timeEstimate: '10min', startTime: utcDateOnly(now, 10), dueDate: utcDateOnly(now, 13) },
        { id: 'sandbox-task-maintenance-rail', title: content.tasks.maintenanceRail, status: 'next', projectId: PROJECT.maintenance, sectionId: SECTION.maintenanceSeasonal, contexts: [content.contexts.home], tags: [content.tags.maintenance], priority: 'high', energyLevel: 'high', timeEstimate: '2hr', dueDate: atUtcTime(now, 9, 16), repeatReminderMinutes: 30 },
        { id: 'sandbox-task-maintenance-models', title: content.tasks.maintenanceModels, status: 'reference', projectId: PROJECT.maintenance, tags: [content.tags.maintenance, content.tags.reference], description: content.text.maintenanceModels },

        // Neighborhood picnic — Waiting For and checklists are visible together.
        { id: 'sandbox-task-picnic-shelter', title: content.tasks.picnicShelter, status: 'waiting', projectId: PROJECT.picnic, sectionId: SECTION.picnicVenue, assignedTo: content.people.alex, contexts: [content.contexts.phone], tags: [content.tags.event], reviewAt: atUtcTime(now, 1, 10), priority: 'urgent' },
        { id: 'sandbox-task-picnic-menu', title: content.tasks.picnicMenu, status: 'next', projectId: PROJECT.picnic, sectionId: SECTION.picnicFood, contexts: [content.contexts.computer], tags: [content.tags.event], energyLevel: 'medium', timeEstimate: '30min', dueDate: utcDateOnly(now, 6) },
        { id: 'sandbox-task-picnic-allergies', title: content.tasks.picnicAllergies, status: 'waiting', projectId: PROJECT.picnic, sectionId: SECTION.picnicFood, assignedTo: content.people.mateo, tags: [content.tags.event], reviewAt: utcDateOnly(now, 4) },
        { id: 'sandbox-task-picnic-plates', title: content.tasks.picnicPlates, status: 'next', projectId: PROJECT.picnic, sectionId: SECTION.picnicFood, contexts: [content.contexts.home], tags: [content.tags.event], taskMode: 'list', checklist: [{ id: 'sandbox-check-plates', title: content.checklist.plates, isCompleted: true }, { id: 'sandbox-check-tools', title: content.checklist.tools, isCompleted: false }, { id: 'sandbox-check-cloths', title: content.checklist.cloths, isCompleted: false }] },
        { id: 'sandbox-task-picnic-weather', title: content.tasks.picnicWeather, status: 'next', projectId: PROJECT.picnic, sectionId: SECTION.picnicVenue, contexts: [content.contexts.computer], tags: [content.tags.event], priority: 'high', timeEstimate: '10min', startTime: atUtcTime(now, 12, 8), dueDate: atUtcTime(now, 12, 9) },

        // Someday and archived project examples.
        { id: 'sandbox-task-studio-lamps', title: content.tasks.studioLamps, status: 'someday', projectId: PROJECT.studio, contexts: [content.contexts.computer], tags: [content.tags.creative, content.tags.someday] },
        { id: 'sandbox-task-studio-desk', title: content.tasks.studioDesk, status: 'someday', projectId: PROJECT.studio, tags: [content.tags.creative, content.tags.someday], description: content.text.studioDesk },
        { id: 'sandbox-task-donation-wrap', title: content.tasks.donationWrap, status: 'done', projectId: PROJECT.donation, tags: [content.tags.community], completedAt: archivedProjectAt, projectArchivedAt: archivedProjectAt, statusBeforeProjectArchive: 'next', completedAtBeforeProjectArchive: null, isFocusedTodayBeforeProjectArchive: false },
    ];

    return seeds.map(makeTask);
};

/** Build a disposable fictional workspace without copying personal entities or settings. */
export function createSandboxData(options: CreateSandboxDataOptions = {}): AppData {
    const suppliedNow = options.now;
    const now = suppliedNow && Number.isFinite(suppliedNow.getTime())
        ? new Date(suppliedNow.getTime())
        : new Date();
    const displaySettings = pickSandboxDisplaySettings(options.settings ?? {});
    const content = getSandboxContent(options.settings?.language ?? displaySettings.language);
    const settings: AppSettings = {
        ...displaySettings,
        features: {
            priorities: true,
            timeEstimates: true,
            pomodoro: true,
            timeline: true,
        },
        gtd: {
            focusTaskLimit: 5,
            focusGroupBy: 'project',
            defaultProjectFlowMode: 'parallel',
            defaultScheduleTime: '09:00',
            timeEstimatePresets: ['5min', '15min', '30min', '1hr', '2hr', 'custom:75'],
            inboxProcessing: {
                defaultMode: 'guided',
                twoMinuteEnabled: true,
                twoMinuteFirst: true,
                projectFirst: true,
                contextStepEnabled: true,
                scheduleEnabled: true,
                referenceEnabled: true,
            },
            weeklyReview: { includeContextStep: true },
            dailyReview: { includeFocusStep: true },
            pomodoro: {
                customDurations: { focusMinutes: 25, breakMinutes: 5 },
                linkTask: true,
                autoStartBreaks: false,
                autoStartFocus: false,
                completionAlert: false,
            },
        },
    };
    const createdAt = atUtcTime(now, -60, 9);
    const areas = createAreas(createdAt, content);

    return {
        areas,
        projects: createProjects(now, settings, areas, content),
        sections: createSections(createdAt, content),
        people: createPeople(createdAt, content),
        tasks: createTasks(now, content),
        settings,
    };
}
