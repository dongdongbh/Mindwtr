import { describe, expect, it } from 'vitest';
import { acceptCaptureSuggestion, captureAutocompleteSuggestions, captureAutocompleteTrigger } from './capture-autocomplete';
import { parseQuickAdd } from './quick-add';
import type { Project } from './types';

const project: Project = { id: 'existing', title: '東京 launch', status: 'active', color: '#123456',
    order: 0, tagIds: [], createdAt: '', updatedAt: '' };

describe('capture caret autocomplete', () => {
    it('replaces the whole token at a middle caret and keeps surrounding title text', () => {
        const text = 'Before @offce after';
        const trigger = captureAutocompleteTrigger(text, 11);
        expect(trigger).toEqual({ start: 7, end: 13, marker: '@', query: 'off' });
        expect(captureAutocompleteSuggestions(trigger, [], ['@office'], [])).toEqual([{ kind: 'token', label: '@office' }]);
        expect(acceptCaptureSuggestion(text, trigger!, { kind: 'token', label: '@office' })).toEqual({ text: 'Before @office after', caret: 14 });
    });

    it.each(['office space', '東京 広場', 'a "quote" and \\ path'])('quotes parser tokens safely: %s', (name) => {
        const text = 'Task #a';
        const trigger = captureAutocompleteTrigger(text, text.length)!;
        const next = acceptCaptureSuggestion(text, trigger, { kind: 'token', label: `#${name}` });
        expect(parseQuickAdd(next.text).props.tags).toEqual([`#${name}`]);
        expect(parseQuickAdd(next.text).title).toBe('Task');
    });

    it('finds quoted names at the caret and replaces through the closing quote', () => {
        const text = 'Task @"office spce" after';
        const trigger = captureAutocompleteTrigger(text, 13)!;
        expect(trigger).toMatchObject({ start: 5, end: 19, query: 'office' });
        expect(acceptCaptureSuggestion(text, trigger, { kind: 'token', label: '@office space' }).text).toBe('Task @"office space" after');
    });

    it('selects existing project IDs without leaving a name that could create a replacement', () => {
        const text = 'Task +東京 after';
        const trigger = captureAutocompleteTrigger(text, 8)!;
        const choices = captureAutocompleteSuggestions(trigger, [project,
            { ...project, id: 'deleted', deletedAt: '2026-01-01' }, { ...project, id: 'archived', status: 'archived' }], [], []);
        expect(choices).toEqual([{ kind: 'project', label: '東京 launch', id: 'existing' }]);
        expect(acceptCaptureSuggestion(text, trigger, choices[0])).toEqual({ text: 'Task after', caret: 5 });
    });

    it('ignores escaped markers and completed quoted tokens', () => {
        expect(captureAutocompleteTrigger('Task \\@off', 10)).toBeNull();
        expect(captureAutocompleteTrigger('Task @"office"', 14)).toBeNull();
        expect(captureAutocompleteTrigger('Task title', 10)).toBeNull();
    });
});
