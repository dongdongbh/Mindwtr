import { describe, it, expect } from 'vitest';
import { buildPersonSearchQuery } from './people';
import { filterProjectsBySearch, filterTasksBySearch, parseSearchQuery, searchAll } from './search';
import type { Project, Task } from './types';

describe('search', () => {
    it.each([['person-abc123'], [], null, { name: 'Alex' }, 42, true].map((assignedTo) => ({ assignedTo })))('ignores malformed assignee text without breaking search: %j', ({ assignedTo }) => {
        const task = {
            id: 'milk', title: 'Buy milk', status: 'inbox', tags: [], contexts: [],
            createdAt: '2026-09-16T12:00:00Z', updatedAt: '2026-09-16T12:00:00Z', assignedTo,
        } as unknown as Task;
        expect(filterTasksBySearch([task], [], 'milk')).toEqual([task]);
        for (const query of ['unmatched', 'assigned:person', 'assignee:person', 'assignedto:person']) {
            expect(filterTasksBySearch([task], [], query)).toEqual([]);
        }
        expect(filterTasksBySearch([task], [], '-assignee:person')).toEqual([task]);
        expect(task.assignedTo).toEqual(assignedTo);
    });

    it('matches an unterminated quoted phrase while it is being typed', () => {
        const values = (query: string) => parseSearchQuery(query).clauses[0]?.terms.map((term) => term.value) ?? [];

        expect(values('foo "bar baz')).toEqual(['foo', 'bar baz']);
        expect(values('foo "bar baz"')).toEqual(['foo', 'bar baz']);
        expect(values('foo "')).toEqual(['foo']);
    });

    it('caps global search results to the shared search limit', () => {
        const tasks: Task[] = Array.from({ length: 205 }, (_, index) => ({
            id: `task-${index}`,
            title: `Needle task ${index}`,
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00Z',
            updatedAt: '2025-01-01T00:00:00Z',
        }));

        const results = searchAll(tasks, [], 'needle');

        expect(results.tasks).toHaveLength(200);
        expect(results.limited).toBe(true);
        expect(results.limit).toBe(200);
    });

    it('supports status, OR groups, and negation', () => {
        const now = new Date('2025-01-01T10:00:00Z');

        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Call mom',
                status: 'inbox',
                tags: [],
                contexts: [],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
            },
            {
                id: 't2',
                title: 'Write report',
                status: 'next',
                tags: [],
                contexts: [],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
            },
            {
                id: 't3',
                title: 'Old done task',
                status: 'done',
                tags: [],
                contexts: [],
                createdAt: '2024-12-01T00:00:00Z',
                updatedAt: '2024-12-01T00:00:00Z',
            },
        ];
        const projects: Project[] = [];

        const results = filterTasksBySearch(tasks, projects, 'status:inbox OR status:next -status:done', now);
        expect(results.map(t => t.id)).toEqual(['t1', 't2']);
    });

    it('supports reference status filter', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Reference task',
                status: 'reference',
                tags: [],
                contexts: [],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
            },
            {
                id: 't2',
                title: 'Next task',
                status: 'next',
                tags: [],
                contexts: [],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
            },
        ];

        const results = filterTasksBySearch(tasks, [], 'status:reference', now);
        expect(results.map(t => t.id)).toEqual(['t1']);
    });

    it('supports relative date comparisons', () => {
        const now = new Date('2025-01-01T00:00:00Z');
        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Due soon',
                status: 'next',
                dueDate: '2025-01-05T09:00:00.000Z',
                tags: [],
                contexts: [],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
            },
            {
                id: 't2',
                title: 'Due later',
                status: 'next',
                dueDate: '2025-01-20T09:00:00.000Z',
                tags: [],
                contexts: [],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
            },
        ];

        const results = filterTasksBySearch(tasks, [], 'due:<=7d', now);
        expect(results.map(t => t.id)).toEqual(['t1']);
    });

    it('matches parent context filters against slash-delimited child contexts', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Team sync',
                status: 'next',
                tags: [],
                contexts: ['@work/meetings'],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
            {
                id: 't2',
                title: 'Home admin',
                status: 'next',
                tags: [],
                contexts: ['@home'],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];

        const results = filterTasksBySearch(tasks, [], 'context:work');
        expect(results.map((task) => task.id)).toEqual(['t1']);
    });

    it('treats @context, #tag and %person as filters (#1264)', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const base = { status: 'next' as const, createdAt: nowIso, updatedAt: nowIso };
        const tasks: Task[] = [
            { id: 'home', title: 'Water plants', tags: ['#chores'], contexts: ['@home'], ...base },
            { id: 'work', title: 'Email Alex about @home page', tags: [], contexts: ['@work'], assignedTo: 'Alex', ...base },
        ];
        expect(filterTasksBySearch(tasks, [], '@home').map((task) => task.id)).toEqual(['home']);
        expect(filterTasksBySearch(tasks, [], '-@home').map((task) => task.id)).toEqual(['work']);
        expect(filterTasksBySearch(tasks, [], '#chores').map((task) => task.id)).toEqual(['home']);
        expect(filterTasksBySearch(tasks, [], '%alex').map((task) => task.id)).toEqual(['work']);
        expect(filterTasksBySearch(tasks, [], '@work plants')).toEqual([]);

        expect(filterTasksBySearch(tasks, [], '@').map((task) => task.id)).toEqual(['work']);
    });

    it('decodes quoted shorthand values before matching them', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const base = { status: 'next' as const, createdAt: nowIso, updatedAt: nowIso };
        const tasks: Task[] = [
            {
                id: 'multiword', title: 'Multiword shorthand', assignedTo: 'Alex Smith',
                contexts: ['@home office'], tags: ['#family trip'], ...base,
            },
            {
                id: 'colon', title: 'Colon shorthand', assignedTo: 'Alex: "Ace" Smith',
                contexts: ['@work'], tags: ['#people'], ...base,
            },
            {
                id: 'other', title: 'Other task', assignedTo: 'Taylor',
                contexts: ['@work'], tags: ['#people'], ...base,
            },
        ];
        const ids = (query: string) => filterTasksBySearch(tasks, [], query).map((task) => task.id);

        expect(ids('%"Alex Smith"')).toEqual(['multiword']);
        expect(ids('@"home office"')).toEqual(['multiword']);
        expect(ids('#"family trip"')).toEqual(['multiword']);
        expect(ids('-@"home office"')).toEqual(['colon', 'other']);
        expect(ids('%"Alex: \\"Ace\\" Smith"')).toEqual(['colon']);
        expect(ids('person:"Alex: \\"Ace\\" Smith"')).toEqual(['colon']);
    });

    it('matches project filter by title', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const projects: Project[] = [
            {
                id: 'p1',
                title: 'Work Stuff',
                color: '#000000',
                status: 'active',
                tagIds: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];
        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Task in project',
                status: 'next',
                projectId: 'p1',
                tags: [],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];

        const results = filterTasksBySearch(tasks, projects, 'project:work');
        expect(results).toHaveLength(1);
    });

    it('matches assigned task filters and combines them with tags', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Follow up',
                status: 'waiting',
                assignedTo: 'Tom',
                tags: ['#urgent'],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
            {
                id: 't2',
                title: 'Review invoice',
                status: 'waiting',
                assignedTo: 'Tom',
                tags: ['#finance'],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
            {
                id: 't3',
                title: 'Ask for estimate',
                status: 'waiting',
                assignedTo: 'Alex',
                tags: ['#urgent'],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];

        const results = filterTasksBySearch(tasks, [], 'tags:#urgent assigned:Tom');
        expect(results.map((task) => task.id)).toEqual(['t1']);
    });

    it('supports quoted assignee filters', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Follow up',
                status: 'waiting',
                assignedTo: 'Tom Smith',
                tags: [],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
            {
                id: 't2',
                title: 'Check brief',
                status: 'waiting',
                assignedTo: 'Tom',
                tags: [],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];

        const results = filterTasksBySearch(tasks, [], 'assignee:"Tom Smith"');
        expect(results.map((task) => task.id)).toEqual(['t1']);
    });

    it('matches a person by exact assignment or exact context and deduplicates tasks', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const tasks: Task[] = [
            { id: 'assigned', title: 'Assigned', status: 'waiting', assignedTo: ' Alex  Smith ', tags: [], contexts: [], createdAt: nowIso, updatedAt: nowIso },
            { id: 'context', title: 'Context', status: 'next', tags: [], contexts: ['@ALEX SMITH'], createdAt: nowIso, updatedAt: nowIso },
            { id: 'both', title: 'Both', status: 'done', assignedTo: 'Alex Smith', tags: [], contexts: ['@alex smith'], createdAt: nowIso, updatedAt: nowIso },
            { id: 'reference', title: 'Reference', status: 'reference', tags: [], contexts: ['@Alex Smith'], createdAt: nowIso, updatedAt: nowIso },
            { id: 'similar', title: 'Similar', status: 'next', assignedTo: 'Alex', tags: [], contexts: ['@Alex Smith/Office', '@Alexandra Smith'], createdAt: nowIso, updatedAt: nowIso },
            { id: 'ordinary', title: 'Ordinary', status: 'reference', tags: [], contexts: ['Alex Smith'], createdAt: nowIso, updatedAt: nowIso },
            { id: 'deleted', title: 'Deleted', status: 'next', assignedTo: 'Alex Smith', tags: [], contexts: [], createdAt: nowIso, updatedAt: nowIso, deletedAt: nowIso },
            { id: 'purged', title: 'Purged', status: 'next', tags: [], contexts: ['@Alex Smith'], createdAt: nowIso, updatedAt: nowIso, purgedAt: nowIso },
        ];

        expect(filterTasksBySearch(tasks, [], 'person:"alex smith"').map((item) => item.id)).toEqual([
            'assigned', 'context', 'both', 'reference',
        ]);
        expect(filterTasksBySearch(tasks, [], '-person:"alex smith"').map((item) => item.id)).toEqual([
            'similar', 'ordinary',
        ]);
        expect(filterTasksBySearch(tasks, [], 'person:""')).toEqual([]);
    });

    it('keeps generated person queries safe for punctuation, quotes, backslashes, and operators', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const name = 'Alex: "OR" \\ Ops';
        const tasks: Task[] = [
            { id: 'exact', title: 'Exact', status: 'next', assignedTo: name, tags: [], contexts: [], createdAt: nowIso, updatedAt: nowIso },
            { id: 'injected', title: 'Injected', status: 'next', assignedTo: 'Someone else', tags: [], contexts: [], createdAt: nowIso, updatedAt: nowIso },
        ];
        const query = buildPersonSearchQuery(name);

        expect(filterTasksBySearch(tasks, [], query).map((item) => item.id)).toEqual(['exact']);
        expect(filterTasksBySearch(tasks, [], `${query} OR status:waiting`).map((item) => item.id)).toEqual(['exact']);
    });

    it('preserves literal backslashes in existing quoted searches', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const tasks: Task[] = [
            { id: 'tab', title: String.raw`C:\temp`, status: 'next', tags: [], contexts: [], createdAt: nowIso, updatedAt: nowIso },
            { id: 'newline', title: String.raw`folder\new`, status: 'next', tags: [], contexts: [], createdAt: nowIso, updatedAt: nowIso },
            { id: 'backspace', title: String.raw`alpha\beta`, status: 'next', tags: [], contexts: [], createdAt: nowIso, updatedAt: nowIso },
            { id: 'location', title: 'Path', status: 'next', location: String.raw`C:\temp`, tags: [], contexts: [], createdAt: nowIso, updatedAt: nowIso },
        ];

        expect(filterTasksBySearch(tasks, [], String.raw`"C:\temp"`).map((item) => item.id)).toEqual(['tab']);
        expect(filterTasksBySearch(tasks, [], String.raw`"folder\new"`).map((item) => item.id)).toEqual(['newline']);
        expect(filterTasksBySearch(tasks, [], String.raw`"alpha\beta"`).map((item) => item.id)).toEqual(['backspace']);
        expect(filterTasksBySearch(tasks, [], String.raw`location:"C:\temp"`).map((item) => item.id)).toEqual(['location']);
    });

    it('never matches projects by literal text for a person field', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const projects: Project[] = [{
            id: 'project-person-text',
            title: 'person:Alex',
            color: '#000000',
            status: 'active',
            tagIds: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        }];

        expect(filterProjectsBySearch(projects, 'person:"Alex"')).toEqual([]);
        expect(filterProjectsBySearch(projects, '-person:"Alex"')).toEqual([]);
    });

    it('matches assigned people in unfielded task searches', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Follow up on invoice',
                status: 'waiting',
                assignedTo: 'John Smith',
                tags: [],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
            {
                id: 't2',
                title: 'Review contract',
                status: 'waiting',
                assignedTo: 'Sarah',
                tags: [],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];

        const results = filterTasksBySearch(tasks, [], 'john');
        expect(results.map((task) => task.id)).toEqual(['t1']);
    });

    it('matches location text and location field filters', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Prepare slides',
                status: 'next',
                location: 'Main Office',
                tags: [],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
            {
                id: 't2',
                title: 'Review notes',
                status: 'next',
                location: 'Home desk',
                tags: [],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];

        expect(filterTasksBySearch(tasks, [], 'office').map((task) => task.id)).toEqual(['t1']);
        expect(filterTasksBySearch(tasks, [], 'location:home').map((task) => task.id)).toEqual(['t2']);
    });

    it('matches checklist item text in task searches', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Trip prep',
                status: 'next',
                checklist: [
                    { id: 'check-1', title: 'Book shuttle', isCompleted: false },
                    { id: 'check-2', title: 'Print tickets', isCompleted: true },
                ],
                tags: [],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
            {
                id: 't2',
                title: 'Home errands',
                status: 'next',
                checklist: [{ id: 'check-3', title: 'Buy soap', isCompleted: false }],
                tags: [],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];

        expect(filterTasksBySearch(tasks, [], 'shuttle').map((task) => task.id)).toEqual(['t1']);
        expect(filterTasksBySearch(tasks, [], 'checklist:tickets').map((task) => task.id)).toEqual(['t1']);
    });

    it('matches task id filters', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const tasks: Task[] = [
            {
                id: '018f4d3a-b89c-74c3-81aa-0c1ef3de0001',
                title: 'Investigate sync warning',
                status: 'next',
                tags: [],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
            {
                id: '018f4d3a-b89c-74c3-81aa-0c1ef3de0002',
                title: 'Review notes',
                status: 'next',
                tags: [],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];

        expect(filterTasksBySearch(tasks, [], 'id:0c1ef3de0001').map((task) => task.id)).toEqual([
            '018f4d3a-b89c-74c3-81aa-0c1ef3de0001',
        ]);
        expect(filterTasksBySearch(tasks, [], 'id:018F4D3A-B89C-74C3-81AA-0C1EF3DE0002').map((task) => task.id)).toEqual([
            '018f4d3a-b89c-74c3-81aa-0c1ef3de0002',
        ]);
        expect(filterTasksBySearch(tasks, [], '-id:0002').map((task) => task.id)).toEqual([
            '018f4d3a-b89c-74c3-81aa-0c1ef3de0001',
        ]);
    });

    it('does not build project lookup when query has no project terms', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Call mom',
                status: 'inbox',
                tags: [],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];
        const projects = new Proxy([] as Project[], {
            get(target, property, receiver) {
                if (property === Symbol.iterator) {
                    throw new Error('projects should not be iterated without project search terms');
                }
                return Reflect.get(target, property, receiver);
            },
        });

        const results = filterTasksBySearch(tasks, projects, 'status:inbox');
        expect(results).toHaveLength(1);
    });
});
