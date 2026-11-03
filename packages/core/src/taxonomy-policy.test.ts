import { describe, expect, it } from 'vitest';
import { normalizeTagId } from './store-helpers';
import { planTaxonomyEffect, selectTaxonomyScope, taxonomyDestination,
    type TaxonomyAction, type TaxonomyKind } from './taxonomy-policy';
import type { Project, Task } from './types';

const AT = '2026-09-30T12:00:00.000Z';
const task = (id: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({
    id, title: id, status, tags: ['#OLD', '#New', '#old', '#Keep'],
    contexts: [' @OLD ', '@New', '@old', '@Keep'], rev: 2, revBy: 'old',
    createdAt: AT, updatedAt: AT, ...extra,
});
const project = (id: string, extra: Partial<Project> = {}): Project => ({
    id, title: id, status: 'archived', color: '#abc', order: 0,
    tagIds: ['#OLD', '#New', '#old', '#Keep'], isFocused: true,
    createdAt: AT, updatedAt: AT, ...extra,
});


const legacy = (kind: TaxonomyKind, action: TaxonomyAction, name: string, to: string | null,
    values: string[]): string[] => {
    const key = (value: string) => kind === 'tag' ? normalizeTagId(value) : value.trim().toLowerCase();
    const target = key(name);
    if (action === 'delete') return values.filter((value) => key(value) !== target);
    const index = values.findIndex((value) => key(value) === target);
    if (index < 0) return values;
    const replacement = kind === 'tag' ? to!.trim().startsWith('#') ? to!.trim() : `#${to!.trim()}` : to!.trim();
    const replaced = [...values]; replaced[index] = replacement;
    if (kind === 'context') {
        const seen = new Set<string>();
        return replaced.filter((value) => seen.has(key(value)) ? false : (seen.add(key(value)), true));
    }
    const seen = new Set<string>();
    return replaced.reverse().filter((value) => {
        const normalized = key(value);
        if (!normalized || seen.has(normalized)) return false;
        seen.add(normalized); return true;
    }).reverse().map((value) => key(value) === key(replacement) ? replacement : value);
};

describe('taxonomy policy', () => {
    it.each([
        ['context', 'rename', ' @OLD ', ' @New '],
        ['context', 'delete', ' @OLD ', null],
        ['tag', 'rename', '#OLD', 'New'],
        ['tag', 'delete', 'old', null],
    ] as const)('matches RN %s %s across all Task statuses and Project tags', (kind, action, name, to) => {
        const tasks = (['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'] as const)
            .map((status, index) => task(String(index), status, index === 5
                ? { deletedAt: AT, focusOrder: 9 } : index === 6 ? { purgedAt: AT, focusOrder: 7 } : {}));
        const projects = [project('archived'), project('purged', { purgedAt: AT })];
        const scope = selectTaxonomyScope(kind, name, tasks, projects);
        const effect = planTaxonomyEffect(kind, action, name, to, scope, 'new-device', AT)!;
        expect(effect.tasks).toHaveLength(tasks.length);
        expect(effect.projects).toHaveLength(kind === 'tag' ? projects.length : 0);
        effect.tasks.forEach(({ before, after }) => {
            const field = kind === 'tag' ? 'tags' : 'contexts';
            expect(after[field]).toEqual(legacy(kind, action, name, to, before[field]));
            expect(after).toMatchObject({ ...before, [field]: after[field], rev: 3,
                revBy: 'new-device', updatedAt: AT });
            expect(after.focusOrder).toBe(before.focusOrder);
        });
        effect.projects.forEach(({ before, after }) => {
            expect(after.tagIds).toEqual(legacy(kind, action, name, to, before.tagIds));
            expect(after.isFocused).toBe(true);
        });
    });

    it('keeps RN no-op and Unicode spelling behavior', () => {
        expect(taxonomyDestination('context', 'rename', ' É ', 'É')).toBeUndefined();
        expect(taxonomyDestination('context', 'rename', ' É ', 'é')).toBe('é');
        expect(taxonomyDestination('tag', 'rename', '#Ä', 'Ä')).toBeUndefined();
        expect(taxonomyDestination('tag', 'rename', '#Ä', '#ä')).toBe('#ä');
        expect(taxonomyDestination('tag', 'rename', '#old', ' ')).toBeUndefined();
        expect(taxonomyDestination('tag', 'rename', '#old', '###')).toBe('###');
    });
});
