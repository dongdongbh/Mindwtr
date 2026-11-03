import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Virtualizer } from '@tanstack/react-virtual';
import type { Project, Task } from '@mindwtr/core';
import { buildGroupedVirtualRows, GroupedTaskList } from './GroupedTaskSections';
import type { TaskGroup } from './next-grouping';
import { buildSectionDomId } from './useTaskGroupCollapse';

const task = (id: string, title: string): Task => ({
    id,
    title,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
});

const groups: TaskGroup[] = [
    { id: '@home', title: '@home', tasks: [task('t1', 'Water the plants'), task('t2', 'Sort the post')] },
    { id: '@work', title: '@work', tasks: [task('t3', 'Draft the deck')] },
];

const getSectionDomId = (group: TaskGroup, index: number) => (
    buildSectionDomId('next-group', 'context', index, group.id)
);


const fakeVirtualizer = (rowCount: number) => ({
    getTotalSize: () => rowCount * 100,
    getVirtualItems: () => Array.from({ length: rowCount }, (_, index) => ({
        index,
        key: index,
        start: index * 100,
        size: 100,
        end: (index + 1) * 100,
        lane: 0,
    })),
    measureElement: () => {},
}) as unknown as Virtualizer<HTMLDivElement, Element>;

const renderGrouped = (collapsedGroupIds: Set<string>, virtualized: boolean) => {
    const virtualRows = buildGroupedVirtualRows(groups, collapsedGroupIds, getSectionDomId);
    const view = render(
        <GroupedTaskList
            groups={groups}
            tasks={groups.flatMap((group) => group.tasks)}
            virtualRows={virtualRows}
            virtualizer={virtualized ? fakeVirtualizer(virtualRows.length) : null}
            collapsedGroupIds={collapsedGroupIds}
            onToggleGroup={() => {}}
            getSectionDomId={getSectionDomId}
            renderTask={(item) => <div key={item.id} data-task-id={item.id}>{item.title}</div>}
        />,
    );
    const headers = view.getAllByRole('button').map((header) => ({
        name: header.textContent,
        expanded: header.getAttribute('aria-expanded'),


        cardTokens: ['border-border/40', 'bg-card/30'].filter((token) => (
            (header.className.includes('bg-card')
                ? header.className
                : header.closest('[class*="bg-card"]')?.className ?? ''
            ).includes(token)
        )),
    }));
    const titles = Array.from(document.querySelectorAll('[data-task-id]')).map((row) => row.textContent);
    view.unmount();
    return { headers, titles };
};

describe('GroupedTaskList', () => {


    it('renders the same groups, cards and section ids virtualized or not', () => {
        const plain = renderGrouped(new Set(), false);
        const virtualized = renderGrouped(new Set(), true);

        expect(plain.titles).toEqual(['Water the plants', 'Sort the post', 'Draft the deck']);
        expect(virtualized.titles).toEqual(plain.titles);
        expect(virtualized.headers.map((header) => header.name)).toEqual(plain.headers.map((header) => header.name));
        expect(virtualized.headers.map((header) => header.expanded)).toEqual(['true', 'true']);
        expect(plain.headers.map((header) => header.cardTokens)).toEqual([
            ['border-border/40', 'bg-card/30'],
            ['border-border/40', 'bg-card/30'],
        ]);
        expect(virtualized.headers.map((header) => header.cardTokens))
            .toEqual(plain.headers.map((header) => header.cardTokens));
    });

    it('keeps a collapsed group headed but empty at both sizes', () => {
        const plain = renderGrouped(new Set(['@home']), false);
        const virtualized = renderGrouped(new Set(['@home']), true);

        expect(plain.titles).toEqual(['Draft the deck']);
        expect(virtualized.titles).toEqual(plain.titles);
        expect(virtualized.headers.map((header) => header.expanded)).toEqual(['false', 'true']);
        expect(plain.headers.map((header) => header.expanded)).toEqual(['false', 'true']);
    });

    it.each([false, true])('points every group header at the section holding its rows (virtualized: %s)', (virtualized) => {
        const virtualRows = buildGroupedVirtualRows(groups, new Set(), getSectionDomId);
        const { getAllByRole } = render(
            <GroupedTaskList
                groups={groups}
                tasks={[]}
                virtualRows={virtualRows}
                virtualizer={virtualized ? fakeVirtualizer(virtualRows.length) : null}
                collapsedGroupIds={new Set()}
                onToggleGroup={() => {}}
                getSectionDomId={getSectionDomId}
                renderTask={(item) => <div key={item.id} data-task-id={item.id}>{item.title}</div>}
            />,
        );

        const [home, work] = getAllByRole('button');
        expect(home).toHaveAttribute('aria-controls', 'next-group-context-0-home');
        expect(work).toHaveAttribute('aria-controls', 'next-group-context-1-work');
        expect(within(document.getElementById('next-group-context-0-home')!).getByText('Water the plants'))
            .toBeInTheDocument();
    });


    it('registers every virtual row for re-measurement with the index the library reads (#825)', () => {
        const measured: Element[] = [];
        const virtualRows = buildGroupedVirtualRows(groups, new Set(), getSectionDomId);
        const virtualizer = {
            ...fakeVirtualizer(virtualRows.length),
            measureElement: (element: Element | null) => { if (element) measured.push(element); },
        } as unknown as Virtualizer<HTMLDivElement, Element>;

        const view = render(
            <GroupedTaskList
                groups={groups}
                tasks={groups.flatMap((group) => group.tasks)}
                virtualRows={virtualRows}
                virtualizer={virtualizer}
                collapsedGroupIds={new Set()}
                onToggleGroup={() => {}}
                getSectionDomId={getSectionDomId}
                renderTask={(item) => <div key={item.id} data-task-id={item.id}>{item.title}</div>}
            />,
        );


        expect(measured).toHaveLength(virtualRows.length);
        expect(measured.map((element) => element.getAttribute('data-index')))
            .toEqual(virtualRows.map((_row, index) => String(index)));

        view.unmount();
    });

    it('draws a group\'s projects above its tasks, virtualized or not, and hides them when collapsed (#1319)', () => {
        const project = { id: 'p1', title: 'Trip', status: 'someday', color: '#000', order: 0, tagIds: [],
            createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' } as Project;
        const withProjects: TaskGroup[] = [
            { ...groups[0], projects: [project] },
            { id: 'only', title: 'Only projects', tasks: [], projects: [project] },
        ];
        for (const virtualized of [false, true]) {
            for (const collapsed of [new Set<string>(), new Set(['@home'])]) {
                const virtualRows = buildGroupedVirtualRows(withProjects, collapsed, getSectionDomId);
                const view = render(
                    <GroupedTaskList
                        groups={withProjects}
                        tasks={withProjects.flatMap((group) => group.tasks)}
                        virtualRows={virtualRows}
                        virtualizer={virtualized ? fakeVirtualizer(virtualRows.length) : null}
                        collapsedGroupIds={collapsed}
                        onToggleGroup={() => {}}
                        getSectionDomId={getSectionDomId}
                        renderProject={(item) => <div data-project-id={item.id}>{item.title}</div>}
                        renderTask={(item) => <div key={item.id} data-task-id={item.id}>{item.title}</div>}
                    />,
                );
                const order = Array.from(view.container.querySelectorAll('[data-project-id], [data-task-id]'))
                    .map((node) => node.getAttribute('data-project-id') ?? node.getAttribute('data-task-id'));
                expect(order).toEqual(collapsed.size ? ['p1'] : ['p1', 't1', 't2', 'p1']);
                view.unmount();
            }
        }
    });

    it('counts a section\'s projects in its header, so a projects-only section is not "0" (#1319)', () => {
        const project = { id: 'p1', title: 'Trip', status: 'someday', color: '#000', order: 0, tagIds: [],
            createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' } as Project;
        const onlyProjects: TaskGroup[] = [{ id: 'only', title: 'Only projects', tasks: [], projects: [project] }];
        const view = render(
            <GroupedTaskList
                groups={onlyProjects}
                tasks={[]}
                virtualRows={buildGroupedVirtualRows(onlyProjects, new Set(), getSectionDomId)}
                virtualizer={null}
                collapsedGroupIds={new Set()}
                onToggleGroup={() => {}}
                getSectionDomId={getSectionDomId}
                renderProject={(item) => <div data-project-id={item.id}>{item.title}</div>}
                renderTask={(item) => <div key={item.id}>{item.title}</div>}
            />,
        );
        const header = view.getByText('Only projects').closest('button, div') as HTMLElement;
        expect(within(header.parentElement as HTMLElement).getByText('1')).toBeTruthy();
        view.unmount();
    });

    it('renders a flat list without cards when there is no grouping', () => {
        const { container, queryAllByRole } = render(
            <GroupedTaskList
                groups={[]}
                tasks={[task('t1', 'Water the plants'), task('t2', 'Sort the post')]}
                virtualRows={null}
                virtualizer={null}
                renderTask={(item) => <div key={item.id} data-task-id={item.id}>{item.title}</div>}
            />,
        );

        expect(queryAllByRole('button')).toHaveLength(0);
        expect(Array.from(container.querySelectorAll('[data-task-id]')).map((row) => row.textContent))
            .toEqual(['Water the plants', 'Sort the post']);
    });
});
