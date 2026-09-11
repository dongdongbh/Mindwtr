import { describe, expect, it } from 'vitest';
import { normalizeProjectLifecycleFields } from './project-status';
import { createSandboxData } from './sandbox-data';
import { normalizeTaskForLoad } from './task-status';
import type { AppData, AppSettings, TaskStatus } from './types';

const FIXED_NOW = new Date('2026-09-10T15:30:00.000Z');
const ALL_TASK_STATUSES: TaskStatus[] = [
    'inbox',
    'next',
    'waiting',
    'someday',
    'reference',
    'done',
    'archived',
];

const visibleContent = (data: AppData) => ({
    areas: data.areas.map(({ id, name }) => ({ id, name })),
    projects: data.projects.map(({ id, title, supportNotes, tagIds }) => ({ id, title, supportNotes, tagIds })),
    sections: data.sections.map(({ id, title, description }) => ({ id, title, description })),
    people: (data.people ?? []).map(({ id, name, note }) => ({ id, name, note })),
    tasks: data.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        tags: task.tags,
        contexts: task.contexts,
        assignedTo: task.assignedTo,
        location: task.location,
        checklist: task.checklist?.map(({ id, title }) => ({ id, title })),
        attachments: task.attachments?.map(({ id, title, uri }) => ({ id, title, uri })),
    })),
});

const structuralContent = (data: AppData) => ({
    areas: data.areas.map(({ name: _name, ...area }) => area),
    projects: data.projects.map(({ title: _title, supportNotes: _supportNotes, tagIds: _tagIds, areaTitle: _areaTitle, ...project }) => project),
    sections: data.sections.map(({ title: _title, description: _description, ...section }) => section),
    people: (data.people ?? []).map(({ name: _name, note: _note, ...person }) => person),
    tasks: data.tasks.map((task) => {
        const {
            title: _title,
            description: _description,
            tags: _tags,
            contexts: _contexts,
            assignedTo: _assignedTo,
            location: _location,
            checklist,
            attachments,
            ...rest
        } = task;
        return {
            ...rest,
            checklist: checklist?.map(({ title: _itemTitle, ...item }) => item),
            attachments: attachments?.map(({ title: _attachmentTitle, ...attachment }) => attachment),
        };
    }),
});

describe('createSandboxData', () => {
    it('localizes all sample content for the six supported content languages', () => {
        const english = createSandboxData({ now: FIXED_NOW, settings: { language: 'en' } });
        const expected = {
            de: ['Frühlings-Gemeinschaftsgarten', 'Maße des Werkstatttischs erfassen'],
            fr: ['Jardin collectif de printemps', 'Noter les dimensions de la table d’atelier'],
            es: ['Huerto comunitario de primavera', 'Anotar las medidas de la mesa del taller'],
            ru: ['Весенний общественный огород', 'Записать размеры рабочего стола'],
            zh: ['春季社区花园', '记录工作台尺寸'],
        } as const;

        for (const [language, [projectTitle, firstTaskTitle]] of Object.entries(expected)) {
            const localized = createSandboxData({
                now: FIXED_NOW,
                settings: { language: language as AppSettings['language'] },
            });
            expect(localized.projects[0].title).toBe(projectTitle);
            expect(localized.tasks[0].title).toBe(firstTaskTitle);
            expect(localized.tasks.every((task, index) => task.title !== english.tasks[index].title)).toBe(true);
            expect(localized.areas.every((area, index) => area.name !== english.areas[index].name)).toBe(true);
            expect(localized.projects.every((project, index) => project.title !== english.projects[index].title)).toBe(true);
            expect((localized.people ?? []).every((person, index) => person.name !== english.people?.[index]?.name)).toBe(true);
            expect((localized.people ?? []).every((person, index) => person.note !== english.people?.[index]?.note)).toBe(true);
            expect(localized.projects.filter((project) => project.supportNotes).every((project) => (
                project.supportNotes !== english.projects.find((candidate) => candidate.id === project.id)?.supportNotes
            ))).toBe(true);
            expect(localized.sections.filter((section) => section.description).every((section) => (
                section.description !== english.sections.find((candidate) => candidate.id === section.id)?.description
            ))).toBe(true);
            expect(localized.tasks.filter((task) => task.description).every((task) => (
                task.description !== english.tasks.find((candidate) => candidate.id === task.id)?.description
            ))).toBe(true);
            expect(structuralContent(localized)).toEqual(structuralContent(english));

            const localizedPeople = new Set((localized.people ?? []).map((person) => person.name));
            expect(localized.tasks.filter((task) => task.assignedTo).every((task) => localizedPeople.has(task.assignedTo as string))).toBe(true);
            expect(localized.tasks.find((task) => task.checklist)?.checklist?.[0].title)
                .not.toBe(english.tasks.find((task) => task.checklist)?.checklist?.[0].title);
            expect(localized.tasks.find((task) => task.attachments)?.attachments?.[0].title)
                .not.toBe(english.tasks.find((task) => task.attachments)?.attachments?.[0].title);
            expect(localized.tasks.find((task) => task.id === 'sandbox-task-inbox-measurements')?.contexts[0])
                .not.toBe(english.tasks.find((task) => task.id === 'sandbox-task-inbox-measurements')?.contexts[0]);
            expect(localized.tasks.find((task) => task.id === 'sandbox-task-garden-map')?.tags[0])
                .not.toBe(english.tasks.find((task) => task.id === 'sandbox-task-garden-map')?.tags[0]);
        }

        const simplified = createSandboxData({ now: FIXED_NOW, settings: { language: 'zh' } });
        const simplifiedAlias = createSandboxData({
            now: FIXED_NOW,
            settings: { language: 'zh-Hans' as AppSettings['language'] },
        });
        const traditional = createSandboxData({ now: FIXED_NOW, settings: { language: 'zh-Hant' } });
        expect(visibleContent(simplifiedAlias)).toEqual(visibleContent(simplified));
        expect(visibleContent(traditional)).toEqual(visibleContent(simplified));
        expect(simplified.settings.language).toBe('zh');
        expect(traditional.settings.language).toBe('zh-Hant');
    });

    it('uses English content for absent, system, and unsupported languages', () => {
        const english = createSandboxData({ now: FIXED_NOW, settings: { language: 'en' } });
        const absent = createSandboxData({ now: FIXED_NOW });
        const system = createSandboxData({ now: FIXED_NOW, settings: { language: 'system' } });
        const unsupported = createSandboxData({ now: FIXED_NOW, settings: { language: 'ja' } });

        expect(visibleContent(absent)).toEqual(visibleContent(english));
        expect(visibleContent(system)).toEqual(visibleContent(english));
        expect(visibleContent(unsupported)).toEqual(visibleContent(english));
        expect(system.settings.language).toBe('system');
        expect(unsupported.settings.language).toBe('ja');
    });

    it('covers the supported workspace shapes with coherent fictional examples', () => {
        const data = createSandboxData({ now: FIXED_NOW });

        expect(data.tasks).toHaveLength(46);
        expect(data.areas).toHaveLength(4);
        expect(data.projects).toHaveLength(8);
        expect(data.sections).toHaveLength(15);
        expect(data.people).toHaveLength(4);
        expect(new Set(data.tasks.map((task) => task.status))).toEqual(new Set(ALL_TASK_STATUSES));

        expect(data.projects.some((project) => project.status === 'active' && project.isSequential === false)).toBe(true);
        expect(data.projects.some((project) => project.status === 'active' && project.isSequential === true && project.sequentialScope === 'project')).toBe(true);
        expect(data.projects.some((project) => project.status === 'active' && project.isSequential === true && project.sequentialScope === 'section')).toBe(true);
        expect(data.projects.some((project) => project.status === 'waiting')).toBe(true);
        expect(data.projects.some((project) => project.status === 'someday')).toBe(true);
        expect(data.projects.some((project) => project.status === 'archived' && !project.cancelledAt)).toBe(true);
        expect(data.projects.some((project) => project.status === 'archived' && Boolean(project.cancelledAt))).toBe(true);

        const priorities = new Set(data.tasks.map((task) => task.priority).filter(Boolean));
        const energyLevels = new Set(data.tasks.map((task) => task.energyLevel).filter(Boolean));
        const estimates = new Set(data.tasks.map((task) => task.timeEstimate).filter(Boolean));
        expect(priorities).toEqual(new Set(['low', 'medium', 'high', 'urgent']));
        expect(energyLevels).toEqual(new Set(['low', 'medium', 'high']));
        expect(['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', 'custom:75']
            .every((estimate) => estimates.has(estimate))).toBe(true);

        const focused = data.tasks.filter((task) => task.isFocusedToday);
        expect(focused).toHaveLength(4);
        expect(focused.map((task) => task.focusOrder).sort()).toEqual([0, 1, 2, 3]);

        const checklist = data.tasks.find((task) => task.id === 'sandbox-task-garden-signs')?.checklist;
        expect(checklist?.some((item) => item.isCompleted)).toBe(true);
        expect(checklist?.some((item) => !item.isCompleted)).toBe(true);

        const reference = data.tasks.find((task) => task.id === 'sandbox-task-reference-raised-beds');
        expect(reference?.description).toContain('# Raised-bed notes');
        expect(reference?.description).toContain('- Leave a clear path');
        expect(reference?.description).toContain('> A simple layout');
        expect(reference?.description).toContain('| Bed | First crop |');
        expect(reference?.description).toContain('`crop · planted date · contact`');
        expect(reference?.description).toContain('[Fictional planting guide]');
        expect(data.tasks.some((task) => task.title.length > 100)).toBe(true);
        expect(data.tasks.some((task) => /[🌱✨]|مرح|こんにちは/u.test(task.title))).toBe(true);
    });

    it('includes valid recurrence examples and a linked completed occurrence', () => {
        const data = createSandboxData({ now: FIXED_NOW });
        const recurring = data.tasks.filter((task) => typeof task.recurrence === 'object');
        const recurrences = recurring.map((task) => task.recurrence).filter((value) => typeof value === 'object');

        expect(new Set(recurrences.map((recurrence) => recurrence.rule))).toEqual(new Set(['daily', 'weekly', 'monthly', 'yearly']));
        expect(new Set(recurrences.map((recurrence) => recurrence.strategy))).toEqual(new Set(['strict', 'fluid']));
        expect(recurring.every((task) => Boolean(task.dueDate))).toBe(true);

        const linked = recurring.filter((task) => (
            typeof task.recurrence === 'object'
            && task.recurrence.seriesId === 'sandbox-series-reading-review'
        ));
        expect(linked).toHaveLength(2);
        expect(new Set(linked.map((task) => task.status))).toEqual(new Set(['done', 'next']));
        expect(linked.every((task) => task.dueDate?.endsWith('-15'))).toBe(true);
        expect(linked.find((task) => task.status === 'done')?.dueDate).toBe('2026-08-15');
        expect(linked.find((task) => task.status === 'next')?.dueDate).toBe('2026-09-15');
        expect(linked.find((task) => task.status === 'next')?.recurrence).toMatchObject({
            count: 6,
            completedOccurrences: 1,
        });

        const weekly = data.tasks.find((task) => task.id === 'sandbox-task-reading-session');
        expect(weekly?.dueDate).toBe('2026-09-12');
        expect([2, 6]).toContain(new Date(`${weekly?.dueDate}T00:00:00.000Z`).getUTCDay());
    });

    it('keeps references intact and uses only safe synthetic link attachments', () => {
        const data = createSandboxData({ now: FIXED_NOW });
        const projectById = new Map(data.projects.map((project) => [project.id, project]));
        const areaIds = new Set(data.areas.map((area) => area.id));
        const sectionById = new Map(data.sections.map((section) => [section.id, section]));
        const people = new Set((data.people ?? []).filter((person) => !person.deletedAt).map((person) => person.name));

        const everyId = [
            ...data.tasks.map((task) => task.id),
            ...data.projects.map((project) => project.id),
            ...data.sections.map((section) => section.id),
            ...data.areas.map((area) => area.id),
            ...(data.people ?? []).map((person) => person.id),
        ];
        expect(new Set(everyId).size).toBe(everyId.length);

        for (const project of data.projects) {
            if (project.areaId) expect(areaIds.has(project.areaId)).toBe(true);
        }
        for (const section of data.sections) {
            expect(projectById.has(section.projectId)).toBe(true);
        }
        for (const task of data.tasks) {
            if (task.areaId) expect(areaIds.has(task.areaId)).toBe(true);
            if (task.projectId) {
                expect(projectById.has(task.projectId)).toBe(true);
                expect(task.areaId).toBeUndefined();
            }
            if (task.sectionId) {
                const section = sectionById.get(task.sectionId);
                expect(section).toBeDefined();
                expect(task.projectId).toBe(section?.projectId);
            }
            if (task.assignedTo) expect(people.has(task.assignedTo)).toBe(true);
        }

        const waitingTasks = data.tasks.filter((task) => task.status === 'waiting');
        expect(waitingTasks.length).toBeGreaterThanOrEqual(4);
        expect(waitingTasks.every((task) => Boolean(task.assignedTo))).toBe(true);

        const taskCountsBySection = new Map<string, number>();
        for (const task of data.tasks) {
            if (!task.sectionId || task.deletedAt) continue;
            taskCountsBySection.set(task.sectionId, (taskCountsBySection.get(task.sectionId) ?? 0) + 1);
        }
        expect(data.sections.some((section) => (taskCountsBySection.get(section.id) ?? 0) === 0)).toBe(true);
        expect(data.sections.some((section) => (taskCountsBySection.get(section.id) ?? 0) > 1)).toBe(true);

        const attachments = [
            ...data.tasks.flatMap((task) => task.attachments ?? []),
            ...data.projects.flatMap((project) => project.attachments ?? []),
        ];
        expect(attachments.length).toBeGreaterThan(0);
        for (const attachment of attachments) {
            expect(attachment.kind).toBe('link');
            expect(new URL(attachment.uri).hostname).toBe('example.com');
            expect(attachment.cloudKey).toBeUndefined();
            expect(attachment.localStatus).toBeUndefined();
        }
    });

    it('uses relative date-only and datetime examples and canonical lifecycle fields', () => {
        const data = createSandboxData({ now: FIXED_NOW });
        const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

        expect(data.tasks.some((task) => task.dueDate && dateOnly.test(task.dueDate))).toBe(true);
        expect(data.tasks.some((task) => task.dueDate?.includes('T'))).toBe(true);
        expect(data.tasks.some((task) => task.startTime && dateOnly.test(task.startTime))).toBe(true);
        expect(data.tasks.some((task) => task.startTime?.includes('T'))).toBe(true);
        expect(data.tasks.some((task) => task.dueDate === '2026-09-12')).toBe(true);
        expect(data.tasks.some((task) => task.dueDate === '2026-09-10T18:00:00.000Z')).toBe(true);

        expect(data.tasks.some((task) => Boolean(task.deletedAt))).toBe(true);
        expect(data.tasks.some((task) => task.status === 'archived' && Boolean(task.cancelledAt) && !task.completedAt)).toBe(true);
        expect(data.tasks.some((task) => task.status === 'archived' && !task.cancelledAt && Boolean(task.completedAt))).toBe(true);
        expect(data.tasks.some((task) => task.status === 'done' && Boolean(task.completedAt))).toBe(true);

        for (const task of data.tasks) {
            expect(normalizeTaskForLoad(task, FIXED_NOW.toISOString())).toBe(task);
        }
        for (const project of data.projects) {
            expect(normalizeProjectLifecycleFields(project)).toBe(project);
        }
    });

    it('copies only allowlisted display settings and adds fixed sandbox workflow defaults', () => {
        const personalSettings = {
            theme: 'dark',
            language: 'fr',
            dateFormat: 'yyyy-MM-dd',
            calendarSystem: 'gregory',
            timeFormat: '24h',
            appearance: {
                density: 'compact',
                textSize: 'large',
                showTaskAge: true,
                showFutureStarts: false,
                unassignedAreaColor: '#personal',
                mobileQuickAccessView: 'calendar',
            },
            deviceId: 'personal-device-id',
            globalQuickAddShortcut: 'personal-shortcut',
            notificationsEnabled: true,
            network: { proxyUrl: 'https://secret.example' },
            ai: { enabled: true, apiKey: 'personal-secret' },
            gtd: { defaultAreaId: 'personal-area', focusTaskLimit: 99 },
            savedSearches: [{ id: 'personal-search', name: 'Private', query: 'secret' }],
        } as AppSettings;

        const data = createSandboxData({ now: FIXED_NOW, settings: personalSettings });

        expect(data.settings).toMatchObject({
            theme: 'dark',
            language: 'fr',
            appearance: {
                density: 'compact',
                textSize: 'large',
                showTaskAge: true,
                showFutureStarts: false,
            },
            features: {
                priorities: true,
                timeEstimates: true,
                pomodoro: true,
                timeline: true,
            },
            gtd: {
                focusTaskLimit: 5,
                defaultProjectFlowMode: 'parallel',
            },
        });
        expect(data.settings.appearance).toEqual({
            density: 'compact',
            textSize: 'large',
            showTaskAge: true,
            showFutureStarts: false,
        });
        expect(data.settings.deviceId).toBeUndefined();
        expect(data.settings.globalQuickAddShortcut).toBeUndefined();
        expect(data.settings.notificationsEnabled).toBeUndefined();
        expect(data.settings.network).toBeUndefined();
        expect(data.settings.ai).toBeUndefined();
        expect(data.settings.savedSearches).toBeUndefined();
        expect(data.settings.gtd?.defaultAreaId).toBeUndefined();
        expect(JSON.stringify(data.settings)).not.toContain('personal');
        expect(JSON.stringify(data.settings)).not.toContain('secret');
    });

    it('is deterministic for a supplied time while returning independent objects', () => {
        const first = createSandboxData({ now: FIXED_NOW, settings: { theme: 'sepia' } });
        const second = createSandboxData({ now: new Date(FIXED_NOW), settings: { theme: 'sepia' } });

        expect(first).toEqual(second);
        expect(first).not.toBe(second);
        expect(first.tasks).not.toBe(second.tasks);
        expect(first.projects).not.toBe(second.projects);
        expect(first.sections).not.toBe(second.sections);
        expect(first.areas).not.toBe(second.areas);
        expect(first.people).not.toBe(second.people);
        expect(first.projects[0].tagIds).not.toBe(second.projects[0].tagIds);
        expect(first.settings.gtd?.timeEstimatePresets).not.toBe(second.settings.gtd?.timeEstimatePresets);
        expect(first.tasks.find((task) => task.recurrence)?.recurrence)
            .not.toBe(second.tasks.find((task) => task.recurrence)?.recurrence);
        expect(first.tasks.find((task) => task.checklist)?.checklist)
            .not.toBe(second.tasks.find((task) => task.checklist)?.checklist);

        first.tasks[0].title = 'Edited only in the first sandbox';
        first.tasks[0].tags.push('#edited');
        first.projects[0].tagIds.push('#edited');
        first.settings.gtd?.timeEstimatePresets?.push('4hr');
        first.people?.splice(0, 1);
        expect(second.tasks[0].title).toBe('Capture the workshop table measurements');
        expect(second.tasks[0].tags).not.toContain('#edited');
        expect(second.projects[0].tagIds).not.toContain('#edited');
        expect(second.settings.gtd?.timeEstimatePresets).not.toContain('4hr');
        expect(second.people).toHaveLength(4);
    });
});
