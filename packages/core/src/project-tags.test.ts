import { describe, expect, it } from 'vitest';
import { normalizeProjectTag, projectTagsForIntent, projectTagSuggestions } from './project-tags';
import type { Project, Task } from './types';

describe('Project Tags RN policy', () => {
    it('trims only input and keeps a repeated leading hash', () => {
        expect(['', '  ', ' work ', '#Work', '##x'].map(normalizeProjectTag))
            .toEqual(['', '', '#work', '#Work', '##x']);
    });

    it('adds with Set semantics; removes exact matches; clears without normalizing unrelated raw values', () => {
        const raw = ['legacy', '#Work', 'legacy', '##x', '#Work'];
        expect(projectTagsForIntent(raw, { kind: 'add', input: ' #new ' }))
            .toEqual(['legacy', '#Work', '##x', '#new']);
        expect(projectTagsForIntent(raw, { kind: 'toggle', input: ' #Work ' }))
            .toEqual(['legacy', 'legacy', '##x']);
        expect(projectTagsForIntent(raw, { kind: 'clear' })).toEqual([]);
        expect(projectTagsForIntent(raw, { kind: 'add', input: '  ' })).toEqual(raw);
        expect(projectTagsForIntent(raw, { kind: 'toggle', input: 'legacy' }))
            .toEqual(['legacy', '#Work', 'legacy', '##x', '#Work', '#legacy']);
    });

    it('keeps Unicode normalization forms distinct, including exact toggle membership', () => {
        const composed = '#caf\u00e9';
        const decomposed = '#cafe\u0301';
        expect(projectTagsForIntent([composed], { kind: 'toggle', input: decomposed }))
            .toEqual([composed, decomposed]);
        expect(projectTagsForIntent([composed, decomposed], { kind: 'toggle', input: composed }))
            .toEqual([decomposed]);
    });

    it('suggests all live task hash tags first, then Project raw tags in encounter order', () => {
        const task = (id: string, tags: string[], deletedAt?: string) => ({
            id, tags, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', deletedAt,
        }) as Task;
        const project = (tagIds: string[]) => ({ tagIds }) as Project;
        expect(projectTagSuggestions([
            task('1', ['#z', '#a', 'bare', '#z']),
            task('2', ['#gone'], '2026-01-02T00:00:00.000Z'),
        ], [project(['legacy', '#a', '', 'legacy', '##raw'])]))
            .toEqual(['#a', '#z', 'legacy', '##raw']);
    });

    it('suggests a saved unused tag without changing Project assignments', () => {
        const settings = { taxonomy: { tags: [{ token: '#unused', rev: 1, revBy: 'test', updatedAt: '2026-10-20T00:00:00.000Z' }] } };
        expect(projectTagSuggestions([], [], settings)).toEqual(['#unused']);
    });

});
