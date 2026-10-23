import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureDateFormatting } from './date';
import { loadTranslations } from './i18n/i18n-loader';
import type { Language } from './i18n/i18n-types';
import { buildTaskRowMeta, resolveTaskRowFeatures, resolveTaskRowLookup, type TaskRowMeta, type TaskRowMetaPart } from './task-row-meta';
import { getProjectRowStatus } from './project-row-meta';
import { TASK_PRIORITY_COLORS } from './color-constants';
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

// How the mobile row drew each part at snapshot time: its text nodes, the first text's
// color (theme tokens by name, stylesheet colors as literals), the dot and the icon.
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
            // The mobile language context's `t`.
            translators.set(config.language, (key) => map[key] || english[key] || key);
        }
    });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
        configureDateFormatting();
    });
    // The function must format with the configuration it is given, so the global
    // one is set to something no fixture configuration uses.
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
                // What the mobile root layout passed to configureDateFormatting.
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

    it('carries the sequence label only for the available cue', () => {
        const label = (sequenceCue: 'available' | 'later') => buildTaskRowMeta({
            ...base, task: task({}), sequenceCue, sequenceLabel: 'Available next action',
        }).accessibilityLabel;
        expect(label('available')).toBe('Task. Status: status.next. Available next action');
        expect(label('later')).toBe('Task. Status: status.next');
    });
});

describe('resolveTaskRowFeatures', () => {
    it('shows time spent only when Pomodoro is linked to tasks', () => {
        expect(resolveTaskRowFeatures(undefined)).toEqual({ priorities: true, timeEstimates: true, timeSpent: false, taskAge: false });
        expect(resolveTaskRowFeatures({ features: { pomodoro: true } }).timeSpent).toBe(false);
        expect(resolveTaskRowFeatures({ features: { pomodoro: true }, gtd: { pomodoro: { linkTask: true } } }).timeSpent).toBe(true);
    });
});
