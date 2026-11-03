import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';

import { buildTaskNotesExportZip, serializeTaskNotesExport } from './tasknotes-export';
import { parseTaskNotesFile } from './tasknotes-parser';
import type { AppData, Task } from './types';

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
} as Task);

const data = (tasks: Task[], projects: AppData['projects'] = []): AppData => ({
    tasks,
    projects,
    sections: [],
    areas: [],
    people: [],
    settings: {},
});


const parseBack = (file: { path: string; content: string }) => parseTaskNotesFile(file.content, {
    vaultName: 'vault',
    vaultPath: '/vault',
    relativeFilePath: file.path,
    fileModifiedAt: '2026-08-14T00:00:00.000Z',
});

describe('serializeTaskNotesExport', () => {
    it('round-trips status, dates, contexts, project, tags, and estimate through the parser', () => {
        const { files } = serializeTaskNotesExport(data([
            task('aaaa1111', {
                title: 'Call mom',
                status: 'waiting',
                priority: 'medium',
                dueDate: '2026-08-20',
                startTime: '2026-08-18',
                contexts: ['@phone'],
                tags: ['#family'],
                timeEstimate: '30min',
                projectId: 'p1',
                description: 'She asked about the trip.',
            }),
        ], [{
            id: 'p1', title: 'Family', status: 'active', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
        } as AppData['projects'][number]]));

        expect(files).toHaveLength(1);
        const parsed = parseBack(files[0]);
        expect(parsed.matchesTaskNotesFormat).toBe(true);
        expect(parsed.task?.text).toBe('Call mom');
        expect(parsed.task?.taskNotesData).toMatchObject({
            mindwtrStatus: 'waiting',
            priority: 'medium',
            dueDate: '2026-08-20',
            scheduledDate: '2026-08-18',
            contexts: ['phone'],
            projects: ['Family'],
            timeEstimateMinutes: 30,
            bodyPreview: 'She asked about the trip.',
        });

        expect(files[0].content).toContain('- task');
        expect(parsed.task?.tags).toEqual(['family']);
    });

    it('maps every exportable status to a value the parser inverts', () => {
        const statuses: Array<[Task['status'], string]> = [
            ['inbox', 'inbox'],
            ['next', 'next'],
            ['waiting', 'waiting'],
            ['someday', 'someday'],
            ['done', 'done'],
            ['archived', 'archived'],
        ];
        const { files } = serializeTaskNotesExport(data(statuses.map(([status], index) => task(`t${index}00000000`, { status }))));
        expect(files).toHaveLength(statuses.length);
        files.forEach((file, index) => {

            const parsed = parseTaskNotesFile(file.content, {
                vaultName: 'vault',
                vaultPath: '/vault',
                relativeFilePath: file.path,
                fileModifiedAt: '2026-08-14T00:00:00.000Z',
                includeArchived: true,
            });
            expect(parsed.task?.taskNotesData?.mindwtrStatus).toBe(statuses[index][1]);
        });
    });

    it('skips tombstones and reference tasks, and quotes titles the YAML reader would mangle', () => {
        const result = serializeTaskNotesExport(data([
            task('gone0000', { deletedAt: '2026-08-01T00:00:00.000Z' }),
            task('ref00000', { status: 'reference' }),
            task('num00000', { title: '2026' }),
        ]));
        expect(result.files).toHaveLength(1);
        expect(result.skippedReferenceCount).toBe(1);
        const parsed = parseBack(result.files[0]);
        expect(parsed.task?.text).toBe('2026');
    });

    it('builds a zip whose entries match the serialized files', () => {
        const source = data([task('aaaa1111', { title: 'Zip me' })]);
        const { zip, fileCount } = buildTaskNotesExportZip(source);
        const { files } = serializeTaskNotesExport(source);
        expect(fileCount).toBe(1);
        const entries = unzipSync(zip);
        expect(Object.keys(entries)).toEqual(files.map((file) => file.path));
        expect(strFromU8(entries[files[0].path])).toBe(files[0].content);
    });
});
