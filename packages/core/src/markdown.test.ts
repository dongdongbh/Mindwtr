import { describe, it, expect } from 'vitest';
import {
    getActiveMarkdownReferenceQuery,
    insertMarkdownReferenceAtQuery,
    normalizeMarkdownInternalLinks,
    parseInlineMarkdown,
    parseMarkdownReferenceHref,
    searchMarkdownReferences,
    stripMarkdown,
    parsePastedChecklistItems,
} from './markdown';
import type { Project, Task } from './types';

describe('stripMarkdown', () => {
    it('removes common markdown markers', () => {
        const input = '# Title\n\n- **Bold** and *italic* with `code`\n\n[Link](https://example.com)';
        const output = stripMarkdown(input);
        expect(output).toContain('Title');
        expect(output).toContain('Bold and italic with code');
        expect(output).toContain('Link');
        expect(output).not.toContain('**');
        expect(output).not.toContain('`');
        expect(output).not.toContain('[');
    });

    it('removes markdown checklist and list markers', () => {
        const input = '- [x] Done item\n[ ] Todo item\n+ Plain bullet';
        const output = stripMarkdown(input);
        expect(output).toContain('Done item');
        expect(output).toContain('Todo item');
        expect(output).toContain('Plain bullet');
        expect(output).not.toContain('[x]');
        expect(output).not.toContain('[ ]');
    });

    it('keeps internal markdown link labels', () => {
        const input = 'See [[task:task-1|Quarterly review]] next.';
        expect(stripMarkdown(input)).toBe('See Quarterly review next.');
    });
});

describe('parseInlineMarkdown', () => {
    it('autolinks raw safe URLs outside explicit markdown links', () => {
        expect(parseInlineMarkdown('See https://example.com/docs.')).toEqual([
            { type: 'text', text: 'See ' },
            { type: 'link', text: 'https://example.com/docs', href: 'https://example.com/docs' },
            { type: 'text', text: '.' },
        ]);
    });

    it('autolinks a bare www. address as GFM does, so the collapsed preview matches the opened description (#1425)', () => {
        expect(parseInlineMarkdown('See www.google.com.')).toEqual([
            { type: 'text', text: 'See ' },
            { type: 'link', text: 'www.google.com', href: 'http://www.google.com' },
            { type: 'text', text: '.' },
        ]);
        expect(parseInlineMarkdown('www.example.com/a?b=1')).toEqual([
            { type: 'link', text: 'www.example.com/a?b=1', href: 'http://www.example.com/a?b=1' },
        ]);
    });

    it('leaves www. inside a word or a bare "www." as text', () => {
        for (const text of ['foo.www.example.com', 'type www. then the site']) {
            const tokens = parseInlineMarkdown(text);
            expect(tokens.every((token) => token.type === 'text')).toBe(true);
            expect(tokens.map((token) => token.text).join('')).toBe(text);
        }
    });

    it('keeps explicit markdown link labels and hrefs', () => {
        expect(parseInlineMarkdown('See [docs](https://example.com/docs).')).toEqual([
            { type: 'text', text: 'See ' },
            { type: 'link', text: 'docs', href: 'https://example.com/docs' },
            { type: 'text', text: '.' },
        ]);
    });

    it('autolinks RFC 2392 message-id links', () => {
        expect(parseInlineMarkdown('Reply later mid:960830.1639@example.com.')).toEqual([
            { type: 'text', text: 'Reply later ' },
            { type: 'link', text: 'mid:960830.1639@example.com', href: 'mid:960830.1639@example.com' },
            { type: 'text', text: '.' },
        ]);
    });

    it('keeps explicit RFC 2392 message-id link labels and hrefs', () => {
        expect(parseInlineMarkdown('See [email](mid:960830.1639@example.com).')).toEqual([
            { type: 'text', text: 'See ' },
            { type: 'link', text: 'email', href: 'mid:960830.1639@example.com' },
            { type: 'text', text: '.' },
        ]);
    });
});

describe('parsePastedChecklistItems', () => {
    it('splits plain multi-line text into checklist items', () => {
        expect(parsePastedChecklistItems('buy milk\nbuy bread\ncall mom')).toEqual([
            { title: 'buy milk', isCompleted: false },
            { title: 'buy bread', isCompleted: false },
            { title: 'call mom', isCompleted: false },
        ]);
    });

    it('strips bullet, numbered, and checkbox markers and keeps completion state', () => {
        expect(parsePastedChecklistItems('- [x] done item\n* [ ] open item\n+ plain bullet\n1. numbered\n[X] bare checkbox')).toEqual([
            { title: 'done item', isCompleted: true },
            { title: 'open item', isCompleted: false },
            { title: 'plain bullet', isCompleted: false },
            { title: 'numbered', isCompleted: false },
            { title: 'bare checkbox', isCompleted: true },
        ]);
    });

    it('drops empty lines and marker-only lines, and handles CRLF', () => {
        expect(parsePastedChecklistItems('first\r\n\r\n- [ ]\n   \nsecond')).toEqual([
            { title: 'first', isCompleted: false },
            { title: 'second', isCompleted: false },
        ]);
    });

    it('does not treat hyphenated words as bullets', () => {
        expect(parsePastedChecklistItems('-nospace\nreal item')).toEqual([
            { title: '-nospace', isCompleted: false },
            { title: 'real item', isCompleted: false },
        ]);
    });
});

describe('markdown references', () => {
    const baseTask: Task = {
        id: 'task-1',
        title: 'Quarterly review',
        status: 'next',
        tags: [],
        contexts: [],
        createdAt: '2026-04-10T10:00:00.000Z',
        updatedAt: '2026-04-10T10:00:00.000Z',
    };
    const baseProject: Project = {
        id: 'project-1',
        title: 'Launch plan',
        status: 'active',
        color: '#000000',
        order: 0,
        tagIds: [],
        createdAt: '2026-04-09T10:00:00.000Z',
        updatedAt: '2026-04-09T10:00:00.000Z',
    };

    it('normalizes internal markdown links outside code', () => {
        const input = 'See [[task:task-1|Quarterly review]] and `[[task:task-1|Quarterly review]]`.';
        const output = normalizeMarkdownInternalLinks(input);
        expect(output).toContain('[Quarterly review](mindwtr://task/task-1)');
        expect(output).toContain('`[[task:task-1|Quarterly review]]`');
    });

    it('parses internal markdown hrefs', () => {
        expect(parseMarkdownReferenceHref('mindwtr://project/project-1')).toEqual({
            entityType: 'project',
            id: 'project-1',
        });
        expect(parseMarkdownReferenceHref('https://example.com')).toBeNull();
    });

    it('detects the active [[ query at the cursor', () => {
        const value = 'Link to [[la';
        expect(getActiveMarkdownReferenceQuery(value, { start: value.length, end: value.length })).toEqual({
            start: 8,
            end: value.length,
            query: 'la',
        });
    });

    it('does not detect the active [[ query when editor assist is disabled', () => {
        const value = 'Link to [[la';
        expect(
            getActiveMarkdownReferenceQuery(value, { start: value.length, end: value.length }, { assist: false }),
        ).toBeNull();
    });

    it('inserts a stable markdown reference token', () => {
        const value = 'Link to [[la';
        const activeQuery = getActiveMarkdownReferenceQuery(value, { start: value.length, end: value.length });
        expect(activeQuery).not.toBeNull();
        const next = insertMarkdownReferenceAtQuery(value, activeQuery!, {
            entityType: 'task',
            id: 'task-1',
            label: 'Quarterly review',
        });
        expect(next.value).toBe('Link to [[task:task-1|Quarterly review]]');
        expect(next.selection).toEqual({
            start: next.value.length,
            end: next.value.length,
        });
    });

    it('searches tasks and projects by name for markdown references', () => {
        const moreRecentProject: Project = {
            ...baseProject,
            id: 'project-2',
            title: 'Launch retrospective',
            updatedAt: '2026-04-11T10:00:00.000Z',
        };
        const results = searchMarkdownReferences(
            [
                baseTask,
                {
                    ...baseTask,
                    id: 'task-2',
                    title: 'Archive receipts',
                    status: 'done',
                    updatedAt: '2026-04-08T10:00:00.000Z',
                },
            ],
            [baseProject, moreRecentProject],
            'launch',
        );

        expect(results).toEqual([
            {
                entityType: 'project',
                id: 'project-2',
                title: 'Launch retrospective',
                status: 'active',
                updatedAt: '2026-04-11T10:00:00.000Z',
            },
            {
                entityType: 'project',
                id: 'project-1',
                title: 'Launch plan',
                status: 'active',
                updatedAt: '2026-04-09T10:00:00.000Z',
            },
        ]);
    });

    it('can exclude the current task from markdown reference results', () => {
        const results = searchMarkdownReferences(
            [
                baseTask,
                {
                    ...baseTask,
                    id: 'task-2',
                    title: 'Quarterly review follow-up',
                    updatedAt: '2026-04-11T10:00:00.000Z',
                },
            ],
            [baseProject],
            'quarterly',
            8,
            { excludeTaskIds: ['task-1'] },
        );

        expect(results).toEqual([
            {
                entityType: 'task',
                id: 'task-2',
                title: 'Quarterly review follow-up',
                status: 'next',
                updatedAt: '2026-04-11T10:00:00.000Z',
            },
        ]);
    });
});
