import { describe, expect, it } from 'vitest';
import { sanitizeAppDataForRemote } from './sync-helpers';
import { TASK_SQLITE_COLUMNS, taskFromSqliteRow, taskToSqliteRow } from './task-sync-schema';
import { setTaskViewSectionId } from './view-sections';
import type { AppData, Task } from './types';

describe('viewSectionIds persistence', () => {
    it('round-trips the canonical map through SQLite, data.json, and the sync payload', () => {
        const task: Task = {
            id: 'task-view-section',
            title: 'Read DDIA',
            status: 'someday',
            tags: [],
            contexts: [],
            viewSectionIds: setTaskViewSectionId({ waiting: 'people' }, 'someday', 'books'),
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:00:00.000Z',
        };
        const sqliteValues = taskToSqliteRow(task);
        const sqliteRow = Object.fromEntries(
            TASK_SQLITE_COLUMNS.map((column, index) => [column, sqliteValues[index]]),
        );
        const sqliteTask = taskFromSqliteRow(sqliteRow);

        const data: AppData = {
            tasks: [task],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        const dataJsonTask = (JSON.parse(JSON.stringify(data)) as AppData).tasks[0];
        const syncTask = sanitizeAppDataForRemote(data).tasks[0];

        for (const copy of [sqliteTask, dataJsonTask, syncTask]) {
            expect(copy.viewSectionIds).toEqual({ someday: 'books', waiting: 'people' });
            expect(Object.keys(copy.viewSectionIds ?? {})).toEqual(['someday', 'waiting']);
        }
    });
});
