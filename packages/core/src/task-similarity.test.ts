import { describe, expect, it } from 'vitest';
import { createTaskSimilarityIndex, findSimilarTasks } from './task-similarity';
import type { Task } from './types';

const task = (id: string, title: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title,
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
});

describe('task similarity', () => {
    it('ranks normalized exact titles first while excluding self and deleted tasks', () => {
        const exactDone = task('exact-done', '  Résumé   review  ', {
            status: 'done',
            projectArchivedAt: '2026-09-10T00:00:00.000Z',
        });
        const exactInbox = task('exact-inbox', 'resume review');
        const deleted = task('deleted', 'Resume review', { deletedAt: '2026-09-11T01:00:00.000Z' });
        const current = task('current', 'Old title');
        const index = createTaskSimilarityIndex([current, exactInbox, deleted, exactDone]);

        expect(findSimilarTasks(index, 'RÉSUMÉ REVIEW', current.id)).toEqual([
            exactDone,
            exactInbox,
        ]);
    });

    it('orders conservative near matches by strength and deterministic tie-breakers', () => {
        const candidates = [
            task('book-short', 'Book dentist appointment'),
            task('exact', 'Book annual dentist appointment'),
            task('annual-short', 'Annual dentist appointment'),
            task('strong', 'Book annual dentist appointment tomorrow'),
            task('unrelated', 'Book train tickets'),
        ];
        const query = 'Book annual dentist appointment';

        const forward = findSimilarTasks(createTaskSimilarityIndex(candidates), query, 'current');
        const reversed = findSimilarTasks(createTaskSimilarityIndex([...candidates].reverse()), query, 'current');

        expect(forward.map(({ id }) => id)).toEqual(['exact', 'strong', 'annual-short']);
        expect(reversed.map(({ id }) => id)).toEqual(['exact', 'strong', 'annual-short']);
    });

    it('does not suggest an unrelated task from one shared generic word', () => {
        const index = createTaskSimilarityIndex([
            task('tickets', 'Buy train tickets'),
            task('milk', 'Buy groceries for tonight'),
            task('hotel', 'Call the hotel to confirm a late arrival'),
        ]);

        expect(findSimilarTasks(index, 'Buy groceries for dinner', 'current')).toEqual([
            expect.objectContaining({ id: 'milk' }),
        ]);
        expect(findSimilarTasks(index, 'Call the dentist about an annual appointment', 'current')).toEqual([]);
    });

    it('finds conservative near matches for titles written without word separators', () => {
        const index = createTaskSimilarityIndex([
            task('milk', '购买牛奶'),
            task('meeting', '购买会议记录'),
            task('bread', '购买牛奶和面包'),
        ]);

        expect(findSimilarTasks(index, '明天购买牛奶和面包', 'current').map(({ id }) => id)).toEqual([
            'bread',
            'milk',
        ]);
    });

    it('preserves meaningful non-Latin marks and operator-like titles', () => {
        const exactHindi = task('z-hindi', 'दिन');
        const differentHindi = task('a-hindi', 'दीन');
        const exactOperator = task('z-cpp', 'Fix C++ release checklist');
        const differentOperator = task('a-csharp', 'Fix C# release checklist');
        const index = createTaskSimilarityIndex([
            differentHindi,
            exactHindi,
            differentOperator,
            exactOperator,
        ]);

        expect(findSimilarTasks(index, 'दिन', 'current')).toEqual([exactHindi]);
        expect(findSimilarTasks(index, 'Fix C++ release checklist', 'current')).toEqual([exactOperator]);
        expect(findSimilarTasks(index, '*** && || +++', 'current')).toEqual([]);
    });

    it('ignores leading quick-add metadata sigils when matching the title words', () => {
        const existing = task('stamps', 'Buy postage stamps');
        const index = createTaskSimilarityIndex([existing]);

        for (const title of [
            'Buy postage stamps #errands',
            'Buy postage stamps %Alex',
            'Buy postage stamps +Home',
        ]) {
            expect(findSimilarTasks(index, title, 'current')).toEqual([existing]);
        }
    });

    it('does not create compact-script similarity from a shared Latin prefix', () => {
        const index = createTaskSimilarityIndex([task('tokyo', 'Project東京')]);

        expect(findSimilarTasks(index, 'Project大阪', 'current')).toEqual([]);
    });

    it('uses a fresh task-array snapshot without mutating either input', () => {
        const original = Object.freeze(task('candidate', 'Plan spring garden'));
        const originalTasks = Object.freeze([original]);
        const originalSnapshot = structuredClone(originalTasks);
        const firstIndex = createTaskSimilarityIndex(originalTasks);
        const updated = Object.freeze({ ...original, title: 'Schedule summer irrigation' });
        const updatedTasks = Object.freeze([updated]);
        const updatedSnapshot = structuredClone(updatedTasks);
        const secondIndex = createTaskSimilarityIndex(updatedTasks);

        expect(findSimilarTasks(firstIndex, 'Schedule summer irrigation', 'current')).toEqual([]);
        expect(findSimilarTasks(secondIndex, 'Schedule summer irrigation', 'current')).toEqual([updated]);
        expect(originalTasks).toEqual(originalSnapshot);
        expect(updatedTasks).toEqual(updatedSnapshot);
    });

    it('indexes and queries 5,000 tasks while keeping output bounded', () => {
        const tasks = Array.from({ length: 5_000 }, (_, index) => task(
            `task-${index.toString().padStart(4, '0')}`,
            index < 5
                ? `Prepare quarterly planning notes ${index}`
                : `Unrelated capture ${index}`,
        ));

        const matches = findSimilarTasks(
            createTaskSimilarityIndex(tasks),
            'Prepare quarterly planning notes',
            'current',
        );

        expect(matches).toHaveLength(3);
        expect(matches.map(({ id }) => id)).toEqual(['task-0000', 'task-0001', 'task-0002']);
    });
});
