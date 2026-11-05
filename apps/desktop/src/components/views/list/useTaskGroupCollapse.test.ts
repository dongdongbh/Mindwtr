import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Task } from '@mindwtr/core';
import { buildGroupedVirtualRows } from './GroupedTaskSections';
import type { CollapsedGroups, TaskGroup } from './next-grouping';
import { buildSectionDomId, getGroupDomIdSegment, useTaskGroupCollapse } from './useTaskGroupCollapse';

const task = (id: string): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
});

const group = (id: string, tasks: Task[]): TaskGroup => ({ id, title: id, tasks });

describe('getGroupDomIdSegment', () => {
    it('replaces runs of unsafe characters with a single dash', () => {
        expect(getGroupDomIdSegment('Home & Garden / Chores')).toBe('Home-Garden-Chores');
    });

    it('strips leading and trailing dashes so a separator-led title stays a valid id', () => {
        expect(getGroupDomIdSegment('- Later')).toBe('Later');
        expect(getGroupDomIdSegment('Later —')).toBe('Later');
    });

    it('falls back to a name for a title made only of unsafe characters', () => {
        expect(getGroupDomIdSegment('•••')).toBe('group');
    });
});


describe('buildSectionDomId', () => {
    it('gives every view the same id for the same group, apart from its prefix', () => {
        const ids = ['next-group', 'archived-group', 'agenda-next-group'].map((prefix) => (
            buildSectionDomId(prefix, 'project', 2, '- Later')
        ));

        expect(ids).toEqual([
            'next-group-project-2-Later',
            'archived-group-project-2-Later',
            'agenda-next-group-project-2-Later',
        ]);
    });
});

describe('buildGroupedVirtualRows', () => {
    const groups = [group('alpha', [task('a1'), task('a2')]), group('beta', [task('b1')])];

    it('emits a header and then the group rows, marking the first and last', () => {
        const rows = buildGroupedVirtualRows(groups, new Set());

        expect(rows.map((row) => (row.kind === 'header' ? `header:${row.group.id}` : `task:${row.task.id}`))).toEqual([
            'header:alpha',
            'task:a1',
            'task:a2',
            'header:beta',
            'task:b1',
        ]);
        const alphaTasks = rows.filter((row) => row.kind === 'task' && row.group.id === 'alpha');
        expect(alphaTasks.map((row) => row.kind === 'task' && [row.isFirst, row.isLast])).toEqual([
            [true, false],
            [false, true],
        ]);
    });

    it('drops the rows of a collapsed group but keeps its header', () => {
        const rows = buildGroupedVirtualRows(groups, new Set(['alpha']));

        expect(rows.map((row) => (row.kind === 'header' ? `header:${row.group.id}` : `task:${row.task.id}`))).toEqual([
            'header:alpha',
            'header:beta',
            'task:b1',
        ]);
        expect(rows[0].kind === 'header' && rows[0].collapsed).toBe(true);
    });

    it('hands every row of a group the section id its header controls', () => {
        const rows = buildGroupedVirtualRows(groups, new Set(), (taskGroup, index) => (
            buildSectionDomId('next-group', 'project', index, taskGroup.id)
        ));

        expect(rows.map((row) => row.controlsId)).toEqual([
            'next-group-project-0-alpha',
            'next-group-project-0-alpha',
            'next-group-project-0-alpha',
            'next-group-project-1-beta',
            'next-group-project-1-beta',
        ]);
    });

    it('leaves out section ids when the caller does not build them', () => {
        expect(buildGroupedVirtualRows(groups, new Set()).every((row) => row.controlsId === undefined)).toBe(true);
    });
});


describe('useTaskGroupCollapse', () => {
    const groups = [group('alpha', [task('a1'), task('a2')])];
    const tasks = [task('a1'), task('a2')];
    const options = (axis: 'none' | 'project') => ({
        axis,
        groups: axis === 'none' ? [] : groups,
        tasks,
        idPrefix: 'next-group',
        collapsedGroups: { project: [] } as CollapsedGroups<'none' | 'project'>,
        setCollapsedGroups: () => {},
    });

    it('returns no row model at all when the list is not grouped', () => {
        const { result } = renderHook(() => useTaskGroupCollapse(options('none')));

        expect(result.current.isGrouping).toBe(false);
        expect(result.current.virtualRows).toBeNull();
        expect(result.current.visibleTasks).toEqual(tasks);
    });

    it('returns the header and task rows when the list is grouped', () => {
        const { result } = renderHook(() => useTaskGroupCollapse(options('project')));

        expect(result.current.isGrouping).toBe(true);
        expect(result.current.virtualRows?.map((row) => row.kind)).toEqual(['header', 'task', 'task']);
        expect(result.current.virtualRows?.[0].kind === 'header'
            && result.current.virtualRows?.[0].controlsId).toBe('next-group-project-0-alpha');
    });
});
