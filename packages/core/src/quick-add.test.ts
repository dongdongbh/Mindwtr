import { describe, it, expect } from 'vitest';
import { parseQuickAdd, parseQuickAddDateCommands } from './quick-add';

describe('quick-add', () => {
    it('parses status, due, note, tags, contexts', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd('Call mom @phone #family /next /due:tomorrow 5pm /note:ask about trip', undefined, now);

        expect(result.title).toBe('Call mom');
        expect(result.props.status).toBe('next');
        expect(result.props.contexts).toEqual(['@phone']);
        expect(result.props.tags).toEqual(['#family']);
        expect(result.props.description).toBe('ask about trip');
        const expectedLocal = new Date(2025, 0, 2, 17, 0, 0, 0).toISOString();
        expect(result.props.dueDate).toBe(expectedLocal);
    });

    it('parses URL notes into the description field', () => {
        const now = new Date('2026-03-30T10:00:00Z');
        const result = parseQuickAdd('Check website /note:https://example.com', undefined, now);

        expect(result.title).toBe('Check website');
        expect(result.props.description).toBe('https://example.com');
    });

    it('keeps parsing later commands after a URL note', () => {
        const now = new Date('2026-03-30T10:00:00Z');
        const result = parseQuickAdd('Check website /note:https://example.com /next', undefined, now);

        expect(result.title).toBe('Check website');
        expect(result.props.description).toBe('https://example.com');
        expect(result.props.status).toBe('next');
    });

    it('parses /start and /review with the same natural date parser as /due', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd(
            'Review proposal /start:tomorrow /review:friday /due:next week',
            undefined,
            now
        );

        expect(result.title).toBe('Review proposal');
        expect(result.props.startTime).toBe(new Date(2025, 0, 2, 0, 0, 0, 0).toISOString());
        expect(result.props.reviewAt).toBe(new Date(2025, 0, 3, 0, 0, 0, 0).toISOString());
        const expectedHour = now.getHours();
        const expectedMinute = now.getMinutes();
        expect(result.props.dueDate).toBe(new Date(2025, 0, 8, expectedHour, expectedMinute, 0, 0).toISOString());
    });

    it('parses abbreviated weekday commands like /start:mon', () => {
        const now = new Date('2026-02-27T09:40:00Z');
        const result = parseQuickAdd('Task /start:mon', undefined, now);
        expect(result.props.startTime).toBe(new Date(2026, 2, 2, 0, 0, 0, 0).toISOString());
        expect(result.invalidDateCommands).toBeUndefined();
    });

    it('reports invalid date commands instead of silently dropping them', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd('Task /start:monx /due:tomorrow', undefined, now);
        expect(result.invalidDateCommands).toEqual(['/start:monx']);
        expect(result.props.startTime).toBeUndefined();
        expect(result.props.dueDate).toBe(new Date(2025, 0, 2, now.getHours(), now.getMinutes(), 0, 0).toISOString());
    });

    it('parses date commands without stripping unrelated quick-add tokens', () => {
        const now = new Date('2026-04-13T10:00:00Z');
        const result = parseQuickAddDateCommands(
            'Review talk @school #urgent /start:tomorrow /due:friday 2pm /review:next monday',
            now
        );

        expect(result.title).toBe('Review talk @school #urgent');
        expect(result.props.startTime).toBe(new Date(2026, 3, 14, 0, 0, 0, 0).toISOString());
        expect(result.props.dueDate).toBe(new Date(2026, 3, 17, 14, 0, 0, 0).toISOString());
        expect(result.props.reviewAt).toBe(new Date(2026, 3, 20, 0, 0, 0, 0).toISOString());
    });

    it('keeps invalid date commands in the title-only parser output', () => {
        const now = new Date('2026-04-13T10:00:00Z');
        const result = parseQuickAddDateCommands('Task /due:2026-04-31', now);

        expect(result.title).toBe('Task /due:2026-04-31');
        expect(result.invalidDateCommands).toEqual(['/due:2026-04-31']);
        expect(result.props.dueDate).toBeUndefined();
    });

    it('parses relative due dates with numbers without treating numbers as time tokens', () => {
        const now = new Date('2026-03-01T10:30:00Z');
        const result = parseQuickAdd('Task /due:in 3 days', undefined, now);
        expect(result.invalidDateCommands).toBeUndefined();
        expect(result.props.dueDate).toBe(new Date(2026, 2, 4, now.getHours(), now.getMinutes(), 0, 0).toISOString());
    });

    it('parses ISO due dates without corrupting the date token', () => {
        const now = new Date('2026-03-01T10:30:00Z');
        const result = parseQuickAdd('Task /due:2026-03-15', undefined, now);
        expect(result.invalidDateCommands).toBeUndefined();
        expect(result.props.dueDate).toBe(new Date(2026, 2, 15, now.getHours(), now.getMinutes(), 0, 0).toISOString());
    });

    it('parses richer chrono expressions in explicit date commands', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Call dentist /due:next friday at 3pm', undefined, now);

        expect(result.invalidDateCommands).toBeUndefined();
        expect(result.props.dueDate).toBe(new Date(2026, 3, 17, 15, 0, 0, 0).toISOString());
    });

    it('keeps the current fallback time for explicit calendar dates without a time', () => {
        const now = new Date('2026-02-01T10:00:00Z');
        const result = parseQuickAdd('Submit report /due:march 15', undefined, now);

        expect(result.invalidDateCommands).toBeUndefined();
        expect(result.props.dueDate).toBe(new Date(2026, 2, 15, now.getHours(), now.getMinutes(), 0, 0).toISOString());
    });

    it('detects a trailing natural-language due date without auto-applying it in core', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Call mom tomorrow at 3pm @phone /next', undefined, now);

        expect(result.title).toBe('Call mom tomorrow at 3pm');
        expect(result.props.status).toBe('next');
        expect(result.props.contexts).toEqual(['@phone']);
        expect(result.props.dueDate).toBeUndefined();
        expect(result.detectedDate).toEqual({
            date: new Date(2026, 3, 7, 15, 0, 0, 0).toISOString(),
            matchedText: 'tomorrow at 3pm',
            titleWithoutDate: 'Call mom',
        });
    });

    it('does not auto-detect dates from the middle of the title', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Call March about the report', undefined, now);

        expect(result.title).toBe('Call March about the report');
        expect(result.detectedDate).toBeUndefined();
    });

    it('does not auto-detect pure time-only suffixes', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Task at 3', undefined, now);

        expect(result.title).toBe('Task at 3');
        expect(result.detectedDate).toBeUndefined();
    });

    it('does not auto-detect when the entire title is just a date phrase', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('tomorrow', undefined, now);

        expect(result.title).toBe('tomorrow');
        expect(result.detectedDate).toBeUndefined();
    });

    it('does not auto-detect bare month names at the end of the title', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Call March', undefined, now);

        expect(result.title).toBe('Call March');
        expect(result.detectedDate).toBeUndefined();
    });

    it('skips trailing NLP detection when an explicit due command is present', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Call mom tomorrow /due:friday', undefined, now);

        expect(result.props.dueDate).toBe(new Date(2026, 3, 10, now.getHours(), now.getMinutes(), 0, 0).toISOString());
        expect(result.detectedDate).toBeUndefined();
        expect(result.title).toBe('Call mom tomorrow');
    });

    it('matches project by title when provided', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const projects = [
            {
                id: 'p1',
                title: 'MyProject',
                status: 'active',
                color: '#000000',
                tagIds: [],
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
        ];

        const result = parseQuickAdd('Write spec +MyProject', projects as any, now);
        expect(result.title).toBe('Write spec');
        expect(result.props.projectId).toBe('p1');
        expect(result.projectTitle).toBeUndefined();
    });

    it('captures project title when project is missing', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const projects = [
            {
                id: 'p1',
                title: 'Existing',
                status: 'active',
                color: '#000000',
                tagIds: [],
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
        ];

        const result = parseQuickAdd('Draft outline +NewProject', projects as any, now);
        expect(result.title).toBe('Draft outline');
        expect(result.props.projectId).toBeUndefined();
        expect(result.projectTitle).toBe('NewProject');
    });

    it('captures multi-word project titles', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const projects = [
            {
                id: 'p1',
                title: 'Project Name',
                status: 'active',
                color: '#000000',
                tagIds: [],
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
        ];

        const result = parseQuickAdd('Plan roadmap +Project Name /next', projects as any, now);
        expect(result.title).toBe('Plan roadmap');
        expect(result.props.projectId).toBe('p1');
        expect(result.projectTitle).toBeUndefined();
    });

    it('matches area by name when provided', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const areas = [
            { id: 'a1', name: 'Work', color: '#111111', order: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() },
            { id: 'a2', name: 'Personal', color: '#222222', order: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() },
        ];

        const result = parseQuickAdd('Draft report !Work /next', undefined, now, areas as any);
        expect(result.title).toBe('Draft report');
        expect(result.props.areaId).toBe('a1');

        const explicitResult = parseQuickAdd('Plan budget /area:Personal /next', undefined, now, areas as any);
        expect(explicitResult.title).toBe('Plan budget');
        expect(explicitResult.props.areaId).toBe('a2');
    });

    it('supports unicode tags and contexts', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd('计划 @工作 #项目 /next', undefined, now);

        expect(result.title).toBe('计划');
        expect(result.props.contexts).toEqual(['@工作']);
        expect(result.props.tags).toEqual(['#项目']);
        expect(result.props.status).toBe('next');
    });
});
