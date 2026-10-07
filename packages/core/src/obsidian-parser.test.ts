import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
    appendObsidianRequiredInlineTag,
    normalizeObsidianRequiredInlineTag,
    buildObsidianFileTaskId,
    buildObsidianTaskId,
    normalizeObsidianRelativePath,
    parseObsidianTasksFromMarkdown,
    type ParseObsidianTasksOptions,
} from './obsidian-parser';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'obsidian-test-vault');

const readFixture = (relativePath: string): string => {
    return readFileSync(join(fixtureRoot, relativePath), 'utf8');
};

const createOptions = (relativeFilePath: string): ParseObsidianTasksOptions => ({
    vaultName: 'TestVault',
    vaultPath: '/tmp/TestVault',
    relativeFilePath,
    fileModifiedAt: '2026-03-14T12:00:00.000Z',
});

describe('parseObsidianTasksFromMarkdown', () => {
    it('parses incomplete and complete markdown task lines', () => {
        const result = parseObsidianTasksFromMarkdown(readFixture('Inbox.md'), createOptions('Inbox.md'));
        expect(result.tasks.map((task) => [task.text, task.completed])).toEqual([
            ['Buy groceries #errands', false],
            ['Pay rent [[Bills]]', true],
            ['Review docs #writing/reference', false],
        ]);
        expect(result.tasks.every((task) => task.format === 'inline')).toBe(true);
    });

    it('extracts inline tags and wiki links', () => {
        const result = parseObsidianTasksFromMarkdown(readFixture('Projects/Alpha.md'), createOptions('Projects/Alpha.md'));
        expect(result.tasks[0]?.tags).toEqual(['work', 'urgent']);
        expect(result.tasks[0]?.wikiLinks).toEqual(['Meeting Notes 2026-03-14']);
        expect(result.tasks[1]?.wikiLinks).toEqual(['Project Alpha']);
    });

    it('computes nesting from indentation', () => {
        const result = parseObsidianTasksFromMarkdown(readFixture('Projects/Beta.md'), createOptions('Projects/Beta.md'));
        expect(result.tasks.map((task) => task.nestingLevel)).toEqual([0, 1, 2, 1]);
    });

    it('inherits frontmatter tags without applying file-level due to every task', () => {
        const result = parseObsidianTasksFromMarkdown(readFixture('Daily/2026-03-14.md'), createOptions('Daily/2026-03-14.md'));
        expect(result.frontmatter.tags).toEqual(['project/alpha', 'work']);
        expect(result.frontmatter.due).toBe('2026-04-01');
        expect(result.tasks[0]?.tags).toEqual(['journal', 'project/alpha', 'work']);
    });

    it('keeps Dataview inline fields inert unless metadata import is enabled', () => {
        const result = parseObsidianTasksFromMarkdown(
            '- [ ] Ship proposal [project:: [[Project Alpha]]] [context:: @office] [due:: 2026-04-01] [scheduled:: 2026-03-28] [priority:: high] [estimate:: 45m] [tags:: #writing, review]',
            createOptions('Projects/Dataview.md')
        );

        expect(result.tasks[0]?.dataviewData).toBeUndefined();
        expect(result.tasks[0]?.text).toContain('[project:: [[Project Alpha]]]');
    });

    it('imports conservative Dataview metadata when enabled without changing task text', () => {
        const result = parseObsidianTasksFromMarkdown(
            '- [ ] Ship proposal [project:: [[Project Alpha]]] [context:: @office] [due:: 2026-04-01] [scheduled:: 2026-03-28] [priority:: high] [estimate:: 45m] [tags:: #writing, review]',
            {
                ...createOptions('Projects/Dataview.md'),
                dataviewMetadataEnabled: true,
            }
        );

        expect(result.tasks[0]?.text).toContain('[project:: [[Project Alpha]]]');
        expect(result.tasks[0]?.dataviewData).toEqual({
            priority: 'high',
            dueDate: '2026-04-01',
            scheduledDate: '2026-03-28',
            contexts: ['office'],
            projects: ['Project Alpha'],
            tags: ['writing', 'review'],
            timeEstimateMinutes: 45,
        });
        expect(result.tasks[0]?.tags).toEqual(['writing', 'review']);
    });

    it('skips task-like lines inside fenced code blocks', () => {
        const result = parseObsidianTasksFromMarkdown(readFixture('EdgeCases.md'), createOptions('EdgeCases.md'));
        expect(result.tasks.some((task) => task.text.includes('inside code block'))).toBe(false);
    });

    it('keeps fences open until eof when a closing fence is missing', () => {
        const result = parseObsidianTasksFromMarkdown(
            '```md\n- [ ] hidden\n- [ ] also hidden',
            createOptions('UnclosedFence.md')
        );
        expect(result.tasks).toHaveLength(0);
    });

    it('handles files without frontmatter or tasks', () => {
        const noFrontmatter = parseObsidianTasksFromMarkdown(readFixture('NoFrontmatter.md'), createOptions('NoFrontmatter.md'));
        const empty = parseObsidianTasksFromMarkdown(readFixture('Empty.md'), createOptions('Empty.md'));
        expect(noFrontmatter.tasks).toHaveLength(1);
        expect(noFrontmatter.frontmatter.tags).toEqual([]);
        expect(empty.tasks).toHaveLength(0);
    });

    it('handles unicode in filenames and task text', () => {
        const result = parseObsidianTasksFromMarkdown(readFixture('Unicode-任务.md'), createOptions('Unicode-任务.md'));
        expect(result.tasks[0]?.text).toBe('整理旅行计划 #生活');
        expect(result.tasks[0]?.source.relativeFilePath).toBe('Unicode-任务.md');
    });

    it('builds deterministic ids from file path and line number', () => {
        expect(buildObsidianTaskId('Projects/Alpha.md', 10)).toBe(buildObsidianTaskId('Projects/Alpha.md', 10));
        expect(buildObsidianTaskId('Projects/Alpha.md', 10)).not.toBe(buildObsidianTaskId('Projects/Alpha.md', 11));
        expect(buildObsidianFileTaskId('TaskNotes/Alpha.md')).toBe(buildObsidianFileTaskId('TaskNotes/Alpha.md'));
    });

    it('rejects parent traversal and absolute relative paths', () => {
        expect(() => normalizeObsidianRelativePath('../../etc/passwd')).toThrow(/parent traversal/i);
        expect(() => normalizeObsidianRelativePath('/etc/passwd')).toThrow(/absolute/i);
    });

    it('handles malformed frontmatter and wider tag characters without crashing', () => {
        const result = parseObsidianTasksFromMarkdown(
            [
                '---',
                'tags:',
                '  - "project/alpha',
                'tags: [ops]',
                '---',
                '- [ ] Follow up #work.project #ops:urgent',
            ].join('\n'),
            createOptions('Malformed.md')
        );
        expect(result.tasks[0]?.tags).toEqual(['work.project', 'ops:urgent', 'ops']);
    });

    it('normalizes non-finite or negative line numbers in task ids', () => {
        expect(buildObsidianTaskId('Projects/Alpha.md', -4)).toMatch(/^obsidian-0-/);
        expect(buildObsidianTaskId('Projects/Alpha.md', Number.NaN)).toMatch(/^obsidian-0-/);
    });
});


describe('required inline task tag', () => {
    const markdown = [
        '---', 'tags: [task]', '---',
        '- [ ] Pack charger', '- [ ] Email venue #task',
        '- [ ] Call venue #task/work', '- [ ] Read article #tasks',
        '- [ ] Metadata only [tags:: task]', '- [ ] Suffix text#task',
        '- [x] Finished #task', '- [ ] Case #Task',
    ].join('\n');

    it('filters only checkbox tags and preserves source text, ids and positions', () => {
        const options = { ...createOptions('Inbox.md'), dataviewMetadataEnabled: true };
        const all = parseObsidianTasksFromMarkdown(markdown, options).tasks;
        expect(parseObsidianTasksFromMarkdown(markdown, { ...options, requiredInlineTag: '  ' }).tasks).toEqual(all);
        const filtered = parseObsidianTasksFromMarkdown(markdown, { ...options, requiredInlineTag: '#task' }).tasks;
        expect(filtered).toEqual(all.filter((task) => [5, 6, 10].includes(task.source.lineNumber)));
        expect(filtered.map((task) => task.text)).toEqual(['Email venue #task', 'Call venue #task/work', 'Finished #task']);
    });

    it('normalizes one tag and rejects malformed filters instead of broadening discovery', () => {
        expect(normalizeObsidianRequiredInlineTag(' task/work ')).toBe('#task/work');
        expect(normalizeObsidianRequiredInlineTag('#任务')).toBe('#任务');
        for (const value of ['#', '#task #other', 'task/work/', 'task//work']) {
            expect(() => normalizeObsidianRequiredInlineTag(value)).toThrow();
        }
    });

    it('appends only when necessary and leaves newly created tasks discoverable', () => {
        for (const text of ['Call venue', 'Call venue #tasks', 'Call venue #task', 'Call venue #task/work']) {
            const marked = appendObsidianRequiredInlineTag(text, '#task');
            expect(appendObsidianRequiredInlineTag(marked, '#task')).toBe(marked);
            expect(parseObsidianTasksFromMarkdown(`- [ ] ${marked}`, { ...createOptions('Inbox.md'), requiredInlineTag: '#task' }).tasks).toHaveLength(1);
        }
        expect(appendObsidianRequiredInlineTag('Call #task/work', '#task')).toBe('Call #task/work');
        expect(appendObsidianRequiredInlineTag('Call', '')).toBe('Call');
    });
});
