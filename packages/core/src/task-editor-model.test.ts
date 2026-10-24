import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatTimeEstimateLabel } from './calendar-scheduling';
import { createDateFormatter } from './date';
import { loadTranslations } from './i18n/i18n-loader';
import { filterProjectsBySelectedArea } from './project-utils';
import { WEEKDAY_ORDER } from './recurrence-constants';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { createTaskDraft, setTaskDraftField, type TaskDraft, type TaskDraftField } from './task-draft';
import { DEFAULT_TASK_EDITOR_HIDDEN, DEFAULT_TASK_EDITOR_ORDER, getTaskEditorSectionOpenDefaults, TASK_EDITOR_SECTION_ORDER } from './task-editor-layout';
import {
    applyTaskDraftPatch,
    buildTaskEditorModel,
    buildTaskEditUpdatePatch,
    clearInvalidTaskDraftSection,
    countTaskEditorFilledFields,
    getTaskEditorDailyInterval,
    getTaskEditorFieldLayout,
    getTaskEditorMonthlyAnchorSource,
    getTaskEditorMonthlyPattern,
    getTaskEditorProjectSections,
    getTaskEditorSuggestions,
    getTaskEditorBackdatedCompletionStart,
    getTaskEditorTimeEstimateValues,
    resolveTaskEditorBackdatedCompletion,
    toggleTaskEditorToken,
    resolveTaskEditorMonthlyAnchorDate,
    TASK_EDITOR_ENERGY_LEVEL_OPTIONS,
    TASK_EDITOR_PRIORITY_OPTIONS,
    TASK_EDITOR_RECURRENCE_OPTIONS,
    TASK_EDITOR_STATUS_OPTIONS,
    type TaskEditDraftOverrides,
    type TaskEditorFieldLayoutInput,
} from './task-editor-model';
import type { TaskTokenUsage } from './task-token-usage';
import type { AppSettings, Area, Attachment, Person, Project, Section, Task, TaskEditorFieldId, ViewSectionDefinition } from './types';

type Edit = {
    ops?: Array<[TaskDraftField, unknown]>;
    inputs?: { contextInputDraft?: string; tagInputDraft?: string; descriptionDraft?: string };
    overrides?: TaskEditDraftOverrides;
    checklist?: 'append' | 'clear';
    removeAttachments?: boolean;
};

const fixture = JSON.parse(
    readFileSync(new URL('./task-editor-model-parity.fixtures.json', import.meta.url), 'utf8'),
) as {
    timeZone: string;
    now: string;
    areas: Area[];
    projects: Project[];
    sections: Section[];
    tasks: Task[];
    settings: Record<string, AppSettings>;
    edits: Record<string, Edit>;
    somedaySections: ViewSectionDefinition[];
    somedayCases: Array<{ task: string; sections: 'configured' | 'none'; ops: Array<[TaskDraftField, unknown]> }>;
    suggestions: {
        contexts: string[];
        tags: string[];
        contextUsage: TaskTokenUsage[];
        tagUsage: TaskTokenUsage[];
        people: Person[];
        peopleTasks: Task[];
        tokenCases: Array<['contexts' | 'tags', string]>;
        peopleCases: Array<[string, number]>;
    };
    mobileSnapshot: {
        someday: Record<string, [boolean, Array<[string, boolean, unknown]>]>;
        suggestionLimit: number;
        tokens: Record<string, [string, Array<[string, string]>, Array<[string, boolean, string]>]>;
        people: Record<string, string[]>;
        constants: Record<string, unknown>;
        timeEstimateLabels: Record<string, string>;
        sectionOpen: Record<string, unknown>;
        options: Record<string, unknown[]>;
        patches: Record<string, Array<[string, unknown]> | null>;
        layouts: Record<string, [string, number[], boolean]>;
    };
};

const CREATED = '2026-09-01T00:00:00.000Z';
const liveProjects = fixture.projects.filter((project) => !project.deletedAt);
const liveSections = fixture.sections.filter((section) => !section.deletedAt);
const tasksById = new Map(fixture.tasks.map((task) => [task.id, task]));
const snapshot = fixture.mobileSnapshot;

describe('backdated completion picker policy', () => {
    const next: Task = { id: 'backdate', title: 'Task', status: 'next', tags: [], contexts: [],
        createdAt: CREATED, updatedAt: '2026-09-20T11:15:30.123Z' };

    it('starts from draft completion, saved Done update time, or a fresh clock at open', () => {
        const draft = createTaskDraft(next);
        expect(getTaskEditorBackdatedCompletionStart(next, draft)).toEqual({
            initialValue: null, initialTimeSpentMinutes: null,
        });
        const done = { ...next, status: 'done' as const };
        expect(getTaskEditorBackdatedCompletionStart(done, createTaskDraft(done)).initialValue).toBe(done.updatedAt);
        const imported = { ...done, updatedAt: '2026-09-20T07:15:30.123-04:00' };
        expect(getTaskEditorBackdatedCompletionStart(imported, createTaskDraft(imported)).initialValue)
            .toBe(done.updatedAt);
        expect(getTaskEditorBackdatedCompletionStart({ ...done, updatedAt: 'not-a-date' }, draft).initialValue)
            .toBeNull();
        const picked = applyTaskDraftPatch(draft, { status: 'done', completedAt: '2026-09-18T09:30:45.321Z',
            timeSpentMinutes: 100_001 });
        expect(getTaskEditorBackdatedCompletionStart(next, picked)).toEqual({
            initialValue: '2026-09-18T09:30:45.321Z', initialTimeSpentMinutes: 100_000,
        });
        const reverted = applyTaskDraftPatch(picked, { status: 'next' });
        expect(getTaskEditorBackdatedCompletionStart(done, reverted).initialValue).toBe(done.updatedAt);
    });

    it('resolves an instant and optional digits without changing an unoffered total', () => {
        const instant = '2026-09-18T09:30:45.321Z';
        expect(resolveTaskEditorBackdatedCompletion({ completedAt: instant })).toEqual({
            status: 'done', completedAt: instant,
        });
        expect(resolveTaskEditorBackdatedCompletion({ completedAt: instant, timeSpentText: '45 minutes' }))
            .toMatchObject({ timeSpentMinutes: 45 });
        expect(resolveTaskEditorBackdatedCompletion({ completedAt: instant, timeSpentText: '' }))
            .toEqual({ status: 'done', completedAt: instant, timeSpentMinutes: undefined });
        expect(resolveTaskEditorBackdatedCompletion({ completedAt: instant, timeSpentText: '0' })?.timeSpentMinutes)
            .toBeUndefined();
        expect(resolveTaskEditorBackdatedCompletion({ completedAt: instant, timeSpentText: '100001' })?.timeSpentMinutes)
            .toBe(100_000);
        expect(resolveTaskEditorBackdatedCompletion({ completedAt: '2026-09-18' })).toBeNull();
        expect(resolveTaskEditorBackdatedCompletion({ completedAt: '2026-02-30T09:30:00.000Z' })).toBeNull();
        expect(resolveTaskEditorBackdatedCompletion({ completedAt: instant, timeSpentText: null as never })).toBeNull();
    });
});

// Mirrors the capture: the edit's draft ops, list buffers and typed inputs.
const applyEdit = (task: Task, edit: Edit) => {
    let draft = createTaskDraft(task);
    for (const [field, value] of edit.ops ?? []) draft = setTaskDraftField(draft, field, (value ?? undefined) as never);
    const checklist = edit.checklist === 'append'
        ? [...(task.checklist ?? []), { id: 'blank', title: '  ', isCompleted: false }, { id: 'new', title: 'New item', isCompleted: true }]
        : edit.checklist === 'clear' ? [] : task.checklist;
    const newAttachment: Attachment = {
        id: 'att-new', kind: 'link', title: 'att-new', uri: 'https://example.com/att-new', createdAt: CREATED, updatedAt: CREATED,
    };
    const attachments = edit.removeAttachments
        ? (task.attachments ?? [newAttachment]).map((entry) => ({ ...entry, deletedAt: '2026-09-23T14:00:00.000Z' }))
        : task.attachments;
    return {
        draft,
        checklist,
        attachments,
        contextInputDraft: edit.inputs?.contextInputDraft ?? draft.contexts,
        tagInputDraft: edit.inputs?.tagInputDraft ?? draft.tags,
        descriptionDraft: edit.inputs?.descriptionDraft ?? draft.description,
    };
};

const encodePatch = (patch: Partial<Task> | null) => patch === null
    ? null
    : Object.entries(patch).map(([key, value]) => [key, value === undefined ? '<undefined>' : value]);

describe('task editor model parity with the mobile editor', () => {
    const originalTz = process.env.TZ;
    let t: (key: string) => string = (key) => key;
    beforeAll(async () => {
        process.env.TZ = fixture.timeZone;
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        const english = await loadTranslations('en');
        t = (key) => english[key] || key;
    });
    afterAll(() => {
        vi.useRealTimers();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    it('offers the same fixed option lists', () => {
        expect({
            statuses: TASK_EDITOR_STATUS_OPTIONS,
            priorities: TASK_EDITOR_PRIORITY_OPTIONS,
            energyLevels: TASK_EDITOR_ENERGY_LEVEL_OPTIONS,
            recurrences: TASK_EDITOR_RECURRENCE_OPTIONS.map(({ value, labelKey }) => ({ value, label: t(labelKey) })),
        }).toEqual(snapshot.constants);
        expect(Object.fromEntries(Object.keys(snapshot.timeEstimateLabels).map((value) => [
            value, value ? formatTimeEstimateLabel(value as never, { t }) : t('common.none'),
        ]))).toEqual(snapshot.timeEstimateLabels);
        expect(Object.fromEntries(Object.entries(fixture.settings).map(([name, settings]) => [
            name, getTaskEditorSectionOpenDefaults(settings.gtd?.taskEditor),
        ]))).toEqual(snapshot.sectionOpen);
    });

    it('builds the same layout and filled counts for every captured state', () => {
        const layouts = Object.fromEntries(Object.keys(snapshot.layouts).map((key) => {
            const [taskId, settingsName, editName] = key.split('|');
            const task = tasksById.get(taskId)!;
            const settings = fixture.settings[settingsName];
            const state = applyEdit(task, fixture.edits[editName]);
            const flags = resolveFeatureFlags(settings);
            const layout = getTaskEditorFieldLayout({
                task,
                draft: state.draft,
                checklist: state.checklist,
                taskEditor: settings.gtd?.taskEditor,
                hasProjectSections: getTaskEditorProjectSections(liveSections, state.draft.projectId).length > 0,
                prioritiesEnabled: flags.priorities,
                timeEstimatesEnabled: flags.timeEstimates,
                contextInputDraft: state.contextInputDraft,
                descriptionDraft: state.descriptionDraft,
                tagInputDraft: state.tagInputDraft,
                visibleAttachmentsLength: (state.attachments ?? []).filter((entry) => !entry.deletedAt).length,
            });
            const lists = TASK_EDITOR_SECTION_ORDER.map((id) => layout.sections[id]);
            return [key, [
                lists.map((fields) => fields.join(',')).join('|'),
                lists.map((fields) => countTaskEditorFilledFields(fields, state)),
                layout.showStatusField,
            ]];
        }));
        expect(layouts).toEqual(snapshot.layouts);
    });

    it('offers the same projects, sections, estimates and recurrence state', () => {
        const options = Object.fromEntries(Object.keys(snapshot.options).map((key) => {
            const [taskId, editName] = key.split('|');
            const task = tasksById.get(taskId)!;
            const { draft } = applyEdit(task, fixture.edits[editName]);
            const anchor = resolveTaskEditorMonthlyAnchorDate(getTaskEditorMonthlyAnchorSource(task, draft));
            return [key, [
                draft.projectId,
                draft.areaId,
                filterProjectsBySelectedArea(liveProjects, draft.areaId).map((project) => project.id).join(','),
                getTaskEditorProjectSections(liveSections, draft.projectId).map((section) => section.id).join(','),
                getTaskEditorTimeEstimateValues(draft.timeEstimate).join(','),
                draft.recurrence, draft.recurrenceStrategy, draft.recurrenceRRule,
                getTaskEditorDailyInterval(draft.recurrence, draft.recurrenceRRule),
                getTaskEditorMonthlyPattern(draft.recurrence, draft.recurrenceRRule, anchor),
                WEEKDAY_ORDER[anchor.getDay()],
                anchor.toISOString(),
            ]];
        }));
        expect(options).toEqual(snapshot.options);
    });

    it('composes the frozen save patch with explicit legacy reminder intent', () => {
        const patches = Object.fromEntries(Object.keys(snapshot.patches).map((key) => {
            const [taskId, editName] = key.split('|');
            const task = tasksById.get(taskId)!;
            const edit = fixture.edits[editName];
            const state = applyEdit(task, edit);
            return [key, encodePatch(buildTaskEditUpdatePatch(state, task, edit.overrides))];
        }));
        const expected = JSON.stringify(snapshot.patches)
            .replaceAll('["suppressMindwtrReminders",true]', '["reminderPolicy","skip"]');
        expect(JSON.stringify(patches)).toBe(expected);
    });

    it('builds the host model from the same layout and options', () => {
        for (const key of Object.keys(snapshot.layouts).filter((entry) => entry.endsWith('|none'))) {
            const [taskId, settingsName] = key.split('|');
            const task = tasksById.get(taskId)!;
            const draft = createTaskDraft(task);
            const [fields, filled, showStatusField] = snapshot.layouts[key];
            const option = snapshot.options[`${taskId}|none`];
            const open = snapshot.sectionOpen[settingsName] as Record<string, boolean>;
            const model = buildTaskEditorModel({
                task, draft, settings: fixture.settings[settingsName], projects: liveProjects, sections: liveSections,
                areas: fixture.areas, tasks: fixture.tasks, people: [], contexts: ['@office'], tags: ['#launch'], t,
            });
            const expectedSections = TASK_EDITOR_SECTION_ORDER.map((id, index) => ({
                id,
                titleKey: id === 'basic' ? null : `taskEdit.${id}`,
                fields: fields.split('|')[index].split(',').filter(Boolean),
                filledCount: filled[index],
                open: open[id] || filled[index] > 0,
            })).filter((section) => section.fields.length > 0);
            expect(model.layout, key).toEqual({
                sections: expectedSections,
                showStatusField,
                showSomedaySection: task.status === 'someday',
                recurrence: { dailyInterval: option[8], monthlyPattern: option[9] },
            });
            expect(model.options.projects.map((project) => project.id).join(','), key).toBe(option[2]);
            expect(model.options.sections.map((section) => section.id).join(','), key).toBe(option[3]);
            expect(model.options.timeEstimates, key).toEqual(String(option[4]).split(',').map((value) => ({
                value, label: snapshot.timeEstimateLabels[value],
            })));
        }
    });
});

describe('task editor model parity: Someday sections and suggestions', () => {
    let t: (key: string) => string = (key) => key;
    beforeAll(async () => {
        const english = await loadTranslations('en');
        t = (key) => english[key] || key;
    });

    it('shows the same Someday section picker with the same choices', () => {
        const someday = Object.fromEntries(fixture.somedayCases.map((entry) => {
            const task = tasksById.get(entry.task)!;
            let draft = createTaskDraft(task);
            for (const [field, value] of entry.ops) draft = setTaskDraftField(draft, field, value as never);
            const settings: AppSettings = entry.sections === 'configured'
                ? { gtd: { viewSections: { someday: fixture.somedaySections } } }
                : {};
            const model = buildTaskEditorModel({
                task, draft, settings, projects: liveProjects, sections: liveSections, areas: fixture.areas,
                tasks: fixture.tasks, people: [], contexts: [], tags: [], t,
            });
            return [`${entry.task}|${entry.sections}|${JSON.stringify(entry.ops)}`, [
                model.layout.showSomedaySection,
                model.options.somedaySections.map(({ title, selected, viewSectionIds }) => [title, selected, viewSectionIds]),
            ]];
        }));
        expect(someday).toEqual(snapshot.someday);
    });

    it('suggests the same tokens and chips, and edits the input the same way', () => {
        const { suggestions } = fixture;
        const tokens = Object.fromEntries(suggestions.tokenCases.map(([field, text]) => {
            const result = getTaskEditorSuggestions({
                field,
                text,
                limit: snapshot.suggestionLimit,
                knownTokens: field === 'contexts' ? suggestions.contexts : suggestions.tags,
                usage: field === 'contexts' ? suggestions.contextUsage : suggestions.tagUsage,
                people: [],
                tasks: [],
            });
            return [`${field}|${text}`, [
                result.draftValue,
                result.matches.map(({ value, text: next }) => [value, next]),
                result.quick.map(({ value, selected, text: next }) => [value, selected, next]),
            ]];
        }));
        expect(tokens).toEqual(snapshot.tokens);
        // Case, prefix and the typed-token rules, spelled out.
        expect(tokens['contexts|@o'][1].map(([value]) => value)).toEqual(['@office', '@office-2', '@outdoors', '@home']);
        expect(tokens['contexts|'][1]).toEqual([]);
        expect(tokens['contexts|@O'][1].map(([value]) => value)).toEqual(tokens['contexts|@o'][1].map(([value]) => value));
        expect(toggleTaskEditorToken('@home, @o', '@home', '@')).toBe('@o');
    });

    it('suggests the same people, managed and recent first', () => {
        const { suggestions } = fixture;
        const people = Object.fromEntries(suggestions.peopleCases.map(([text, limit]) => [`${text}|${limit}`, getTaskEditorSuggestions({
            field: 'assignedTo', text, limit, knownTokens: [], usage: [], people: suggestions.people, tasks: suggestions.peopleTasks,
        }).matches.map(({ value }) => value)]));
        expect(people).toEqual(snapshot.people);
    });

    it('matches RN creation eligibility, including exact names omitted from suggestions', () => {
        for (const [text, expected] of [
            ['', false], ['   ', false], ['Ada', true], [' ada ', true],
            ['İpek', true], ['i\u0307pek', true], ['New Person', true],
        ] as const) {
            const people = ['Ada', 'İpek'].map((name, index) => ({
                id: String(index), name, createdAt: CREATED, updatedAt: CREATED,
            }));
            const result = getTaskEditorSuggestions({
                field: 'assignedTo', text, limit: 4, knownTokens: [], usage: [], people, tasks: [],
            });
            expect(result.canCreatePerson).toBe(expected);
        }
    });
});

describe('task editor model rules', () => {
    it('selects Custom for the last weekday of a month', () => {
        expect(getTaskEditorMonthlyPattern(
            'monthly', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', new Date(2026, 0, 30),
        )).toBe('custom');
    });

    it.each(['1', '2', '3', '4', '-1'])(
        'selects Custom for positioned weekdays at position %s',
        (position) => {
            expect(getTaskEditorMonthlyPattern(
                'monthly', `FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=${position}`, new Date(2026, 0, 30),
            )).toBe('custom');
        },
    );

    it('selects Custom for a plain weekday, but Date for the anchor day', () => {
        const anchor = new Date(2026, 0, 30);
        expect(getTaskEditorMonthlyPattern('monthly', 'FREQ=MONTHLY;BYDAY=MO', anchor)).toBe('custom');
        expect(getTaskEditorMonthlyPattern('monthly', 'FREQ=MONTHLY', anchor)).toBe('date');
        expect(getTaskEditorMonthlyPattern('monthly', 'FREQ=MONTHLY;BYMONTHDAY=30', anchor)).toBe('date');
        expect(getTaskEditorMonthlyPattern('monthly', 'FREQ=MONTHLY;BYMONTHDAY=29', anchor)).toBe('custom');
        expect(getTaskEditorMonthlyPattern('weekly', 'FREQ=WEEKLY;BYDAY=MO', anchor)).toBe('date');
    });

    const task: Task = {
        id: 't', title: 'Task', status: 'next', tags: [], contexts: [], createdAt: CREATED, updatedAt: CREATED,
    };
    const layoutOf = (overrides: Partial<TaskEditorFieldLayoutInput> & { taskPatch?: Partial<Task> }) => {
        const { taskPatch, ...rest } = overrides;
        const current = { ...task, ...taskPatch };
        const draft = createTaskDraft(current);
        const layout = getTaskEditorFieldLayout({
            task: current, draft, checklist: current.checklist, taskEditor: undefined, hasProjectSections: false,
            prioritiesEnabled: true, timeEstimatesEnabled: true, contextInputDraft: draft.contexts,
            descriptionDraft: draft.description, tagInputDraft: draft.tags, visibleAttachmentsLength: 0, ...rest,
        });
        return { ...layout, all: TASK_EDITOR_SECTION_ORDER.flatMap((id) => layout.sections[id]) };
    };

    it('shows the section field only inside a project, when sections exist or one is chosen', () => {
        expect(layoutOf({ hasProjectSections: true }).all).not.toContain('section');
        expect(layoutOf({ taskPatch: { projectId: 'p' } }).all).not.toContain('section');
        expect(layoutOf({ taskPatch: { projectId: 'p' }, hasProjectSections: true }).all).toContain('section');
        const hidden = { hidden: ['section' as TaskEditorFieldId] };
        expect(layoutOf({ taskPatch: { projectId: 'p' }, hasProjectSections: true, taskEditor: hidden }).all).not.toContain('section');
        expect(layoutOf({ taskPatch: { projectId: 'p', sectionId: 's' }, taskEditor: hidden }).all).toContain('section');
        // Migrated defaults are not a choice to hide sections.
        const migrated = { defaultsVersion: 5, hidden: [...DEFAULT_TASK_EDITOR_HIDDEN] };
        expect(layoutOf({ taskPatch: { projectId: 'p' }, hasProjectSections: true, taskEditor: migrated }).all).toContain('section');
    });

    it('keeps Reference status and an empty checklist editable while hiding action metadata', () => {
        const reference = { status: 'reference' as const, dueDate: '2026-10-01', priority: 'high' as const, contexts: ['@a'] };
        const plain = layoutOf({ taskPatch: reference });
        for (const field of ['dueDate', 'startTime', 'priority', 'contexts'] as const) {
            expect(plain.all).not.toContain(field);
        }
        expect(plain.showStatusField).toBe(true);
        expect(plain.all).toEqual(expect.arrayContaining(['status', 'checklist']));
        const hidden = layoutOf({ taskPatch: reference, taskEditor: { hidden: ['status', 'checklist'] } });
        expect(hidden.all).not.toContain('status');
        expect(hidden.all).not.toContain('checklist');
        const withItems = layoutOf({ taskPatch: { ...reference, checklist: [{ id: 'c', title: 'Item', isCompleted: false }] } });
        expect(withItems.all).toContain('checklist');
    });

    it('reveals the person field for Waiting unless the layout hides it explicitly', () => {
        expect(layoutOf({}).all).not.toContain('assignedTo');
        expect(layoutOf({ taskPatch: { status: 'waiting' } }).all).toContain('assignedTo');
        expect(layoutOf({ taskPatch: { status: 'waiting' }, taskEditor: { hidden: ['assignedTo'] } }).all).not.toContain('assignedTo');
    });

    it('reveals Waiting person with saved defaults but respects a customized hidden list', () => {
        const defaults = { defaultsVersion: 5, hidden: [...DEFAULT_TASK_EDITOR_HIDDEN].reverse() };
        const waiting = setTaskDraftField(createTaskDraft(task), 'status', 'waiting');
        expect(layoutOf({ draft: waiting, taskEditor: defaults }).all).toContain('assignedTo');
        expect(layoutOf({ taskPatch: { status: 'waiting' }, draft: null, taskEditor: defaults }).all).toContain('assignedTo');
        expect(layoutOf({ taskEditor: defaults }).all).not.toContain('assignedTo');
        for (const taskEditor of [
            { ...defaults, order: [...DEFAULT_TASK_EDITOR_ORDER] },
            { ...defaults, hidden: ['assignedTo' as const] },
            { hidden: [...DEFAULT_TASK_EDITOR_HIDDEN] },
        ]) {
            expect(layoutOf({ draft: waiting, taskEditor }).all).not.toContain('assignedTo');
        }
    });

    it('shows a hidden field that holds a value and drops a disabled feature even with one', () => {
        expect(layoutOf({ taskPatch: { location: 'Desk' } }).all).toContain('location');
        expect(layoutOf({ taskPatch: { location: '  ' } }).all).not.toContain('location');
        const valued = { priority: 'high' as const, timeEstimate: '30min' as const };
        expect(layoutOf({ taskPatch: valued }).all).toEqual(expect.arrayContaining(['priority', 'timeEstimate']));
        const off = layoutOf({ taskPatch: valued, prioritiesEnabled: false, timeEstimatesEnabled: false }).all;
        expect(off).not.toContain('priority');
        expect(off).not.toContain('timeEstimate');
    });

    it('reads typed text for contexts, tags and notes', () => {
        expect(layoutOf({ taskEditor: { hidden: ['contexts'] }, contextInputDraft: '@typing' }).all).toContain('contexts');
        expect(layoutOf({ taskEditor: { hidden: ['contexts'] }, contextInputDraft: ' ' }).all).not.toContain('contexts');
    });

    it('applies status first so an explicit completion time or star survives its cascade', () => {
        const draft = createTaskDraft(task);
        expect(applyTaskDraftPatch(draft, { completedAt: '2026-09-20T10:00:00.000Z', status: 'done' }))
            .toMatchObject({ status: 'done', completedAt: '2026-09-20T10:00:00.000Z' });
        // Key order in the patch does not matter.
        expect(applyTaskDraftPatch(draft, { status: 'done', completedAt: '2026-09-20T10:00:00.000Z' }))
            .toMatchObject({ status: 'done', completedAt: '2026-09-20T10:00:00.000Z' });
        // The star wins over Inbox, as in the store.
        expect(applyTaskDraftPatch(draft, { focusedToday: true, status: 'inbox' }))
            .toMatchObject({ status: 'next', focusedToday: true });
        const done = createTaskDraft({ ...task, status: 'done', completedAt: '2026-09-20T10:00:00.000Z' });
        expect(applyTaskDraftPatch(done, { status: 'next' })).toMatchObject({ status: 'next', completedAt: '' });
    });

    it('drops a section that is not a live section of the chosen project', () => {
        const draft: TaskDraft = { ...createTaskDraft(task), projectId: 'p', sectionId: 's' };
        const sections = [{ id: 's', projectId: 'p' }, { id: 'gone', projectId: 'p', deletedAt: CREATED }];
        expect(clearInvalidTaskDraftSection(draft, sections)).toBe(draft);
        expect(clearInvalidTaskDraftSection({ ...draft, projectId: 'other' }, sections).sectionId).toBe('');
        expect(clearInvalidTaskDraftSection({ ...draft, sectionId: 'gone' }, sections).sectionId).toBe('');
    });
});


describe('task editor model calendar preview hint', () => {
    it('adds the original RN daily hint and clears it with the draft recurrence', () => {
        const task: Task = { id: 'preview', title: 'Preview', status: 'next', tags: [], contexts: [],
            dueDate: '2026-10-01', recurrence: { rule: 'daily', strategy: 'strict' },
            createdAt: CREATED, updatedAt: CREATED };
        const input = { task, draft: createTaskDraft(task), settings: {}, projects: [], sections: [], areas: [], tasks: [task],
            people: [], contexts: [], tags: [], t: (key: string) => key, now: new Date('2026-09-27T12:00:00.000Z'),
            formatDate: createDateFormatter({ language: 'en', dateFormat: 'system', timeFormat: 'system', systemLocale: 'en-US' }) };
        expect(buildTaskEditorModel(input).fields.recurrence.calendarPreviewHint).toBe('Next calendar preview: Oct 2, 2026.');
        expect(buildTaskEditorModel({ ...input, draft: { ...input.draft, recurrence: '', recurrenceRRule: '' } })
            .fields.recurrence.calendarPreviewHint).toBe('');
    });
});
