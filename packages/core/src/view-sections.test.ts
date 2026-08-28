import { describe, expect, it } from 'vitest';
import type { Task, ViewSectionDefinition } from './types';
import {
    groupTasksByViewSection,
    resolveTaskViewSection,
    setTaskViewSectionId,
    sortViewSectionDefinitions,
} from './view-sections';

const task = (id: string, sectionId?: string): Task => ({
    id,
    title: id,
    status: 'someday',
    tags: [],
    contexts: [],
    viewSectionIds: sectionId ? { someday: sectionId } : undefined,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
});

describe('view sections', () => {
    it('sorts headings, resolves known ids, and renders orphan ids under No section without repairing them', () => {
        const definitions: ViewSectionDefinition[] = [
            { id: 'career', title: 'Career ideas', order: 2 },
            { id: 'books', title: 'Books to read', order: 1 },
        ];
        const known = task('known', 'books');
        const orphan = task('orphan', 'missing-heading');
        const before = JSON.stringify(orphan);

        expect(sortViewSectionDefinitions(definitions).map((definition) => definition.id)).toEqual(['books', 'career']);
        expect(resolveTaskViewSection(known, 'someday', definitions)?.id).toBe('books');
        expect(resolveTaskViewSection(orphan, 'someday', definitions)).toBeUndefined();
        expect(groupTasksByViewSection([known, orphan], 'someday', definitions, 'No section')).toEqual([
            expect.objectContaining({ id: 'view-section:someday:books', tasks: [known] }),
            expect.objectContaining({ id: 'view-section:someday:none', tasks: [orphan], muted: true }),
        ]);
        expect(JSON.stringify(orphan)).toBe(before);
        expect(setTaskViewSectionId({ waiting: 'future-value' }, 'someday', 'books')).toEqual({
            someday: 'books',
            waiting: 'future-value',
        });
        expect(setTaskViewSectionId({ someday: 'books' }, 'someday', undefined)).toEqual({});
    });
});
