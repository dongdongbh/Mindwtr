import { describe, it, expect } from 'vitest';
import {
    extractChecklistFromMarkdown,
    getActiveMarkdownReferenceQuery,
    insertMarkdownReferenceAtQuery,
    normalizeMarkdownInternalLinks,
    parseMarkdownReferenceHref,
    searchMarkdownReferences,
    stripMarkdown,
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

describe('extractChecklistFromMarkdown', () => {
    it('extracts markdown task list items', () => {
        const input = '- [x] Done item\n[ ] Todo item\n+ [X] Another done\n- plain bullet';
        expect(extractChecklistFromMarkdown(input)).toEqual([
            { title: 'Done item', isCompleted: true },
            { title: 'Todo item', isCompleted: false },
            { title: 'Another done', isCompleted: true },
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
});
