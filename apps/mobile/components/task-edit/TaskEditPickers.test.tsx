import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { TaskEditAreaPicker } from './TaskEditAreaPicker';
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
