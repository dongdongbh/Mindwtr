import { describe, expect, it } from 'vitest';
import { ChecklistEditorRows, checklistDropIndex, checklistEdgeScroll } from './checklist-editor-rows';

const item = (title: string, isCompleted = false) => ({ id: 'repeated', title, isCompleted });

describe('checklist editor session', () => {
    it('keeps separate rows through identical text, moving, inserting and deleting without rewriting IDs', () => {
        const session = new ChecklistEditorRows();
        const original = [item('First'), item('Second', true), item('Third')];
        const initial = session.sync(original).map((row) => row.identity);
        const renamed = [original[0], { ...original[1], title: 'First' }, original[2]];
        session.apply(renamed, { kind: 'rename', index: 1, text: 'First' });
        expect(session.sync(renamed).map((row) => row.identity)).toEqual(initial);
        const moved = [renamed[1], renamed[2], renamed[0]];
        expect(session.apply(moved, { kind: 'move', from: 0, to: 2 }).map((row) => row.identity))
            .toEqual([initial[1], initial[2], initial[0]]);
        const inserted = [moved[0], { id: 'new', title: '', isCompleted: false }, ...moved.slice(1)];
        const rows = session.apply(inserted, { kind: 'insertAfter', index: 0 });
        expect(rows[2].identity).toBe(initial[2]);
        const removed = inserted.filter((_, index) => index !== 0);
        expect(session.apply(removed, { kind: 'remove', index: 0 }).map((row) => row.identity))
            .toEqual([rows[1].identity, initial[2], initial[0]]);
        expect(removed.map((row) => row.id)).toEqual(['new', 'repeated', 'repeated']);
    });

    it('finds the nearest row in long lists and scrolls only near the viewport edges', () => {
        const centers = Array.from({ length: 100 }, (_, index) => index * 60 + 30);
        expect(checklistDropIndex(centers, 5870)).toBe(97);
        expect(checklistDropIndex(centers, -100)).toBe(0);
        expect(checklistDropIndex(centers, 9000)).toBe(99);
        expect(checklistEdgeScroll(450, 200, 800)).toBe(0);
        expect(checklistEdgeScroll(205, 200, 800)).toBeLessThan(0);
        expect(checklistEdgeScroll(795, 200, 800)).toBeGreaterThan(0);
    });
});
