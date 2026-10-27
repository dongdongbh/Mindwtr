import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { Area } from '@mindwtr/core';

import { TaskEditAreaPicker } from './TaskEditAreaPicker';
import { TaskEditDestinationPicker } from './TaskEditDestinationPicker';
import { TaskEditProjectPicker } from './TaskEditProjectPicker';
import { TaskEditSectionPicker } from './TaskEditSectionPicker';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tc = {
    cardBg: '#111',
    border: '#333',
    text: '#fff',
    inputBg: '#111',
    secondaryText: '#aaa',
    tint: '#3b82f6',
};

const deferred = <T,>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
};

describe('Task edit pickers', () => {
    it.each([
        { label: 'both', allowProjects: true, allowAreas: true, projectVisible: true, areaVisible: true },
        { label: 'Project only', allowProjects: true, allowAreas: false, projectVisible: true, areaVisible: false },
        { label: 'Area only', allowProjects: false, allowAreas: true, projectVisible: false, areaVisible: true },
        { label: 'neither', allowProjects: false, allowAreas: false, projectVisible: false, areaVisible: false },
    ])('limits Destination choices to the visible organization kinds: $label', ({
        allowProjects,
        allowAreas,
        projectVisible,
        areaVisible,
    }) => {
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditDestinationPicker
                    visible
                    projects={[{ id: 'project-1', title: 'Project One' }] as any}
                    areas={[{ id: 'area-1', name: 'Area One' }] as any}
                    allowProjects={allowProjects}
                    allowAreas={allowAreas}
                    tc={{ ...tc, danger: '#f00' } as any}
                    t={(key) => key}
                    onClose={vi.fn()}
                    onSelect={vi.fn()}
                />
            );
        });

        const optionLabels = tree.root
            .findAll((node) => node.props.accessibilityRole === 'button')
            .map((node) => node.props.accessibilityLabel);
        expect(optionLabels).toContain('common.none');
        expect(optionLabels.includes('nav.projects: Project One')).toBe(projectVisible);
        expect(optionLabels.includes('taskEdit.areaLabel: Area One')).toBe(areaVisible);
    });

    it('adds modal accessibility metadata to the area picker', () => {
        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditAreaPicker
                    visible
                    areas={[]}
                    tc={tc as any}
                    t={(key) => key}
                    onClose={vi.fn()}
                    onSelectArea={vi.fn()}
                    onCreateArea={vi.fn().mockResolvedValue(null)}
                />
            );
        });

        const modal = tree!.root.find(
            (node) => node.props.accessibilityViewIsModal === true
        );
        const title = tree!.root.find(
            (node) => node.props.accessibilityRole === 'header' && node.props.children === 'taskEdit.areaLabel'
        );
        const input = tree!.root.find(
            (node) => node.props.accessibilityLabel === 'taskEdit.areaLabel' && node.props.accessibilityHint === 'common.search'
        );

        expect(modal.props.accessibilityViewIsModal).toBe(true);
        expect(title).toBeTruthy();
        expect(input).toBeTruthy();
    });

    it('keeps configured area order through search without mutating the supplied areas (#1217)', () => {
        const areas = Object.freeze([
            {
                id: 'apple',
                name: 'Apple',
                order: 1,
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            },
            {
                id: 'azure',
                name: 'Azure',
                order: 1,
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            },
            {
                id: 'deleted',
                name: 'Archived area',
                order: -1,
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
                deletedAt: '2025-01-02T00:00:00.000Z',
            },
            {
                id: 'zebra',
                name: 'Zebra',
                order: 0,
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            },
            {
                id: 'z-unset',
                name: 'Zed unset',
                order: Number.NaN,
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            },
            {
                id: 'a-unset',
                name: 'Alpha unset',
                order: Number.NaN,
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            },
        ]);
        const originalIds = areas.map((area) => area.id);
        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditAreaPicker
                    visible
                    areas={areas as unknown as Area[]}
                    tc={tc as any}
                    t={(key) => key}
                    onClose={vi.fn()}
                    onSelectArea={vi.fn()}
                    onCreateArea={vi.fn().mockResolvedValue(null)}
                />
            );
        });

        const optionLabels = () => tree!.root
            .findAll((node) => node.props.accessibilityRole === 'button' && typeof node.type === 'string')
            .map((node) => node.props.accessibilityLabel)
            .filter((label) => ['taskEdit.noAreaOption', 'Apple', 'Azure', 'Archived area', 'Zebra', 'Alpha unset', 'Zed unset'].includes(label));

        expect(optionLabels()).toEqual(['taskEdit.noAreaOption', 'Zebra', 'Apple', 'Azure', 'Alpha unset', 'Zed unset']);
        const input = tree!.root.findByProps({ accessibilityLabel: 'taskEdit.areaLabel' });
        act(() => {
            input.props.onChangeText('a');
        });
        expect(optionLabels()).toEqual(['taskEdit.noAreaOption', 'Zebra', 'Apple', 'Azure', 'Alpha unset']);
        expect(areas.map((area) => area.id)).toEqual(originalIds);
    });

    it('announces section search misses', () => {
        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditSectionPicker
                    visible
                    sections={[
                        {
                            id: 'section-1',
                            projectId: 'project-1',
                            title: 'Backlog',
                            order: 0,
                            createdAt: '2025-01-01T00:00:00.000Z',
                            updatedAt: '2025-01-01T00:00:00.000Z',
                        },
                    ]}
                    projectId="project-1"
                    tc={tc as any}
                    t={(key) => key}
                    onClose={vi.fn()}
                    onSelectSection={vi.fn()}
                    onCreateSection={vi.fn().mockResolvedValue(null)}
                />
            );
        });

        const input = tree!.root.find(
            (node) => node.props.accessibilityLabel === 'taskEdit.sectionLabel'
        );

        act(() => {
            input.props.onChangeText('zzz');
        });

        const emptyMessage = tree!.root.find(
            (node) => node.props.accessibilityLiveRegion === 'polite' && node.props.children === 'common.noMatches'
        );

        expect(emptyMessage).toBeTruthy();
    });

    it('lists active projects first, then Someday / Waiting under a heading, in both project pickers (#1467)', () => {
        const project = (id: string, title: string, status: string, order: number) => ({
            id, title, status, color: '#3b82f6', order, tagIds: [], createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
        }) as any;
        const projects = [project('s', 'Someday one', 'someday', 0), project('a', 'Active one', 'active', 1), project('w', 'Waiting one', 'waiting', 2)];
        const sequence = (tree: renderer.ReactTestRenderer) => tree.root
            .findAll((node) => typeof node.type === 'string' && (node.props.accessibilityRole === 'header' || node.props.accessibilityRole === 'button'))
            .map((node) => node.props.accessibilityRole === 'header' ? `# ${React.Children.toArray(node.props.children).join('')}` : node.props.accessibilityLabel);
        let projectTree!: renderer.ReactTestRenderer;
        let destinationTree!: renderer.ReactTestRenderer;
        act(() => {
            projectTree = renderer.create(
                <TaskEditProjectPicker visible projects={projects} tc={tc as any} t={(key) => key}
                    onClose={vi.fn()} onSelectProject={vi.fn()} onCreateProject={vi.fn().mockResolvedValue(null)} />,
            );
            destinationTree = renderer.create(
                <TaskEditDestinationPicker visible projects={projects} areas={[]} allowAreas={false}
                    tc={{ ...tc, danger: '#f00' } as any} t={(key) => key} onClose={vi.fn()} onSelect={vi.fn()} />,
            );
        });
        const projectRows = sequence(projectTree).filter((label) => label !== 'taskEdit.projectLabel');
        expect(projectRows.slice(projectRows.indexOf('Active one'), projectRows.indexOf('Waiting one') + 1))
            .toEqual(['Active one', '# Someday / Waiting', 'Someday one', 'Waiting one']);
        const destinationRows = sequence(destinationTree);
        expect(destinationRows.slice(destinationRows.indexOf('nav.projects: Active one'), destinationRows.indexOf('nav.projects: Waiting one') + 1))
            .toEqual(['nav.projects: Active one', 'nav.projects: Someday one', 'nav.projects: Waiting one']);
        expect(destinationTree.root.findAll((node) => typeof node.type === 'string'
            && React.Children.toArray(node.props.children).join('') === 'Someday / Waiting')).toHaveLength(1);
        // The heading sits between the active and the deferred rows.
        const texts = destinationTree.root.findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string')
            .map((node) => node.props.children as string);
        expect(texts.indexOf('Active one') < texts.indexOf('Someday / Waiting') && texts.indexOf('Someday / Waiting') < texts.indexOf('Someday one')).toBe(true);
    });

    it('hides archived and legacy completed projects from task assignment choices', () => {
        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditProjectPicker
                    visible
                    projects={[
                        {
                            id: 'project-active',
                            title: 'Active Project',
                            status: 'active',
                            color: '#3b82f6',
                            order: 0,
                            tagIds: [],
                            createdAt: '2025-01-01T00:00:00.000Z',
                            updatedAt: '2025-01-01T00:00:00.000Z',
                        },
                        {
                            id: 'project-archived',
                            title: 'Archived Project',
                            status: 'archived',
                            color: '#64748b',
                            order: 1,
                            tagIds: [],
                            createdAt: '2025-01-01T00:00:00.000Z',
                            updatedAt: '2025-01-01T00:00:00.000Z',
                        },
                        {
                            id: 'project-completed',
                            title: 'Completed Project',
                            status: 'completed' as any,
                            color: '#64748b',
                            order: 2,
                            tagIds: [],
                            createdAt: '2025-01-01T00:00:00.000Z',
                            updatedAt: '2025-01-01T00:00:00.000Z',
                        },
                    ]}
                    tc={tc as any}
                    t={(key) => key}
                    onClose={vi.fn()}
                    onSelectProject={vi.fn()}
                    onCreateProject={vi.fn().mockResolvedValue(null)}
                />
            );
        });

        expect(tree!.root.findByProps({ accessibilityLabel: 'Active Project' })).toBeTruthy();
        expect(tree!.root.findAll((node) => node.props.accessibilityLabel === 'Archived Project')).toHaveLength(0);
        expect(tree!.root.findAll((node) => node.props.accessibilityLabel === 'Completed Project')).toHaveLength(0);
    });

    it('searches every selectable project while the browse list stays area-scoped (#987)', () => {
        const inArea = {
            id: 'project-in-area',
            title: 'In Area Project',
            status: 'active' as const,
            color: '#3b82f6',
            order: 0,
            tagIds: [],
            areaId: 'area-1',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };
        const outOfArea = { ...inArea, id: 'project-other-area', title: 'Other Area Project', order: 1, areaId: 'area-2' };
        const archivedElsewhere = {
            ...inArea,
            id: 'project-archived',
            title: 'Archived Elsewhere',
            status: 'archived' as const,
            order: 2,
            areaId: 'area-2',
        };
        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditProjectPicker
                    visible
                    projects={[inArea]}
                    allProjects={[inArea, outOfArea, archivedElsewhere]}
                    tc={tc as any}
                    t={(key) => key}
                    onClose={vi.fn()}
                    onSelectProject={vi.fn()}
                    onCreateProject={vi.fn().mockResolvedValue(null)}
                />
            );
        });

        const root = tree!.root;
        const findLabelled = (label: string) => root.findAll((node) => node.props.accessibilityLabel === label);
        const input = root.find(
            (node) => node.props.accessibilityLabel === 'taskEdit.projectLabel' && node.props.accessibilityHint === 'common.search'
        );

        expect(findLabelled('In Area Project').length).toBeGreaterThan(0);
        expect(findLabelled('Other Area Project')).toHaveLength(0);

        act(() => {
            input.props.onChangeText('Other');
        });
        expect(findLabelled('Other Area Project').length).toBeGreaterThan(0);

        act(() => {
            input.props.onChangeText('Archived');
        });
        expect(findLabelled('Archived Elsewhere')).toHaveLength(0);

        act(() => {
            input.props.onChangeText('');
        });
        expect(findLabelled('Other Area Project')).toHaveLength(0);
    });

    it('keeps project creation open while pending, ignores repeat submits, and allows retry after null', async () => {
        const firstCreate = deferred<null>();
        const createdProject = {
            id: 'project-new',
            title: 'New Project',
            status: 'active' as const,
            color: '#3b82f6',
            order: 0,
            tagIds: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };
        const onCreateProject = vi.fn()
            .mockReturnValueOnce(firstCreate.promise)
            .mockResolvedValueOnce(createdProject);
        const onClose = vi.fn();
        const onSelectProject = vi.fn();
        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditProjectPicker
                    visible
                    projects={[]}
                    tc={tc as any}
                    t={(key) => key === 'projects.createFailed' ? 'Failed to create project' : key}
                    onClose={onClose}
                    onSelectProject={onSelectProject}
                    onCreateProject={onCreateProject}
                />
            );
        });

        const input = tree!.root.findByProps({ accessibilityLabel: 'taskEdit.projectLabel' });
        act(() => {
            input.props.onChangeText('New Project');
        });
        const createButton = () => tree!.root.findByProps({ accessibilityLabel: 'projects.create: New Project' });
        act(() => {
            void createButton().props.onPress();
            void createButton().props.onPress();
        });

        expect(onCreateProject).toHaveBeenCalledTimes(1);
        expect(createButton().props.accessibilityState).toEqual({ disabled: true, busy: true });
        expect(tree!.root.findByProps({ accessibilityLabel: 'common.cancel' }).props.disabled).toBe(true);

        await act(async () => {
            firstCreate.resolve(null);
            await firstCreate.promise;
        });
        expect(onClose).not.toHaveBeenCalled();
        expect(onSelectProject).not.toHaveBeenCalled();
        expect(tree!.root.findByProps({ testID: 'project-create-error' }).props.children)
            .toBe('Failed to create project');

        await act(async () => {
            await createButton().props.onPress();
        });
        expect(onCreateProject).toHaveBeenCalledTimes(2);
        expect(onSelectProject).toHaveBeenCalledWith('project-new');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('shows an area creation rejection without clearing the query and succeeds on retry', async () => {
        const createdArea = {
            id: 'area-new',
            name: 'Errands',
            order: 0,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };
        const onCreateArea = vi.fn()
            .mockRejectedValueOnce(new Error('save failed'))
            .mockResolvedValueOnce(createdArea);
        const onClose = vi.fn();
        const onSelectArea = vi.fn();
        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditAreaPicker
                    visible
                    areas={[]}
                    tc={tc as any}
                    t={(key) => key === 'projects.createAreaFailed' ? 'Failed to create area' : key}
                    onClose={onClose}
                    onSelectArea={onSelectArea}
                    onCreateArea={onCreateArea}
                />
            );
        });

        const input = tree!.root.findByProps({ accessibilityLabel: 'taskEdit.areaLabel' });
        act(() => {
            input.props.onChangeText('Errands');
        });
        const createButton = () => tree!.root.findByProps({ accessibilityLabel: 'areas.create: Errands' });
        await act(async () => {
            await createButton().props.onPress();
        });

        expect(onClose).not.toHaveBeenCalled();
        expect(onSelectArea).not.toHaveBeenCalled();
        expect(input.props.value).toBe('Errands');
        expect(tree!.root.findByProps({ testID: 'area-create-error' }).props.children)
            .toBe('Failed to create area');

        await act(async () => {
            await createButton().props.onPress();
        });
        expect(onCreateArea).toHaveBeenCalledTimes(2);
        expect(onSelectArea).toHaveBeenCalledWith('area-new');
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
