import { afterEach, describe, expect, it, vi } from 'vitest';

// RN's convertTaskToSection, frozen from HEAD 3dd0d4514 (before the shared planner): ids and the clock are pinned, so the
// whole store result is compared, byte for byte.
let ids = 0;
vi.mock('./uuid', async (importActual) => ({
    ...(await importActual<typeof import('./uuid')>()),
    generateUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
}));

import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Section, Task } from './types';

const at = '2026-10-01T12:00:00.000Z';
const project = (id: string, patch: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: at, updatedAt: at, ...patch,
});
const section = (id: string, projectId: string, order: number, patch: Partial<Section> = {}): Section => ({
    id, projectId, title: id, order, createdAt: at, updatedAt: at, ...patch,
});
const task = (id: string, patch: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', tags: [], contexts: [], createdAt: at, updatedAt: at, ...patch,
});

async function open(data: AppData) {
    await flushPendingSave();
    resetForTests();
    setStorageAdapter({ getData: async () => structuredClone(data), saveData: async () => undefined });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
        error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
}

afterEach(async () => {
    vi.useRealTimers();
    await flushPendingSave();
    resetForTests();
});

describe('convertTaskToSection (RN store) frozen fixture', () => {
    it('writes the same section, checklist tasks, deleted source and settings as HEAD', async () => {
        await open({
            tasks: [
                task('source', { title: '  Pack the kitchen ', description: ' Boxes are in the garage. ', projectId: 'p',
                    sectionId: 's-old', order: 3, orderNum: 3, rev: 4, revBy: 'other', tags: ['#home', '#new'], contexts: ['@house'],
                    checklist: [
                        { id: 'c1', title: ' Wrap the glasses ', isCompleted: true },
                        { id: 'c2', title: '   ', isCompleted: false },
                        { id: 'c3', title: 'Empty the fridge', isCompleted: false },
                    ] }),
                task('sibling', { projectId: 'p', order: 7, orderNum: 7 }),
                task('gone', { projectId: 'p', order: 40, orderNum: 40, deletedAt: at }),
                task('elsewhere', { projectId: 'q', order: 90, orderNum: 90 }),
            ],
            projects: [project('p'), project('q')],
            sections: [section('s-old', 'p', 2), section('s-deleted', 'p', 9, { deletedAt: at }), section('s-q', 'q', 50)],
            areas: [], people: [],
            settings: { deviceId: 'device-a', analyticsProfileId: 'profile', taskReminderDefault: 'skip' },
        });
        ids = 0;
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-26T09:30:00.000Z'));
        const result = await useTaskStore.getState().convertTaskToSection('source');
        vi.useRealTimers();
        const state = useTaskStore.getState();
        const { migrations: _migrations, ...settings } = state.settings;
        expect(JSON.parse(JSON.stringify({ result, tasks: state._allTasks, sections: state._allSections,
            settings }))).toMatchInlineSnapshot(`
              {
                "result": {
                  "id": "00000000-0000-4000-8000-000000000001",
                  "success": true,
                },
                "sections": [
                  {
                    "createdAt": "2026-10-01T12:00:00.000Z",
                    "id": "s-old",
                    "order": 2,
                    "projectId": "p",
                    "title": "s-old",
                    "updatedAt": "2026-10-01T12:00:00.000Z",
                  },
                  {
                    "createdAt": "2026-10-01T12:00:00.000Z",
                    "deletedAt": "2026-10-01T12:00:00.000Z",
                    "id": "s-deleted",
                    "order": 9,
                    "projectId": "p",
                    "title": "s-deleted",
                    "updatedAt": "2026-10-01T12:00:00.000Z",
                  },
                  {
                    "createdAt": "2026-10-01T12:00:00.000Z",
                    "id": "s-q",
                    "order": 50,
                    "projectId": "q",
                    "title": "s-q",
                    "updatedAt": "2026-10-01T12:00:00.000Z",
                  },
                  {
                    "createdAt": "2026-10-26T09:30:00.000Z",
                    "description": "Boxes are in the garage.",
                    "id": "00000000-0000-4000-8000-000000000001",
                    "isCollapsed": false,
                    "order": 3,
                    "projectId": "p",
                    "rev": 1,
                    "revBy": "device-a",
                    "title": "Pack the kitchen",
                    "updatedAt": "2026-10-26T09:30:00.000Z",
                  },
                ],
                "settings": {
                  "analyticsProfileId": "profile",
                  "deviceId": "device-a",
                  "gtd": {
                    "focusGroupByDefaultsVersion": 1,
                    "taskEditor": {
                      "defaultsVersion": 5,
                      "hidden": [
                        "section",
                        "priority",
                        "energyLevel",
                        "timeEstimate",
                        "assignedTo",
                        "location",
                      ],
                    },
                  },
                  "taskReminderDefault": "skip",
                  "taxonomy": {
                    "contexts": [
                      {
                        "rev": 1,
                        "revBy": "device-a",
                        "token": "@house",
                        "updatedAt": "2026-10-26T09:30:00.000Z",
                      },
                    ],
                    "tags": [
                      {
                        "rev": 1,
                        "revBy": "device-a",
                        "token": "#home",
                        "updatedAt": "2026-10-26T09:30:00.000Z",
                      },
                      {
                        "rev": 1,
                        "revBy": "device-a",
                        "token": "#new",
                        "updatedAt": "2026-10-26T09:30:00.000Z",
                      },
                    ],
                  },
                },
                "tasks": [
                  {
                    "checklist": [
                      {
                        "id": "c1",
                        "isCompleted": true,
                        "title": " Wrap the glasses ",
                      },
                      {
                        "id": "c2",
                        "isCompleted": false,
                        "title": "   ",
                      },
                      {
                        "id": "c3",
                        "isCompleted": false,
                        "title": "Empty the fridge",
                      },
                    ],
                    "contexts": [
                      "@house",
                    ],
                    "createdAt": "2026-10-01T12:00:00.000Z",
                    "deletedAt": "2026-10-26T09:30:00.000Z",
                    "description": " Boxes are in the garage. ",
                    "id": "source",
                    "order": 3,
                    "orderNum": 3,
                    "projectId": "p",
                    "pushCount": 0,
                    "rev": 5,
                    "revBy": "device-a",
                    "sectionId": "s-old",
                    "status": "next",
                    "tags": [
                      "#home",
                      "#new",
                    ],
                    "title": "  Pack the kitchen ",
                    "updatedAt": "2026-10-26T09:30:00.000Z",
                  },
                  {
                    "contexts": [],
                    "createdAt": "2026-10-01T12:00:00.000Z",
                    "id": "sibling",
                    "order": 7,
                    "orderNum": 7,
                    "projectId": "p",
                    "pushCount": 0,
                    "rev": 0,
                    "status": "next",
                    "tags": [],
                    "title": "sibling",
                    "updatedAt": "2026-10-01T12:00:00.000Z",
                  },
                  {
                    "contexts": [],
                    "createdAt": "2026-10-01T12:00:00.000Z",
                    "deletedAt": "2026-10-01T12:00:00.000Z",
                    "id": "gone",
                    "order": 40,
                    "orderNum": 40,
                    "projectId": "p",
                    "pushCount": 0,
                    "rev": 0,
                    "status": "next",
                    "tags": [],
                    "title": "gone",
                    "updatedAt": "2026-10-01T12:00:00.000Z",
                  },
                  {
                    "contexts": [],
                    "createdAt": "2026-10-01T12:00:00.000Z",
                    "id": "elsewhere",
                    "order": 90,
                    "orderNum": 90,
                    "projectId": "q",
                    "pushCount": 0,
                    "rev": 0,
                    "status": "next",
                    "tags": [],
                    "title": "elsewhere",
                    "updatedAt": "2026-10-01T12:00:00.000Z",
                  },
                  {
                    "completedAt": "2026-10-26T09:30:00.000Z",
                    "contexts": [],
                    "createdAt": "2026-10-26T09:30:00.000Z",
                    "id": "00000000-0000-4000-8000-000000000002",
                    "isFocusedToday": false,
                    "order": 8,
                    "orderNum": 8,
                    "projectId": "p",
                    "pushCount": 0,
                    "reminderPolicy": "inherit",
                    "rev": 1,
                    "revBy": "device-a",
                    "sectionId": "00000000-0000-4000-8000-000000000001",
                    "status": "done",
                    "suppressMindwtrReminders": true,
                    "tags": [],
                    "taskMode": "task",
                    "title": "Wrap the glasses",
                    "updatedAt": "2026-10-26T09:30:00.000Z",
                  },
                  {
                    "contexts": [],
                    "createdAt": "2026-10-26T09:30:00.000Z",
                    "id": "00000000-0000-4000-8000-000000000003",
                    "isFocusedToday": false,
                    "order": 9,
                    "orderNum": 9,
                    "projectId": "p",
                    "pushCount": 0,
                    "reminderPolicy": "inherit",
                    "rev": 1,
                    "revBy": "device-a",
                    "sectionId": "00000000-0000-4000-8000-000000000001",
                    "status": "next",
                    "suppressMindwtrReminders": true,
                    "tags": [],
                    "taskMode": "task",
                    "title": "Empty the fridge",
                    "updatedAt": "2026-10-26T09:30:00.000Z",
                  },
                ],
              }
            `);
    });

    it('refuses a task without a project with RN\'s message and writes nothing', async () => {
        await open({ tasks: [task('loose')], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'd' } });
        const before = useTaskStore.getState()._allTasks;
        expect(await useTaskStore.getState().convertTaskToSection('loose')).toEqual({ success: false, error: 'Task is not in a project' });
        expect(useTaskStore.getState()._allTasks).toBe(before);
    });
});
