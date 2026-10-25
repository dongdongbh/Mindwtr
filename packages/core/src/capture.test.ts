import { describe, expect, it, vi } from 'vitest';
import type { Area, Project } from './types';
import {
    applyCapturedProject,
    buildCaptureTaskProps,
    executeCaptureTransaction,
    filterCaptureAreas,
    filterCaptureProjects,
    hasExactCaptureAreaMatch,
    hasExactCaptureProjectMatch,
    planCaptureTask,
    resolveCaptureAreaQuery,
    resolveCaptureProjectQuery,
} from './capture';

const makeProject = (overrides: Partial<Project>): Project => ({
    id: 'project-1',
    title: 'Launch',
    color: '#3b82f6',
    order: 0,
    status: 'active',
    tagIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

const parsedBase = { title: 'Write brief', props: {}, projectTitle: undefined, detectedDate: undefined, invalidDateCommands: undefined };

const makeArea = (overrides: Partial<Area>): Area => ({
    id: 'area-1',
    name: 'Work',
    color: '#3b82f6',
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

describe('buildCaptureTaskProps', () => {
    it('defaults to an inbox capture with the parsed title', () => {
        const result = buildCaptureTaskProps({ parsed: parsedBase, rawInput: 'Write brief', projects: [] });
        expect(result).toMatchObject({ ok: true, title: 'Write brief', props: { status: 'inbox' } });
    });

    it('walks the title fallback chain and refuses an empty capture', () => {
        const noTitle = { ...parsedBase, title: '' };
        expect(buildCaptureTaskProps({ parsed: noTitle, rawInput: '  ', fallbackTitle: 'Screenshot', projects: [] }))
            .toMatchObject({ ok: true, title: 'Screenshot' });
        expect(buildCaptureTaskProps({ parsed: noTitle, rawInput: ' ', projects: [] }))
            .toEqual({ ok: false, reason: 'empty-title' });
    });

    it('reuses a selectable project matched by +Project title', () => {
        const active = makeProject({ id: 'p-active', title: 'Launch' });
        const result = buildCaptureTaskProps({
            parsed: { ...parsedBase, projectTitle: 'launch' },
            rawInput: 'Write brief +Launch',
            projects: [active],
        });
        expect(result).toMatchObject({ ok: true, props: { projectId: 'p-active' } });
        expect((result as { projectToCreate?: unknown }).projectToCreate).toBeUndefined();
    });

    it('requests a fresh project when the title matches only an archived project — the capture is never dropped', () => {
        const archived = makeProject({ id: 'p-archived', title: 'Launch', status: 'archived' });
        const result = buildCaptureTaskProps({
            parsed: { ...parsedBase, projectTitle: 'Launch' },
            rawInput: 'Write brief +Launch',
            projects: [archived],
        });
        expect(result).toMatchObject({
            ok: true,
            projectToCreate: { title: 'Launch' },
        });
        expect((result as { props: { projectId?: string } }).props.projectId).toBeUndefined();
    });

    it('drops a parsed projectId that is no longer assignable', () => {
        const archived = makeProject({ id: 'p-archived', status: 'archived' });
        const result = buildCaptureTaskProps({
            parsed: { ...parsedBase, props: { projectId: 'p-archived' } },
            rawInput: 'Write brief',
            projects: [archived],
            selectedAreaId: 'area-1',
        });
        expect(result).toMatchObject({ ok: true, props: { areaId: 'area-1' } });
        expect((result as { props: { projectId?: string } }).props.projectId).toBeUndefined();
    });

    it('keeps Container exclusivity: a project home clears the area fallback', () => {
        const active = makeProject({ id: 'p-active' });
        const withProject = buildCaptureTaskProps({
            parsed: { ...parsedBase, props: { projectId: 'p-active' } },
            rawInput: 'x',
            projects: [active],
            selectedAreaId: 'area-1',
        });
        expect(withProject).toMatchObject({ ok: true, props: { projectId: 'p-active', areaId: undefined } });

        const pendingCreate = buildCaptureTaskProps({
            parsed: { ...parsedBase, projectTitle: 'Brand new' },
            rawInput: 'x +Brand new',
            projects: [],
            selectedAreaId: 'area-1',
        });
        expect((pendingCreate as { props: { areaId?: string } }).props.areaId).toBeUndefined();
    });

    it('applies the detected natural-language date only when nothing explicit set one', () => {
        const detected = { date: '2026-08-01', matchedText: 'aug 1', titleWithoutDate: 'Pay rent' };
        const applied = buildCaptureTaskProps({
            parsed: { ...parsedBase, title: 'Pay rent aug 1', detectedDate: detected },
            rawInput: 'Pay rent aug 1',
            projects: [],
        });
        expect(applied).toMatchObject({ ok: true, title: 'Pay rent', props: { dueDate: '2026-08-01' } });

        const suppressed = buildCaptureTaskProps({
            parsed: { ...parsedBase, title: 'Pay rent aug 1', detectedDate: detected },
            rawInput: 'Pay rent aug 1',
            projects: [],
            suppressDetectedDate: true,
        });
        expect(suppressed).toMatchObject({ ok: true, title: 'Pay rent aug 1' });
        expect((suppressed as { props: { dueDate?: string } }).props.dueDate).toBeUndefined();
    });

    it('preserve mode: detected date applies while the title stays verbatim (quick capture default)', () => {
        // In preserve mode quick-add hands back titleWithoutDate = verbatim
        // title, so the capture keeps the typed text AND gets the due date.
        const detected = { date: '2026-08-01', matchedText: 'aug 1', titleWithoutDate: 'Pay rent aug 1' };
        const applied = buildCaptureTaskProps({
            parsed: { ...parsedBase, title: 'Pay rent aug 1', detectedDate: detected },
            rawInput: 'Pay rent aug 1',
            projects: [],
        });
        expect(applied).toMatchObject({ ok: true, title: 'Pay rent aug 1', props: { dueDate: '2026-08-01' } });
    });

    it('stars the capture and leaves the gating to the store', () => {
        const result = buildCaptureTaskProps({
            parsed: parsedBase,
            rawInput: 'x',
            projects: [],
            starNewTask: true,
        });
        expect(result).toMatchObject({ ok: true, props: { isFocusedToday: true } });
    });
});

describe('buildCaptureTaskProps project fallback', () => {
    it('falls back to the surface project when the parsed +Project is unassignable', () => {
        const archived = makeProject({ id: 'p-archived', status: 'archived' });
        const current = makeProject({ id: 'p-current', title: 'Current' });
        const result = buildCaptureTaskProps({
            parsed: { ...parsedBase, props: { projectId: 'p-archived' } },
            rawInput: 'x',
            projects: [archived, current],
            initialProps: { projectId: 'p-current' },
        });
        expect(result).toMatchObject({ ok: true, props: { projectId: 'p-current' } });
    });
});

describe('applyCapturedProject', () => {
    it('attaches the created project and clears the direct area', () => {
        expect(applyCapturedProject({ status: 'inbox', areaId: 'area-1' }, 'p-new'))
            .toEqual({ status: 'inbox', areaId: undefined, projectId: 'p-new' });
    });
});

describe('executeCaptureTransaction', () => {
    it('creates a missing project, enforces Container exclusivity, then writes the task', async () => {
        const createdProject = makeProject({ id: 'p-new', title: 'Launch' });
        const addProject = vi.fn(async () => createdProject);
        const addTask = vi.fn(async () => ({ success: true, id: 'task-1' }));

        const result = await executeCaptureTransaction({
            parsed: { ...parsedBase, projectTitle: 'Launch' },
            rawInput: 'Write brief +Launch',
            projects: [],
            selectedAreaId: 'area-1',
        }, { addProject, addTask });

        expect(addProject).toHaveBeenCalledWith('Launch', '#94a3b8', { areaId: 'area-1' });
        expect(addTask).toHaveBeenCalledWith('Write brief', {
            status: 'inbox',
            areaId: undefined,
            projectId: 'p-new',
        });
        expect(result).toMatchObject({
            success: true,
            createdProject,
            createdTaskId: 'task-1',
            props: { projectId: 'p-new', areaId: undefined },
        });
    });

    it('lets an explicit surface project win without creating an orphan project', async () => {
        const addProject = vi.fn();
        const addTask = vi.fn(async () => ({ success: true, id: 'task-1' }));

        const result = await executeCaptureTransaction({
            parsed: { ...parsedBase, projectTitle: 'Typed project' },
            rawInput: 'Write brief +Typed project',
            projects: [],
            selectedAreaId: 'area-1',
        }, { addProject, addTask }, {
            transformProps: (props) => ({ ...props, projectId: 'picked-project', areaId: 'area-1' }),
        });

        expect(addProject).not.toHaveBeenCalled();
        expect(addTask).toHaveBeenCalledWith('Write brief', expect.objectContaining({
            projectId: 'picked-project',
            areaId: undefined,
        }));
        expect(result).toMatchObject({ success: true, props: { projectId: 'picked-project', areaId: undefined } });
    });

    it('returns an explicit project failure and never writes the task', async () => {
        const addTask = vi.fn();
        const result = await executeCaptureTransaction({
            parsed: { ...parsedBase, projectTitle: 'Launch' },
            rawInput: 'Write brief +Launch',
            projects: [],
        }, {
            addProject: vi.fn(async () => null),
            addTask,
        });

        expect(result).toEqual({
            success: false,
            reason: 'project-create-failed',
            error: 'Failed to create project',
        });
        expect(addTask).not.toHaveBeenCalled();
    });

    it('returns the task-store failure with the prepared capture outcome', async () => {
        const createdProject = makeProject({ id: 'p-new', title: 'Launch' });
        const result = await executeCaptureTransaction({
            parsed: { ...parsedBase, projectTitle: 'Launch' },
            rawInput: 'Write brief +Launch',
            projects: [],
        }, {
            addProject: vi.fn(async () => createdProject),
            addTask: vi.fn(async () => ({ success: false, error: 'Disk full' })),
        });

        expect(result).toMatchObject({
            success: false,
            reason: 'task-create-failed',
            error: 'Disk full',
            createdProject,
            title: 'Write brief',
            props: { projectId: 'p-new' },
        });
    });

    it('rejects invalid date commands and empty captures before either write', async () => {
        const actions = { addProject: vi.fn(), addTask: vi.fn() };
        const invalid = await executeCaptureTransaction({
            parsed: { ...parsedBase, invalidDateCommands: ['/due:nope'] },
            rawInput: 'Write brief /due:nope',
            projects: [],
        }, actions);
        const empty = await executeCaptureTransaction({
            parsed: { ...parsedBase, title: '' },
            rawInput: ' ',
            projects: [],
        }, actions);

        expect(invalid).toEqual({
            success: false,
            reason: 'invalid-date-command',
            invalidDateCommands: ['/due:nope'],
        });
        expect(empty).toEqual({ success: false, reason: 'empty-title' });
        expect(actions.addProject).not.toHaveBeenCalled();
        expect(actions.addTask).not.toHaveBeenCalled();
    });

    it('converts thrown store errors into the same explicit failure contract', async () => {
        const result = await executeCaptureTransaction({
            parsed: parsedBase,
            rawInput: 'Write brief',
            projects: [],
        }, {
            addProject: vi.fn(),
            addTask: vi.fn(async () => { throw new Error('Storage unavailable'); }),
        });

        expect(result).toMatchObject({
            success: false,
            reason: 'task-create-failed',
            error: 'Storage unavailable',
            title: 'Write brief',
        });
    });
});

describe('capture picker helpers', () => {
    it('filters assignable projects by selected area and query', () => {
        const visible = makeProject({ id: 'p-visible', title: 'Launch Plan', areaId: 'area-1' });
        const otherArea = makeProject({ id: 'p-other', title: 'Launch Ops', areaId: 'area-2' });
        const archived = makeProject({ id: 'p-archived', title: 'Launch Archive', areaId: 'area-1', status: 'archived' });
        expect(filterCaptureProjects([visible, otherArea, archived], { selectedAreaId: 'area-1', query: 'plan' }))
            .toEqual([visible]);
    });

    it('treats an archived exact project-title match as createable, not selected', () => {
        const archived = makeProject({ id: 'p-archived', title: 'Launch', status: 'archived' });
        expect(hasExactCaptureProjectMatch([archived], 'Launch')).toBe(false);
        expect(resolveCaptureProjectQuery([archived], 'Launch', 'area-1')).toMatchObject({
            kind: 'create',
            projectToCreate: { title: 'Launch', initialProps: { areaId: 'area-1' } },
        });
    });

    it('selects an assignable exact project-title match', () => {
        const project = makeProject({ id: 'p-active', title: 'Launch' });
        expect(hasExactCaptureProjectMatch([project], 'launch')).toBe(true);
        expect(resolveCaptureProjectQuery([project], 'launch')).toMatchObject({
            kind: 'select',
            project: { id: 'p-active' },
        });
    });

    it('filters live areas and treats deleted exact area-name matches as createable', () => {
        const live = makeArea({ id: 'area-live', name: 'Work' });
        const deleted = makeArea({ id: 'area-deleted', name: 'Archive', deletedAt: '2026-01-02T00:00:00.000Z' });
        expect(filterCaptureAreas([live, deleted], 'wor')).toEqual([live]);
        expect(hasExactCaptureAreaMatch([deleted], 'Archive')).toBe(false);
        expect(resolveCaptureAreaQuery([deleted], 'Archive')).toMatchObject({
            kind: 'create',
            areaToCreate: { name: 'Archive' },
        });
    });

    it('selects a live exact area-name match', () => {
        const area = makeArea({ id: 'area-live', name: 'Work' });
        expect(hasExactCaptureAreaMatch([area], 'work')).toBe(true);
        expect(resolveCaptureAreaQuery([area], 'work')).toMatchObject({
            kind: 'select',
            area: { id: 'area-live' },
        });
    });
});

describe('planCaptureTask start date status (#1452)', () => {
    const start = '2026-11-02';
    const plan = (
        input: Partial<Parameters<typeof planCaptureTask>[0]>,
        transformProps?: Parameters<typeof planCaptureTask>[1]['transformProps'],
    ) => planCaptureTask({ parsed: parsedBase, rawInput: 'Write brief', projects: [], ...input }, { transformProps });

    it('files an untouched default with a start date into Next and keeps the date', () => {
        expect(plan({ parsed: { ...parsedBase, props: { startTime: start } } }))
            .toMatchObject({ success: true, props: { status: 'next', startTime: start } });
    });

    it('treats a surface-prefilled Inbox as a default, and sees a start date a picker adds', () => {
        expect(plan({ initialProps: { status: 'inbox' } }, (props) => ({ ...props, startTime: start })))
            .toMatchObject({ success: true, props: { status: 'next', startTime: start } });
    });

    it('keeps a status the user chose, including Inbox', () => {
        expect(plan({ parsed: { ...parsedBase, props: { status: 'inbox', startTime: start } } }))
            .toMatchObject({ success: true, props: { status: 'inbox' } });
        expect(plan({ initialProps: { status: 'inbox' }, extraProps: { status: 'inbox', startTime: start } }))
            .toMatchObject({ success: true, props: { status: 'inbox' } });
    });

    it('keeps a contextual destination such as Someday', () => {
        expect(plan({ initialProps: { status: 'someday', startTime: start } }))
            .toMatchObject({ success: true, props: { status: 'someday' } });
    });

    it('leaves Inbox alone when only a due or review date is set', () => {
        expect(plan({ parsed: { ...parsedBase, props: { dueDate: start, reviewAt: start } } }))
            .toMatchObject({ success: true, props: { status: 'inbox' } });
    });
});
