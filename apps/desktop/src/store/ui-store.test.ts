import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DONE_AXES, FOCUS_AXES, REFERENCE_AXES, SOMEDAY_AXES } from '../components/views/list/next-grouping';

// The `===` chains these sanitizers used before the rosters were unified,
// copied verbatim. Shipped builds persisted exactly what these accepted, so
// anything they accept must still hydrate — a narrower roster would silently
// reset a real user's saved grouping on next launch.
const legacyAcceptedNextGroupBy = (value: unknown): boolean => (
    value === 'none'
    || value === 'context'
    || value === 'area'
    || value === 'project'
    || value === 'energy'
    || value === 'priority'
    || value === 'person'
    || value === 'tag'
);

const legacyAcceptedReferenceGroupBy = (value: unknown): boolean => (
    value === 'none'
    || value === 'context'
    || value === 'area'
    || value === 'project'
    || value === 'tag'
);

async function hydrate(stored: Record<string, unknown>) {
    window.localStorage.clear();
    vi.resetModules();
    window.localStorage.setItem('mindwtr:list-options:v1', JSON.stringify(stored));
    const { useUiStore } = await import('./ui-store');
    return useUiStore.getState().listOptions;
}

describe('useUiStore list options', () => {
    beforeEach(() => {
        window.localStorage.clear();
        vi.resetModules();
    });

    it('hydrates persisted Focus/list view options', async () => {
        window.localStorage.setItem('mindwtr:list-options:v1', JSON.stringify({
            showDetails: true,
            nextGroupBy: 'project',
            referenceGroupBy: 'context',
            focusTop3Only: true,
        }));

        const { useUiStore } = await import('./ui-store');

        expect(useUiStore.getState().listOptions).toEqual({
            showDetails: true,
            // Written before the per-view split (#1063): every list seeds from
            // the one axis the blob has, so nothing looks reset after upgrade.
            focusGroupBy: 'project',
            inboxGroupBy: 'project',
            nextGroupBy: 'project',
            waitingGroupBy: 'project',
            somedayGroupBy: 'project',
            referenceGroupBy: 'context',
            // Written by a build that predates the Done and Archive axes:
            // defaulted, not undefined.
            doneGroupBy: 'none',
            archivedGroupBy: 'none',
            focusTop3Only: true,
        });
    });

    it('persists Focus/list view options on change', async () => {
        const { LIST_OPTIONS_STORAGE_KEY, useUiStore } = await import('./ui-store');

        useUiStore.getState().setListOptions({
            showDetails: true,
            focusGroupBy: 'energy',
            inboxGroupBy: 'context',
            nextGroupBy: 'project',
            waitingGroupBy: 'person',
            somedayGroupBy: 'area',
            referenceGroupBy: 'tag',
            doneGroupBy: 'completedDate',
            doneSortBy: 'completed',
            archivedGroupBy: 'project',
            archivedSortBy: 'completed',
            focusTop3Only: true,
        });

        expect(JSON.parse(window.localStorage.getItem(LIST_OPTIONS_STORAGE_KEY) || '{}')).toEqual({
            showDetails: true,
            focusGroupBy: 'energy',
            inboxGroupBy: 'context',
            nextGroupBy: 'project',
            waitingGroupBy: 'person',
            somedayGroupBy: 'area',
            referenceGroupBy: 'tag',
            doneGroupBy: 'completedDate',
            doneSortBy: 'completed',
            archivedGroupBy: 'project',
            archivedSortBy: 'completed',
            focusTop3Only: true,
        });
    });

    it('hydrates every axis a shipped build could have persisted', async () => {
        for (const axis of FOCUS_AXES) {
            expect((await hydrate({ nextGroupBy: axis })).nextGroupBy).toBe(axis);
        }
        for (const axis of REFERENCE_AXES) {
            expect((await hydrate({ referenceGroupBy: axis })).referenceGroupBy).toBe(axis);
        }
        for (const axis of DONE_AXES) {
            expect((await hydrate({ doneGroupBy: axis })).doneGroupBy).toBe(axis);
        }
        for (const axis of SOMEDAY_AXES) {
            expect((await hydrate({ somedayGroupBy: axis })).somedayGroupBy).toBe(axis);
        }
    // One module reload per axis (13) — well under a second idle, but the
    // default 5s timeout is not enough when another suite has the CPU.
    }, 20000);

    it('accepts exactly what the pre-roster === chains accepted', () => {
        const candidates: unknown[] = [
            'none', 'context', 'area', 'project', 'tag', 'energy', 'priority', 'person',
            'status', 'due', '', ' none', 'NONE', null, undefined, 0, 1, true, [], {}, ['none'],
        ];

        for (const candidate of candidates) {
            expect([candidate, FOCUS_AXES.includes(candidate as never)])
                .toEqual([candidate, legacyAcceptedNextGroupBy(candidate)]);
            expect([candidate, REFERENCE_AXES.includes(candidate as never)])
                .toEqual([candidate, legacyAcceptedReferenceGroupBy(candidate)]);
        }
    });

    it('falls back for a stored axis outside the roster', async () => {
        const options = await hydrate({ nextGroupBy: 'status', referenceGroupBy: 'energy' });

        expect(options.nextGroupBy).toBe('none');
        expect(options.referenceGroupBy).toBe('area');
    });
});

describe('useUiStore per-view grouping axes (#1063)', () => {
    beforeEach(() => {
        window.localStorage.clear();
        vi.resetModules();
    });

    it('round-trips a separate axis per list', async () => {
        const options = await hydrate({
            focusGroupBy: 'energy',
            inboxGroupBy: 'context',
            nextGroupBy: 'project',
            waitingGroupBy: 'person',
            somedayGroupBy: 'area',
        });

        expect(options).toMatchObject({
            focusGroupBy: 'energy',
            inboxGroupBy: 'context',
            nextGroupBy: 'project',
            waitingGroupBy: 'person',
            somedayGroupBy: 'area',
        });
    });

    it('round-trips the Someday section axis without replacing the project axis', async () => {
        expect(SOMEDAY_AXES).toContain('project');
        expect((await hydrate({ somedayGroupBy: 'viewSection' })).somedayGroupBy).toBe('viewSection');
    });

    // Before the split every list read nextGroupBy, so an upgrade that ignored
    // it would read as "the app forgot my grouping" on four views at once.
    it('seeds every new axis from the legacy shared key', async () => {
        const options = await hydrate({ nextGroupBy: 'project' });

        expect(options.focusGroupBy).toBe('project');
        expect(options.inboxGroupBy).toBe('project');
        expect(options.nextGroupBy).toBe('project');
        expect(options.waitingGroupBy).toBe('project');
        expect(options.somedayGroupBy).toBe('project');
    });

    it('falls back to the default for a new axis outside the roster', async () => {
        const options = await hydrate({ nextGroupBy: 'project', inboxGroupBy: 'status' });

        expect(options.inboxGroupBy).toBe('none');
        expect(options.nextGroupBy).toBe('project');
    });
});

describe('useUiStore project layouts (#1019)', () => {
    beforeEach(() => {
        window.localStorage.clear();
        vi.resetModules();
    });

    it('hydrates the per-project layout and drops entries it does not recognize', async () => {
        window.localStorage.setItem('mindwtr:project-layouts:v1', JSON.stringify({
            'project-1': 'columns',
            'project-2': 'list',
            'project-3': 'kanban',
            'project-4': 7,
        }));

        const { useUiStore } = await import('./ui-store');

        expect(useUiStore.getState().projectLayouts).toEqual({
            'project-1': 'columns',
            'project-2': 'list',
        });
    });

    it('persists a layout change without disturbing other projects', async () => {
        window.localStorage.setItem('mindwtr:project-layouts:v1', JSON.stringify({ 'project-1': 'columns' }));
        const { PROJECT_LAYOUTS_STORAGE_KEY, useUiStore } = await import('./ui-store');

        useUiStore.getState().setProjectLayout('project-2', 'columns');

        expect(JSON.parse(window.localStorage.getItem(PROJECT_LAYOUTS_STORAGE_KEY) || '{}')).toEqual({
            'project-1': 'columns',
            'project-2': 'columns',
        });
    });

    it('prunes an unknown project id once the store has real project data (#U8)', async () => {
        window.localStorage.setItem('mindwtr:project-layouts:v1', JSON.stringify({
            'known-project': 'list',
            'deleted-project': 'columns',
        }));
        const { PROJECT_LAYOUTS_STORAGE_KEY, useUiStore } = await import('./ui-store');
        const { useTaskStore } = await import('@mindwtr/core');
        useTaskStore.setState({ _allProjects: [{ id: 'known-project' }] as never });

        useUiStore.getState().setProjectLayout('known-project', 'columns');

        expect(useUiStore.getState().projectLayouts).toEqual({ 'known-project': 'columns' });
        expect(JSON.parse(window.localStorage.getItem(PROJECT_LAYOUTS_STORAGE_KEY) || '{}')).toEqual({
            'known-project': 'columns',
        });
    });

    it('does not prune anything before the store has loaded real project data', async () => {
        window.localStorage.setItem('mindwtr:project-layouts:v1', JSON.stringify({ 'orphan-project': 'columns' }));
        const { PROJECT_LAYOUTS_STORAGE_KEY, useUiStore } = await import('./ui-store');

        useUiStore.getState().setProjectLayout('another-project', 'list');

        expect(JSON.parse(window.localStorage.getItem(PROJECT_LAYOUTS_STORAGE_KEY) || '{}')).toEqual({
            'orphan-project': 'columns',
            'another-project': 'list',
        });
    });
});

describe('useUiStore hidden sidebar views', () => {
    it('hydrates only hideable roster ids and persists changes', async () => {
        window.localStorage.clear();
        vi.resetModules();
        window.localStorage.setItem('mindwtr:sidebar:hiddenViews:v1', JSON.stringify(['someday', 'inbox', 42]));
        const { useUiStore } = await import('./ui-store');
        // 'inbox' is structural and 42 is junk — neither may hydrate.
        expect(useUiStore.getState().hiddenSidebarViews).toEqual(['someday']);

        useUiStore.getState().setSidebarViewHidden('board', true);
        expect(JSON.parse(window.localStorage.getItem('mindwtr:sidebar:hiddenViews:v1')!)).toEqual(['someday', 'board']);

        useUiStore.getState().setSidebarViewHidden('someday', false);
        expect(useUiStore.getState().hiddenSidebarViews).toEqual(['board']);
    });
});
