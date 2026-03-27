import type { AppData, Area, Project, Section, Task } from './types';

export const createMockTask = (id: string, updatedAt: string, deletedAt?: string): Task => ({
    id,
    title: `Task ${id}`,
    status: 'inbox',
    updatedAt,
    createdAt: '2023-01-01T00:00:00.000Z',
    tags: [],
    contexts: [],
    deletedAt,
});

export const createMockProject = (id: string, updatedAt: string, deletedAt?: string): Project => ({
    id,
    title: `Project ${id}`,
    status: 'active',
    color: '#000000',
    order: 0,
    tagIds: [],
    updatedAt,
    createdAt: '2023-01-01T00:00:00.000Z',
    deletedAt,
});

export const createMockSection = (id: string, projectId: string, updatedAt: string, deletedAt?: string): Section => ({
    id,
    projectId,
    title: `Section ${id}`,
    description: '',
    order: 0,
    isCollapsed: false,
    updatedAt,
    createdAt: '2023-01-01T00:00:00.000Z',
    deletedAt,
});

export const createMockArea = (id: string, updatedAt: string, deletedAt?: string): Area => ({
    id,
    name: `Area ${id}`,
    order: 0,
    createdAt: '2023-01-01T00:00:00.000Z',
    updatedAt,
    deletedAt,
});

export const mockAppData = (tasks: Task[] = [], projects: Project[] = [], sections: Section[] = []): AppData => ({
    tasks,
    projects,
    sections,
    areas: [],
    settings: {},
});
