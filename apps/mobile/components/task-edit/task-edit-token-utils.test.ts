import { describe, expect, it } from 'vitest';
import {
    applyMarkdownChecklistToTask,
    getActiveTokenQuery,
    parseTokenList,
    replaceTrailingToken,
} from './task-edit-token-utils';

describe('task-edit token utils', () => {
    it('normalizes and deduplicates token lists', () => {
        expect(parseTokenList('home, @work, @home, , @work', '@')).toEqual(['@home', '@work']);
        expect(parseTokenList('urgent, #idea, #urgent', '#')).toEqual(['#urgent', '#idea']);
    });

    it('derives active token query from trailing draft token', () => {
        expect(getActiveTokenQuery('@home, @wo', '@')).toBe('wo');
        expect(getActiveTokenQuery('@home, work', '@')).toBe('work');
        expect(getActiveTokenQuery('#urgent, idea', '#')).toBe('idea');
        expect(getActiveTokenQuery('@home, ', '@')).toBe('');
    });

    it('replaces trailing token draft while preserving prior entries', () => {
        expect(replaceTrailingToken('@home, @wo', '@work')).toBe('@home, @work, ');
        expect(replaceTrailingToken(undefined, '@home')).toBe('@home, ');
    });

    it('maps markdown checklist items while reusing existing ids', () => {
        const existing = [
            { id: 'a', title: 'Buy milk', isCompleted: true },
            { id: 'b', title: 'Legacy item', isCompleted: false },
        ];
        const merged = applyMarkdownChecklistToTask('- [ ] Buy milk\n- [x] Call mom', existing);
        expect(merged).toHaveLength(3);
        expect(merged?.[0]).toMatchObject({ id: 'a', title: 'Buy milk', isCompleted: false });
        expect(merged?.[1]?.title).toBe('Call mom');
        expect(merged?.[2]).toEqual(existing[1]);
    });

    it('returns existing checklist when markdown list is absent', () => {
        const existing = [{ id: 'x', title: 'Keep', isCompleted: false }];
        expect(applyMarkdownChecklistToTask('Plain paragraph', existing)).toBe(existing);
    });
});
