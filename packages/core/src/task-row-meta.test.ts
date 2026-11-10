import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureDateFormatting } from './date';
import { loadTranslations } from './i18n/i18n-loader';
import type { Language } from './i18n/i18n-types';
import { buildTaskRowMeta, getTaskRowMetaValidUntil, resolveTaskRowFeatures, resolveTaskRowLookup, type TaskRowMeta, type TaskRowMetaPart } from './task-row-meta';
import { getProjectRowStatus } from './project-row-meta';
import { DEFAULT_AREA_COLOR, TASK_PRIORITY_COLORS } from './color-constants';
import type { Area, Project, Section, Task } from './types';

type ViewOptions = {
    hideDetails?: boolean;
    hideProjectMeta?: boolean;
    hideContexts?: boolean;
    hideChecklistProgress?: boolean;
    statusBadgeAsIcon?: boolean;
    showFocusToggle?: boolean;
    hideStatusBadge?: boolean;
    projectDeadlineLabel?: string;
};
type Config = {
    language: Language;
    systemLocale: string;
    settings: Parameters<typeof resolveTaskRowFeatures>[0] & {
        language: string;
        dateFormat?: string;
        calendarSystem?: string;
        timeFormat?: string;
    };
};
type RenderedPart = { texts: string[]; color: string | null; dotColor: string | null; icon: string | null };
type SnapshotRow = {
    task: string;
    config: string;
    view: string;
    parts: RenderedPart[];
    age: string | null;
    statusBadge: string | null;
    priorityStrip: string | null;
    star: string | null;
    description: string | null;
    direction: string | null;
    accessibilityLabel: string | null;
};

const fixture = JSON.parse(
    readFileSync(new URL('./task-row-meta-parity.fixtures.json', import.meta.url), 'utf8'),
) as {
    timeZone: string;
    now: string;
    areas: Area[];
    projects: Project[];
    sections: Section[];
    tasks: Task[];
    configs: Record<string, Config>;
    views: Record<string, ViewOptions>;
    mobileSnapshot: SnapshotRow[];
    followupSnapshot: {
        swipe: Array<{ status: Task['status'] } & TaskRowMeta['swipe']>;
        project: Array<{ status: Project['status']; cancelledAt: string | null; cancelled: boolean; statusLabel: string }>;
    };
};


const TONE_COLOR = { overdue: 'danger', dueSoon: 'warning', normal: 'secondaryText' } as const;
const PART_STYLE: Record<TaskRowMetaPart['kind'], { color: string; icon?: string }> = {
    project: { color: 'secondaryText' },
    area: { color: 'secondaryText' },
    projectDeadline: { color: '#F59E0B' },
    context: { color: '#3B82F6' },
    assignedTo: { color: 'secondaryText', icon: 'UserRound' },
    tag: { color: '#7C3AED' },
    completed: { color: 'secondaryText' },
    cancelled: { color: 'secondaryText' },
    due: { color: 'secondaryText' },
    start: { color: 'secondaryText' },
    dateIssue: { color: '#F59E0B' },
    recurrence: { color: 'secondaryText', icon: 'Repeat' },
    estimate: { color: 'secondaryText' },
    timeSpent: { color: 'secondaryText', icon: 'History' },
    checklist: { color: 'secondaryText', icon: 'ListChecks' },
    attachments: { color: 'secondaryText', icon: 'Paperclip' },
};

const renderPart = (part: TaskRowMetaPart): RenderedPart => ({
    texts: (part.kind === 'context' || part.kind === 'tag') && part.overflowCount > 0
        ? [part.text, `+${part.overflowCount}`]
        : [part.text],
    color: part.kind === 'due' ? TONE_COLOR[part.tone] : PART_STYLE[part.kind].color,
    dotColor: part.kind === 'project' || part.kind === 'area' ? part.dotColor ?? 'tint' : null,
    icon: PART_STYLE[part.kind].icon ?? null,
});

const renderRow = (meta: TaskRowMeta, task: Task, view: ViewOptions): Omit<SnapshotRow, 'task' | 'config' | 'view'> => ({
    parts: (view.hideDetails ? meta.parts.filter((part) => !part.detail) : meta.parts).map(renderPart),
    age: !view.hideDetails ? meta.ageLabel : null,
    statusBadge: view.hideStatusBadge || meta.statusLabel === null
        ? null
        : view.statusBadgeAsIcon ? '<icon>' : meta.statusLabel,
    priorityStrip: meta.priority ? TASK_PRIORITY_COLORS[meta.priority] : null,
    star: view.showFocusToggle && meta.canFocus ? (task.isFocusedToday ? 'focused' : 'unfocused') : null,
    description: !view.hideDetails ? meta.descriptionPreview : null,
    direction: meta.textDirection,
    accessibilityLabel: meta.accessibilityLabel,
});

describe('buildTaskRowMeta parity with the mobile row', () => {
    const originalTz = process.env.TZ;
    const translators = new Map<string, (key: string) => string>();
    beforeAll(async () => {
        process.env.TZ = fixture.timeZone;
        const english = await loadTranslations('en');
        for (const config of Object.values(fixture.configs)) {
            const map = await loadTranslations(config.language);

            translators.set(config.language, (key) => map[key] || english[key] || key);
        }
    });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
        configureDateFormatting();
    });


    beforeEach(() => configureDateFormatting({ language: 'fa', dateFormat: 'mdy', timeFormat: '12h', calendarSystem: 'jalali', systemLocale: 'fa-IR' }));

    it('matches the captured React Native swipe action for every task status', () => {
        const config = fixture.configs.en;
        for (const expected of fixture.followupSnapshot.swipe) {
            const task = { ...fixture.tasks[0], status: expected.status };
            const meta = buildTaskRowMeta({
                task,
                lookup: {},
                features: resolveTaskRowFeatures(config.settings),
                language: 'en',
                dateFormatting: { language: 'en', systemLocale: 'en-US' },
                t: translators.get('en')!,
                now: new Date(fixture.now),
            });
            expect(meta.swipe).toEqual({ target: expected.target, label: expected.label, icon: expected.icon });
        }
    });

    it('matches the captured React Native project status line', () => {
        for (const expected of fixture.followupSnapshot.project) {
            expect(getProjectRowStatus({ status: expected.status, cancelledAt: expected.cancelledAt ?? undefined }, translators.get('en')!))
                .toEqual({ cancelled: expected.cancelled, statusLabel: expected.statusLabel });
        }
    });

    it('covers every part kind, detail and collapsed views, and several languages', () => {
        const kinds = new Set<string>();
        for (const row of fixture.mobileSnapshot) {
            for (const part of row.parts) kinds.add(part.icon ?? part.color ?? '');
        }
        expect(fixture.mobileSnapshot.length).toBe(fixture.tasks.length * (Object.keys(fixture.configs).length + Object.keys(fixture.views).length - 1));
        expect(kinds).toEqual(new Set(['secondaryText', 'danger', 'warning', '#F59E0B', '#3B82F6', '#7C3AED', 'UserRound', 'Repeat', 'History', 'ListChecks', 'Paperclip']));
    });

    for (const row of fixture.mobileSnapshot) {
        it(`${row.config} ${row.view} ${row.task}`, () => {
            const config = fixture.configs[row.config];
            const view = fixture.views[row.view];
            const task = fixture.tasks.find((candidate) => candidate.id === row.task)!;
            const meta = buildTaskRowMeta({
                task,
                lookup: resolveTaskRowLookup(
                    task,
                    fixture.projects,
                    fixture.areas,
                    new Map(fixture.sections.map((section) => [section.id, section])),
                ),
                features: resolveTaskRowFeatures(config.settings),
                language: config.language,

                dateFormatting: {
                    language: config.settings.language || config.language,
                    dateFormat: config.settings.dateFormat,
                    calendarSystem: config.settings.calendarSystem,
                    timeFormat: config.settings.timeFormat,
                    systemLocale: config.systemLocale,
                },
                t: translators.get(config.language)!,
                now: new Date(fixture.now),
                hideProjectMeta: view.hideProjectMeta,
                hideContexts: view.hideContexts,
                hideChecklistProgress: view.hideChecklistProgress,
                projectDeadlineLabel: view.projectDeadlineLabel,
            });
            const { task: _task, config: _config, view: _view, ...expected } = row;
            expect(renderRow(meta, task, view)).toEqual(expected);
        });
    }
});

describe('buildTaskRowMeta', () => {
    const t = (key: string) => key;
    const base = {
        lookup: {},
        dateFormatting: {},
        features: { priorities: true, timeEstimates: true, timeSpent: true, taskAge: true },
        language: 'en' as Language,
        t,
    };
    const task = (patch: Partial<Task>): Task => ({
        id: 't', title: 'Task', status: 'next', tags: [], contexts: [],
        createdAt: '2026-09-01T10:00:00', updatedAt: '2026-09-01T10:00:00', ...patch,
    });

    it('reads urgency and age against the given now', () => {
        const meta = (now: Date) => buildTaskRowMeta({ ...base, now, task: task({ dueDate: '2026-09-23T15:00' }) });
        const dueTone = (value: TaskRowMeta) => value.parts.find((part) => part.kind === 'due');
        expect(dueTone(meta(new Date('2026-09-20T15:00')))).toMatchObject({ tone: 'normal' });
        expect(dueTone(meta(new Date('2026-09-22T15:00')))).toMatchObject({ tone: 'dueSoon' });
        expect(dueTone(meta(new Date('2026-09-24T15:00')))).toMatchObject({ tone: 'overdue' });
        expect(meta(new Date('2026-09-09T10:00')).ageLabel).toBe('1 week old');
    });

    it('shortens Focus dates while preserving exact field labels, default metadata and task data', () => {
        const row = task({ startTime: '2026-11-10T09:15:00', dueDate: '2026-11-12' });
        const original = JSON.stringify(row);
        const input = { ...base, task: row, now: new Date(2026, 10, 10, 12),
            dateFormatting: { language: 'en', dateFormat: 'ymd', timeFormat: '24h' } };
        const absolute = buildTaskRowMeta(input);
        const focus = buildTaskRowMeta({ ...input, relativeScheduleDates: true });
        expect(focus.relativeScheduleDates).toBe(true);
        expect(focus.parts.find((part) => part.kind === 'start')).toMatchObject({ text: 'Start: Today · 09:15' });
        expect(focus.parts.find((part) => part.kind === 'due')).toMatchObject({ text: 'Thursday', accessibilityLabel: 'Due: 2026-11-12' });
        expect(focus.accessibilityLabel).toContain('Start: 2026-11-10');
        expect(focus.accessibilityLabel).toContain('09:15');
        expect(focus.accessibilityLabel).toContain('Due: 2026-11-12');
        expect(focus.accessibilityLabel).not.toMatch(/Today|Thursday/);
        expect(absolute).not.toHaveProperty('relativeScheduleDates');
        expect(absolute.parts.find((part) => part.kind === 'start')?.text).toContain('2026-11-10');
        expect(absolute.parts.find((part) => part.kind === 'due')).not.toHaveProperty('accessibilityLabel');
        expect(JSON.stringify(row)).toBe(original);
    });

    it('uses the Project override for its dot while keeping overdue and priority tones', () => {
        const project: Project = { id: 'p', title: 'Project', status: 'active', color: '#3b82f6',
            colorOverride: '#10b981', areaId: 'a', order: 0, tagIds: [], createdAt: '', updatedAt: '' };
        const meta = buildTaskRowMeta({ ...base, task: task({ projectId: 'p', priority: 'urgent', dueDate: '2026-09-20' }),
            lookup: { project, projectArea: { id: 'a', name: 'Area', color: '#ef4444', order: 0, createdAt: '', updatedAt: '' } },
            now: new Date('2026-09-24T15:00') });
        expect(meta.parts.find((part) => part.kind === 'project')).toMatchObject({ dotColor: '#10b981' });
        expect(meta.parts.find((part) => part.kind === 'due')).toMatchObject({ tone: 'overdue' });
        expect(meta.priority).toBe('urgent');
    });

    it('gives a project or area with no color the grey default dot, like the group headers (#1422)', () => {
        const project: Project = { id: 'p', title: 'Plain', status: 'active', color: DEFAULT_AREA_COLOR, order: 0,
            tagIds: [], createdAt: '', updatedAt: '' };
        const area = { id: 'a', name: 'Area', order: 0, createdAt: '', updatedAt: '' };
        const inProject = buildTaskRowMeta({ ...base, task: task({ projectId: 'p' }), lookup: { project } }).parts;
        expect(inProject.find((part) => part.kind === 'project')).toMatchObject({ dotColor: DEFAULT_AREA_COLOR });
        const inArea = buildTaskRowMeta({ ...base, task: task({ areaId: 'a' }), lookup: { taskArea: area } }).parts;
        expect(inArea.find((part) => part.kind === 'area')).toMatchObject({ dotColor: DEFAULT_AREA_COLOR });
    });

    it('carries the sequence label only for the available cue', () => {
        const label = (sequenceCue: 'available' | 'later') => buildTaskRowMeta({
            ...base, task: task({}), sequenceCue, sequenceLabel: 'Available next action',
        }).accessibilityLabel;
        expect(label('available')).toBe('Task. Status: status.next. Available next action');
        expect(label('later')).toBe('Task. Status: status.next');
    });

    it('flags the status control hidden while the editor layout hides Status, as React Native and desktop rows do (#1405)', () => {
        const hidden = resolveTaskRowFeatures({ gtd: { taskEditor: { hidden: ['status'] } } });
        expect(hidden.status).toBe(false);
        const meta = buildTaskRowMeta({ ...base, features: hidden, task: task({}) });
        expect(meta.statusHidden).toBe(true);

        expect(meta.statusLabel).toBe('status.next');
        const shown = buildTaskRowMeta({ ...base, features: resolveTaskRowFeatures({ gtd: { taskEditor: { hidden: [] } } }), task: task({}) });
        expect(shown.statusHidden).toBe(false);
        expect(shown.statusLabel).toBe('status.next');
    });
});

describe('resolveTaskRowFeatures', () => {
    it('shows time spent only when Pomodoro is linked to tasks', () => {
        expect(resolveTaskRowFeatures(undefined)).toEqual({ priorities: true, timeEstimates: true, timeSpent: false, taskAge: false, status: true });
        expect(resolveTaskRowFeatures({ features: { pomodoro: true } }).timeSpent).toBe(false);
        expect(resolveTaskRowFeatures({ features: { pomodoro: true }, gtd: { pomodoro: { linkTask: true } } }).timeSpent).toBe(true);
    });
});


describe('getTaskRowMetaValidUntil', () => {
    const t = (key: string) => key;
    const features = resolveTaskRowFeatures({ appearance: { showTaskAge: true } });
    const meta = (task: Task, now: number) => buildTaskRowMeta({
        task, lookup: {}, features, language: 'en', dateFormatting: { language: 'en', systemLocale: 'en-US' }, t, now: new Date(now),
    });
    const now = Date.parse('2026-10-28T10:00:00.000Z');
    const hour = 60 * 60 * 1000;
    const task = (extra: Partial<Task>): Task => ({
        id: 't', title: 'Pay rent', status: 'next', tags: [], contexts: [], createdAt: '2026-10-20T09:30:00.000Z',
        updatedAt: '2026-10-20T09:30:00.000Z', ...extra,
    });

    it.each([
        ['due in 3 days (dueSoon next)', task({ dueDate: new Date(now + 80 * hour).toISOString() })],
        ['due in 5 hours (overdue next)', task({ dueDate: new Date(now + 5 * hour).toISOString() })],
        ['due tomorrow, a date only', task({ dueDate: '2026-10-29' })],
        ['overdue, its age next', task({ dueDate: new Date(now - hour).toISOString() })],
        ['no due date, its age next', task({})],
    ])('is the first instant the row reads differently: %s', (_name, row) => {
        const at = getTaskRowMetaValidUntil(row, new Date(now), features);
        expect(at).toBeGreaterThan(now);
        expect(meta(row, at! - 1)).toEqual(meta(row, now));
        expect(meta(row, at!)).not.toEqual(meta(row, now));
    });

    it('is null for a row the clock never changes', () => {
        const done = task({ status: 'done', dueDate: new Date(now + hour).toISOString(), completedAt: '2026-10-27T10:00:00.000Z' });
        expect(getTaskRowMetaValidUntil(done, new Date(now), features)).toBeNull();
        expect(getTaskRowMetaValidUntil(task({ dueDate: new Date(now - hour).toISOString() }), new Date(now), { ...features, taskAge: false })).toBeNull();
        expect(getTaskRowMetaValidUntil(task({ status: 'reference', dueDate: new Date(now + hour).toISOString() }), new Date(now), features)).toBeNull();
    });

    it('expires Start-only Focus wording at local midnight and leaves ordinary Start-only rows stable', () => {
        const before = new Date(2026, 10, 10, 23, 59);
        const midnight = new Date(2026, 10, 11);
        const row = task({ startTime: '2026-11-11' });
        const withoutAge = { ...features, taskAge: false };
        expect(getTaskRowMetaValidUntil(row, before, withoutAge)).toBeNull();
        expect(getTaskRowMetaValidUntil(row, before, withoutAge, { relativeScheduleDates: true })).toBe(midnight.getTime());
        const input = { task: row, lookup: {}, features: withoutAge, language: 'en' as const, dateFormatting: {}, t, relativeScheduleDates: true };
        expect(buildTaskRowMeta({ ...input, now: before }).parts.find((part) => part.kind === 'start')?.text).toBe('Start: Tomorrow');
        expect(buildTaskRowMeta({ ...input, now: midnight }).parts.find((part) => part.kind === 'start')?.text).toBe('Start: Today');
    });

    it('keeps an earlier due-tone transition ahead of the wording midnight', () => {
        const before = new Date(2026, 10, 10, 23, 59);
        const due = new Date(2026, 10, 10, 23, 59, 20);
        expect(getTaskRowMetaValidUntil(task({ startTime: '2026-11-11', dueDate: due.toISOString() }), before,
            { ...features, taskAge: false }, { relativeScheduleDates: true })).toBe(due.getTime() + 1);
    });
});

describe('eink row meta dots', () => {
    const base = {
        lookup: {},
        dateFormatting: {},
        features: { priorities: true, timeEstimates: true, timeSpent: true, taskAge: true },
        language: 'en' as const,
        t: (key: string) => key,
    };
    const task = (patch: Partial<Task>): Task => ({ id: 't', title: 'Task', status: 'next', tags: [], contexts: [], createdAt: '2026-09-01T10:00:00', updatedAt: '2026-09-01T10:00:00', ...patch });
    const project: Project = { id: 'p', title: 'Project', status: 'active', color: '#3b82f6', colorOverride: '#10b981', areaId: 'a', order: 0, tagIds: [], createdAt: '', updatedAt: '' };
    const area = { id: 'a', name: 'Area', color: '#ef4444' as string | undefined, order: 0, createdAt: '', updatedAt: '' } as never;

    it('draws project and area dots black on the eink preset and chromatic without it', () => {
        const projectMeta = buildTaskRowMeta({ ...base, task: task({ projectId: 'p' }),
            lookup: { project, projectArea: { id: 'a', name: 'Area', color: '#ef4444', order: 0, createdAt: '', updatedAt: '' } }, themePreset: 'eink' });
        expect(projectMeta.parts.find((part) => part.kind === 'project')?.dotColor).toBe('#000000');

        const areaMeta = buildTaskRowMeta({ ...base, task: task({ areaId: 'a' }), lookup: { taskArea: area }, themePreset: 'eink' });
        expect(areaMeta.parts.find((part) => part.kind === 'area')?.dotColor).toBe('#000000');

        const chromatic = buildTaskRowMeta({ ...base, task: task({ projectId: 'p' }),
            lookup: { project, projectArea: { id: 'a', name: 'Area', color: '#ef4444', order: 0, createdAt: '', updatedAt: '' } }, themePreset: 'light' });
        expect(chromatic.parts.find((part) => part.kind === 'project')?.dotColor).toBe('#10b981');
    });
});
