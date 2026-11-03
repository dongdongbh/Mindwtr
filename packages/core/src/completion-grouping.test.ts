import { describe, expect, it } from 'vitest';
import { buildCompletionDateSections } from './completion-grouping';

const task = (id: string, completedAt?: string) => ({ id, completedAt });


const t = (key: string) => key;

describe('buildCompletionDateSections (#945, #959)', () => {
    const now = new Date('2026-03-10T23:30:00');

    it('orders sections newest first and omits the empty ones', () => {
        const sections = buildCompletionDateSections({
            tasks: [
                task('older', '2026-01-05T10:00:00'),
                task('today', '2026-03-10T08:00:00'),
                task('never'),
            ],
            t,
            now,
        });


        expect(sections.map((section) => section.id)).toEqual([
            'completedDate:today',
            'completedDate:2026-01',
            'completedDate:notCompleted',
        ]);
    });

    it('splits anything older than a week by calendar month, newest month first', () => {
        const sections = buildCompletionDateSections({
            tasks: [
                task('jan', '2026-01-31T23:00:00'),
                task('feb', '2026-02-01T00:30:00'),
                task('dec', '2025-12-24T10:00:00'),

                task('mar', '2026-03-01T10:00:00'),
            ],
            t,
            now,
        });

        expect(sections.map((section) => [section.id, section.tasks.map((item) => item.id)])).toEqual([
            ['completedDate:2026-03', ['mar']],
            ['completedDate:2026-02', ['feb']],
            ['completedDate:2026-01', ['jan']],
            ['completedDate:2025-12', ['dec']],
        ]);

        expect(sections.some((section) => section.id === 'completedDate:earlier')).toBe(false);
    });

    it('titles a month section with its month and year', () => {
        const [section] = buildCompletionDateSections({
            tasks: [task('old', '2026-01-05T10:00:00')],
            t,
            now,
        });
        expect(section.title).toBe('January 2026');
    });

    it('mutes the not-completed section the way other axes mute their catch-all', () => {
        const sections = buildCompletionDateSections({ tasks: [task('never')], t, now });
        expect(sections[0].muted).toBe(true);

        expect(sections[0].title).toBe('Not completed');
    });

    it('keeps every task exactly once', () => {
        const tasks = [
            task('a', '2026-03-10T08:00:00'),
            task('b', '2026-03-09T08:00:00'),
            task('c', '2026-03-05T08:00:00'),
            task('d', '2026-01-01T08:00:00'),
            task('e', '2025-06-01T08:00:00'),
            task('f'),
        ];
        const grouped = buildCompletionDateSections({ tasks, t, now })
            .flatMap((section) => section.tasks.map((item) => item.id));

        expect(grouped.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    });
});
