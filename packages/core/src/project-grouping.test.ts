import { describe, expect, it } from 'vitest';

import { AREA_FILTER_NONE } from './area-filter';
import { buildProjectGroups, getProjectMoveOptions, planProjectMove } from './project-grouping';
import type { Area, Project } from './types';

const now = '2026-08-09T00:00:00.000Z';

const area = (id: string, order: number): Area => ({
    id,
    name: id,
    order,
    createdAt: now,
    updatedAt: now,
});

const project = (
    id: string,
    status: Project['status'],
    options: Partial<Project> = {},
): Project => ({
    id,
    title: options.title ?? id,
    status,
    order: options.order ?? 0,
    tagIds: options.tagIds ?? [],
    createdAt: now,
    updatedAt: now,
    ...options,
});

describe('buildProjectGroups', () => {
    it('classifies and orders visible projects under the supplied Area order, with no-area last', () => {
        const home = area('home', 0);
        const work = area('work', 1);
        const result = buildProjectGroups({
            projects: [
                project('home-later', 'active', { areaId: home.id, order: 2, title: 'Later' }),
                project('work-waiting', 'waiting', { areaId: work.id }),
                project('home-first', 'active', { areaId: home.id, order: 1, title: 'First' }),
                project('archived', 'archived', { areaId: work.id }),
                project('someday', 'someday'),
                project('missing-area', 'active', { areaId: 'missing' }),
                project('deleted', 'active', { areaId: work.id, deletedAt: now }),
            ],

            orderedAreas: [work, home],
            areaFilter: { included: [], excluded: [] },
            tagFilter: { kind: 'all' },
        });

        expect(result.active.map((group) => [
            group.areaId,
            group.projects.map((entry) => entry.id),
        ])).toEqual([
            ['home', ['home-first', 'home-later']],
            [undefined, ['missing-area']],
        ]);
        expect(result.deferred.map((group) => [
            group.areaId,
            group.projects.map((entry) => entry.id),
        ])).toEqual([
            ['work', ['work-waiting']],
            [undefined, ['someday']],
        ]);
        expect(result.archived.map((group) => [
            group.areaId,
            group.projects.map((entry) => entry.id),
        ])).toEqual([
            ['work', ['archived']],
        ]);
    });

    it('filters through semantic tag choices while keeping the full visible tag inventory', () => {
        const work = area('work', 0);
        const projects = [
            project('alpha', 'active', { areaId: work.id, tagIds: ['#alpha', '#shared'] }),
            project('beta', 'active', { areaId: work.id, tagIds: ['#beta', '#shared'] }),
            project('untagged', 'active', { areaId: work.id }),
            project('deleted', 'active', { areaId: work.id, tagIds: ['#deleted'], deletedAt: now }),
        ];
        const base = {
            projects,
            orderedAreas: [work],
            areaFilter: { included: [], excluded: [] },
        };

        const tagged = buildProjectGroups({
            ...base,
            tagFilter: { kind: 'tag', value: '#shared' },
        });
        const untagged = buildProjectGroups({
            ...base,
            tagFilter: { kind: 'untagged' },
        });

        expect(tagged.active[0]?.projects.map((entry) => entry.id)).toEqual(['alpha', 'beta']);
        expect(untagged.active[0]?.projects.map((entry) => entry.id)).toEqual(['untagged']);
        expect(tagged.tagInventory).toEqual({
            values: ['#alpha', '#beta', '#shared'],
            hasUntagged: true,
        });
        expect(untagged.tagInventory).toEqual(tagged.tagInventory);
    });

    it('normalizes missing Areas to no-area and lets Area exclusion win over inclusion', () => {
        const work = area('work', 0);
        const result = buildProjectGroups({
            projects: [
                project('work', 'active', { areaId: work.id }),
                project('missing', 'active', { areaId: 'missing' }),
                project('unassigned', 'active'),
            ],
            orderedAreas: [work],
            areaFilter: {
                included: [work.id, AREA_FILTER_NONE],
                excluded: [work.id],
            },
            tagFilter: { kind: 'all' },
        });

        expect(result.active).toEqual([{
            areaId: undefined,
            projects: expect.arrayContaining([
                expect.objectContaining({ id: 'missing' }),
                expect.objectContaining({ id: 'unassigned' }),
            ]),
        }]);
        expect(result.active[0]?.projects.map((entry) => entry.id)).toEqual(['missing', 'unassigned']);
    });

    it('pins starred projects to the top of their own area group only when asked (#1263)', () => {
        const home = area('home', 0);
        const work = area('work', 1);
        const projects = [
            project('home-first', 'active', { areaId: 'home', order: 0 }),
            project('home-starred', 'active', { areaId: 'home', order: 5, isFocused: true }),
            project('work-starred-late', 'active', { areaId: 'work', order: 9, isFocused: true }),
            project('work-starred-early', 'active', { areaId: 'work', order: 2, isFocused: true }),
            project('work-plain', 'active', { areaId: 'work', order: 1 }),
        ];
        const input = { projects, orderedAreas: [home, work], areaFilter: { included: [], excluded: [] }, tagFilter: { kind: 'all' as const } };
        const ids = (groups: ReturnType<typeof buildProjectGroups>) => groups.active.map((group) => group.projects.map((item) => item.id));


        expect(ids(buildProjectGroups(input))).toEqual([
            ['home-first', 'home-starred'],
            ['work-plain', 'work-starred-early', 'work-starred-late'],
        ]);

        expect(ids(buildProjectGroups({ ...input, pinFocused: true }))).toEqual([
            ['home-starred', 'home-first'],
            ['work-starred-early', 'work-starred-late', 'work-plain'],
        ]);
    });

    it('treats non-finite order as zero without mutating caller arrays', () => {
        const work = area('work', 0);
        const projects = [
            project('later', 'active', { areaId: work.id, order: 2 }),
            project('zero-zed', 'active', { areaId: work.id, order: Number.NaN, title: 'Zed' }),
            project('zero-alpha', 'active', { areaId: work.id, order: 0, title: 'Alpha' }),
        ];
        const originalIds = projects.map((entry) => entry.id);
        const orderedAreas = [work];

        const result = buildProjectGroups({
            projects,
            orderedAreas,
            areaFilter: { included: [], excluded: [] },
            tagFilter: { kind: 'all' },
        });

        expect(result.active[0]?.projects.map((entry) => entry.id)).toEqual([
            'zero-alpha',
            'zero-zed',
            'later',
        ]);
        expect(projects.map((entry) => entry.id)).toEqual(originalIds);
        expect(orderedAreas).toEqual([work]);
    });
});

describe('planProjectMove', () => {
    const home = area('home', 0);
    const projects = [
        project('starred', 'active', { areaId: home.id, order: 4, isFocused: true }),
        project('a', 'active', { areaId: home.id, order: 1 }),
        project('parked', 'someday', { areaId: home.id, order: 2 }),
        project('b', 'active', { areaId: home.id, order: 3 }),
        project('elsewhere', 'active', { order: 0 }),
    ];
    const shown = buildProjectGroups({
        projects, orderedAreas: [home], areaFilter: { included: [], excluded: [] }, tagFilter: { kind: 'all' }, pinFocused: true,
    }).active[0];

    it('swaps a project with its shown neighbour in the area stored order', () => {
        expect(shown.projects.map((item) => item.id)).toEqual(['starred', 'a', 'b']);

        expect(planProjectMove(shown, projects, 'b', 'up')).toEqual({
            areaId: 'home',
            orderedIds: ['b', 'parked', 'a', 'starred'],
        });
    });

    it('never moves a project past one with a different star state, or past an edge', () => {
        expect(planProjectMove(shown, projects, 'a', 'up')).toBeNull();
        expect(planProjectMove(shown, projects, 'starred', 'down')).toBeNull();
        expect(planProjectMove(shown, projects, 'b', 'down')).toBeNull();
    });
});


describe('getProjectMoveOptions', () => {
    it('offers a move only past a shown neighbour with the same star and the same stored area', () => {
        const home = area('home', 0);
        const rows = [project('s1', 'active', { areaId: home.id, isFocused: true }), project('s2', 'active', { areaId: home.id, isFocused: true }),
            project('a', 'active', { areaId: home.id })];
        expect(getProjectMoveOptions({ areaId: home.id, projects: rows })).toEqual([
            { up: false, down: true }, { up: true, down: false }, { up: false, down: false }]);

        const orphan = [project('none', 'active'), project('orphan', 'active', { areaId: 'deleted-area' }), project('none2', 'active')];
        expect(getProjectMoveOptions({ projects: orphan })).toEqual([{ up: false, down: false }, { up: false, down: false }, { up: false, down: false }]);
        expect(planProjectMove({ projects: orphan }, orphan, 'none2', 'up')).toBeNull();
    });
});
