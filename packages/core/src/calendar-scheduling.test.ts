import { describe, expect, it } from 'vitest';

import {
    addCalendarMinutes,
    buildCalendarEventTaskDraft,
    buildCalendarPushEventFields,
    hasCalendarPushTaskMarker,
    calendarPushTaskMarkerLine,
    notesCarryCalendarPushTaskMarker,
    buildCalendarQuickAddTaskDraft,
    createCustomTimeEstimate,
    findFreeSlotForDay,
    formatCalendarDurationLabel,
    formatTimeEstimateLabel,
    formatCalendarTimeInputValue,
    isSlotFreeForDay,
    minutesToTimeEstimate,
    minutesToTimeEstimateBucket,
    normalizeCalendarDurationMinutes,
    parseTimeEstimateInput,
    parseCalendarTimeOnDate,
    resolveTimeEstimateOptions,
    TIME_ESTIMATE_OPTIONS,
    timeEstimateToFilterBucket,
    timeEstimateToMinutes,
} from './calendar-scheduling';
import { buildQuickAddParseOptions, parseQuickAdd } from './quick-add';
import type { Area, ExternalCalendarEvent, Project, Task } from './index';

const task = (overrides: Partial<Task>): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
    ...overrides,
});

const event = (overrides: Partial<ExternalCalendarEvent>): ExternalCalendarEvent => ({
    id: 'event-1',
    sourceId: 'work',
    title: 'Event',
    start: '2026-04-26T09:00:00.000Z',
    end: '2026-04-26T10:00:00.000Z',
    allDay: false,
    ...overrides,
});

const project = (overrides: Partial<Project>): Project => ({
    id: 'project-1',
    title: 'Launch',
    status: 'active',
    color: '#94a3b8',
    order: 0,
    tagIds: [],
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
    ...overrides,
});

const area = (overrides: Partial<Area>): Area => ({
    id: 'area-1',
    name: 'Work',
    order: 0,
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
    ...overrides,
});


const STUB_UNIT_TRANSLATIONS: Record<string, string> = {
    'units.minutesShort': '{{minutes}}min',
    'units.hoursShort': '{{hours}}hr',
    'units.hoursMinutesShort': '{{hours}}hr{{minutes}}min',
    'units.hoursPlusShort': '{{hours}}hr+',
};
const stubT = (key: string): string => STUB_UNIT_TRANSLATIONS[key] ?? key;

describe('calendar scheduling helpers', () => {
    it('maps Mindwtr time estimates to calendar minutes', () => {
        expect(timeEstimateToMinutes('5min')).toBe(5);
        expect(timeEstimateToMinutes('1hr')).toBe(60);
        expect(timeEstimateToMinutes('4hr+')).toBe(240);
        expect(timeEstimateToMinutes(createCustomTimeEstimate(150))).toBe(150);
        expect(timeEstimateToMinutes(undefined)).toBe(30);
        expect(timeEstimateToMinutes('2hr', { enabled: false })).toBe(30);
    });


    it('offers every time estimate, plus a custom one the task already has', () => {
        expect(TIME_ESTIMATE_OPTIONS).toEqual(['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+']);
        expect(resolveTimeEstimateOptions()).toEqual(TIME_ESTIMATE_OPTIONS);
        expect(resolveTimeEstimateOptions('30min')).toEqual(TIME_ESTIMATE_OPTIONS);
        expect(resolveTimeEstimateOptions(createCustomTimeEstimate(75))).toEqual([...TIME_ESTIMATE_OPTIONS, 'custom:75']);
    });

    it('maps calendar minutes back to exact Mindwtr time estimates', () => {
        expect(minutesToTimeEstimate(15)).toBe('15min');
        expect(minutesToTimeEstimate(45)).toBe('custom:45');
        expect(minutesToTimeEstimate(241)).toBe('custom:241');
    });

    it('buckets exact custom estimates for coarse time filters', () => {
        expect(minutesToTimeEstimateBucket(45)).toBe('1hr');
        expect(minutesToTimeEstimateBucket(150)).toBe('3hr');
        expect(minutesToTimeEstimateBucket(241)).toBe('4hr+');
        expect(timeEstimateToFilterBucket(createCustomTimeEstimate(150))).toBe('3hr');
        expect(timeEstimateToFilterBucket('2hr')).toBe('2hr');
        expect(timeEstimateToFilterBucket(undefined)).toBeUndefined();
    });

    it('formats and parses custom time estimates', () => {


        expect(formatTimeEstimateLabel(createCustomTimeEstimate(150))).toBe('2h 30m');
        expect(formatTimeEstimateLabel(createCustomTimeEstimate(150), { t: stubT })).toBe('2hr30min');


        expect(formatTimeEstimateLabel(createCustomTimeEstimate(90))).toBe('1h 30m');
        expect(formatTimeEstimateLabel(createCustomTimeEstimate(90), { t: stubT })).toBe('1hr30min');
        expect(parseTimeEstimateInput('150')).toBe(150);
        expect(parseTimeEstimateInput('150m')).toBe(150);
        expect(parseTimeEstimateInput('2h30')).toBe(150);
        expect(parseTimeEstimateInput('2.5h')).toBe(150);
        expect(parseTimeEstimateInput('')).toBeNull();
    });

    it('normalizes arbitrary calendar durations to supported estimate buckets', () => {
        expect(normalizeCalendarDurationMinutes(44)).toBe(60);
        expect(normalizeCalendarDurationMinutes(241)).toBe(240);
    });

    it('formats and parses calendar time inputs on a given day', () => {
        const base = new Date(2026, 3, 26, 8, 5);
        expect(formatCalendarTimeInputValue(base)).toBe('08:05');
        expect(addCalendarMinutes(base, 35).getHours()).toBe(8);
        expect(addCalendarMinutes(base, 35).getMinutes()).toBe(40);

        const parsed = parseCalendarTimeOnDate(base, '9:30');
        expect(parsed?.getFullYear()).toBe(2026);
        expect(parsed?.getHours()).toBe(9);
        expect(parsed?.getMinutes()).toBe(30);
        expect(parseCalendarTimeOnDate(base, '9:30 AM')?.getHours()).toBe(9);
        expect(parseCalendarTimeOnDate(base, '9 PM')?.getHours()).toBe(21);
        expect(parseCalendarTimeOnDate(base, '12:15 am')?.getHours()).toBe(0);
        expect(parseCalendarTimeOnDate(base, '12:15 pm')?.getHours()).toBe(12);
        expect(parseCalendarTimeOnDate(base, '24:00')).toBeNull();
        expect(parseCalendarTimeOnDate(base, '13:00 PM')).toBeNull();
    });

    it('formats duration labels', () => {
        expect(formatCalendarDurationLabel(30)).toBe('30m');
        expect(formatCalendarDurationLabel(90)).toBe('1.5h');
        expect(formatCalendarDurationLabel(120)).toBe('2h');
        expect(formatCalendarDurationLabel(30, { t: stubT })).toBe('30min');
        expect(formatCalendarDurationLabel(120, { t: stubT })).toBe('2hr');

        expect(formatCalendarDurationLabel(90, { locale: 'de-DE' })).toBe('1,5h');
    });

    it('builds a quick-add draft while keeping the selected calendar slot authoritative', () => {
        const selectedStart = new Date('2026-04-26T14:00:00.000Z');
        const draft = buildCalendarQuickAddTaskDraft(
            'Draft launch plan +Launch @computer #deep /note:Outline next steps /start:tomorrow /next',
            {
                durationMinutes: 30,
                now: new Date('2026-04-25T10:00:00.000Z'),
                projects: [project({ id: 'project-launch' })],
                start: selectedStart,
            }
        );

        expect(draft.title).toBe('Draft launch plan');
        expect(draft.invalidDateCommands).toEqual([]);
        expect(draft.dateCoherenceIssues).toEqual([]);
        expect(draft.props).toEqual(expect.objectContaining({
            contexts: ['@computer'],
            description: 'Outline next steps',
            projectId: 'project-launch',
            startTime: selectedStart.toISOString(),
            status: 'next',
            tags: ['#deep'],
            timeEstimate: '30min',
        }));
    });


    it('resolves multi-word contexts and people exactly like quick add', () => {
        const input = 'Sync notes @John Smith %"Jim Smith"';
        const now = new Date('2026-04-25T10:00:00.000Z');
        const parseOptions = buildQuickAddParseOptions(
            {},
            {
                tasks: [task({ id: 'seed', contexts: ['@John Smith'] })],
                people: [{ id: 'person-jim', name: 'Jim Smith', createdAt: now.toISOString(), updatedAt: now.toISOString() }],
            },
        );

        const draft = buildCalendarQuickAddTaskDraft(input, {
            durationMinutes: 30,
            now,
            parseOptions,
            start: new Date('2026-04-26T14:00:00.000Z'),
        });
        const quickAdd = parseQuickAdd(input, undefined, now, undefined, parseOptions);

        expect(draft.title).toBe(quickAdd.title);
        expect(draft.props.contexts).toEqual(quickAdd.props.contexts);
        expect(draft.props.assignedTo).toBe(quickAdd.props.assignedTo);

        expect(draft.props.contexts).toEqual(['@John Smith']);
        expect(draft.props.assignedTo).toBe('Jim Smith');
    });

    it('keeps new-project intent separate for the caller to create', () => {
        const draft = buildCalendarQuickAddTaskDraft('Plan campaign +Launch !Work', {
            areas: [area({ id: 'area-work' })],
            durationMinutes: 60,
            projects: [],
            start: new Date('2026-04-26T14:00:00.000Z'),
        });

        expect(draft.title).toBe('Plan campaign');
        expect(draft.projectTitle).toBe('Launch');
        expect(draft.props.areaId).toBe('area-work');
        expect(draft.props.projectId).toBeUndefined();
    });

    it('does not assign inactive projects from calendar quick add', () => {
        const draft = buildCalendarQuickAddTaskDraft('Plan archive +Launch', {
            durationMinutes: 30,
            projects: [project({ id: 'project-archived', status: 'archived' })],
            start: new Date('2026-04-26T14:00:00.000Z'),
        });

        expect(draft.projectTitle).toBe('Launch');
        expect(draft.props.projectId).toBeUndefined();
    });

    it('flags a quick-add due date that would be before the selected calendar slot', () => {
        const draft = buildCalendarQuickAddTaskDraft('Review launch /due:2026-04-25', {
            durationMinutes: 30,
            now: new Date('2026-04-24T10:00:00.000Z'),
            start: new Date('2026-04-26T14:00:00.000Z'),
        });

        expect(draft.dateCoherenceIssues).toEqual([
            { code: 'start_after_due', field: 'startTime', relatedField: 'dueDate' },
        ]);
    });

    it('keeps external event locations in the task location field', () => {
        const draft = buildCalendarEventTaskDraft(event({
            description: 'Discuss launch.',
            location: 'Room 1',
        }), { calendarName: 'Work' });

        expect(draft.initialProps.location).toBe('Room 1');
        expect(draft.initialProps.description).toBe('Discuss launch.\n\nCalendar: Work');
    });

    it('finds the first open slot around external events and scheduled tasks', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [
                event({
                    start: '2026-04-26T08:00:00',
                    end: '2026-04-26T09:00:00',
                }),
            ],
            now: new Date(2026, 3, 25, 12, 0),
            tasks: [
                task({
                    id: 'task-2',
                    startTime: '2026-04-26T09:00:00',
                    timeEstimate: '30min',
                }),
            ],
        });

        expect(slot?.getHours()).toBe(9);
        expect(slot?.getMinutes()).toBe(30);
    });

    it('clamps timed external events that started before the selected day', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [
                event({
                    start: '2026-04-25T22:00:00',
                    end: '2026-04-26T08:45:00',
                }),
            ],
            now: new Date(2026, 3, 25, 12, 0),
            tasks: [],
        });

        expect(slot?.getHours()).toBe(8);
        expect(slot?.getMinutes()).toBe(45);
    });

    it('returns null when external events fill the available workday', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            dayEndHour: 10,
            dayStartHour: 8,
            durationMinutes: 30,
            events: [
                event({
                    start: '2026-04-26T08:00:00',
                    end: '2026-04-26T10:00:00',
                }),
            ],
            now: new Date(2026, 3, 25, 12, 0),
            tasks: [],
        });

        expect(slot).toBeNull();
    });

    it('ignores all-day external events for free-slot detection', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [
                event({
                    allDay: true,
                    start: '2026-04-26T00:00:00',
                    end: '2026-04-27T00:00:00',
                }),
            ],
            now: new Date(2026, 3, 25, 12, 0),
            tasks: [],
        });

        expect(slot?.getHours()).toBe(8);
        expect(slot?.getMinutes()).toBe(0);
    });

    it('ignores date-only task starts for free-slot detection', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [],
            now: new Date(2026, 3, 25, 12, 0),
            tasks: [
                task({
                    id: 'task-date-only',
                    startTime: '2026-04-26',
                    timeEstimate: '4hr',
                }),
            ],
        });

        expect(slot?.getHours()).toBe(8);
        expect(slot?.getMinutes()).toBe(0);
    });

    it('rounds today slots forward to the configured snap interval', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [],
            now: new Date(2026, 3, 26, 8, 7),
            tasks: [],
        });

        expect(slot?.getHours()).toBe(8);
        expect(slot?.getMinutes()).toBe(10);
    });

    it('rounds free slots after busy intervals forward to the configured snap interval', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [
                event({
                    start: '2026-04-26T08:00:00',
                    end: '2026-04-26T10:07:00',
                }),
            ],
            now: new Date(2026, 3, 25, 12, 0),
            snapMinutes: 15,
            tasks: [],
        });

        expect(slot?.getHours()).toBe(10);
        expect(slot?.getMinutes()).toBe(15);
    });

    it('checks candidate slots against blocking intervals', () => {
        const base = {
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [
                event({
                    start: '2026-04-26T10:00:00',
                    end: '2026-04-26T11:00:00',
                }),
            ],
            tasks: [],
        };

        expect(isSlotFreeForDay({
            ...base,
            startTime: new Date(2026, 3, 26, 9, 30),
        })).toBe(true);
        expect(isSlotFreeForDay({
            ...base,
            startTime: new Date(2026, 3, 26, 10, 30),
        })).toBe(false);
    });

    it('allows slots outside the visible calendar window when they do not overlap', () => {
        expect(isSlotFreeForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [],
            startTime: new Date(2026, 3, 26, 6, 30),
            tasks: [],
        })).toBe(true);
    });

    it('excludes the task being edited from slot collision checks', () => {
        const base = {
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [],
            startTime: new Date(2026, 3, 26, 10, 0),
            tasks: [
                task({
                    id: 'task-1',
                    startTime: '2026-04-26T10:00:00',
                    timeEstimate: '30min',
                }),
            ],
        };

        expect(isSlotFreeForDay(base)).toBe(false);
        expect(isSlotFreeForDay({ ...base, excludeTaskId: 'task-1' })).toBe(true);
    });

    it('does not treat date-only task starts as timed collisions', () => {
        expect(isSlotFreeForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [],
            startTime: new Date(2026, 3, 26, 8, 0),
            tasks: [
                task({
                    id: 'task-date-only',
                    startTime: '2026-04-26',
                    timeEstimate: '4hr',
                }),
            ],
        })).toBe(true);
    });
});

describe('buildCalendarPushEventFields (#743)', () => {
    const linkAttachment = (uri: string) => ({
        id: 'att-1',
        kind: 'link' as const,
        title: 'Link',
        uri,
        createdAt: '2026-04-26T00:00:00.000Z',
        updatedAt: '2026-04-26T00:00:00.000Z',
    });

    it('includes project, section, status, and effort in the notes', () => {
        const result = buildCalendarPushEventFields(
            task({ status: 'next', timeEstimate: '30min', description: 'Draft the deck' }),
            { projectName: 'Launch', sectionName: 'Prep' },
        );
        expect(result.notes).toContain('Project: Launch › Prep');
        expect(result.notes).toContain('Status: Next');
        expect(result.notes).toContain('Effort: 30 min');
        expect(result.notes).toContain('Draft the deck');
        expect(result.url).toBeNull();
        expect(hasCalendarPushTaskMarker(result.notes)).toBe(true);
    });

    it('keeps task text and links while appending an encoded identity marker', () => {
        const result = buildCalendarPushEventFields(task({
            id: 'task:projected/one', description: 'Keep my notes',
            attachments: [linkAttachment('https://example.com/doc')],
        }));
        expect(result.notes).toContain('Keep my notes');
        expect(result.notes).toContain('Link: https://example.com/doc');
        expect(result.notes).toMatch(/\n\n\[Mindwtr Calendar Mirror\]\nMindwtr-Task-ID: task%3Aprojected%2Fone\n\[\/Mindwtr Calendar Mirror\]$/);
        expect(hasCalendarPushTaskMarker(result.notes.replace(/\n/g, '\r\n'))).toBe(true);
    });


    it('tells whether an event\'s notes carry one task\'s marker line, and names no line for a task ID it cannot encode', () => {
        const notes = buildCalendarPushEventFields(task({ id: 'task:projected/one', description: 'Mindwtr-Task-ID: someone-else' })).notes;
        const line = calendarPushTaskMarkerLine('task:projected/one');
        expect(line).toBe('Mindwtr-Task-ID: task%3Aprojected%2Fone');
        expect(notesCarryCalendarPushTaskMarker(notes, line!)).toBe(true);
        expect(notesCarryCalendarPushTaskMarker(`${notes.replace(/\n/g, '\r\n')}  \r\n`, line!)).toBe(true);
        expect(notesCarryCalendarPushTaskMarker(notes, calendarPushTaskMarkerLine('task-two')!)).toBe(false);
        expect(notesCarryCalendarPushTaskMarker('Dentist', line!)).toBe(false);
        expect(notesCarryCalendarPushTaskMarker(null, line!)).toBe(false);
        expect(calendarPushTaskMarkerLine(' padded ')).toBeNull();
        expect(calendarPushTaskMarkerLine('')).toBeNull();
    });

    it('still finds the marker when a calendar service pads the notes with trailing whitespace', () => {
        const notes = 'Project: Update Will\nStatus: Next\n\n[Mindwtr Calendar Mirror]\nMindwtr-Task-ID: 3f7e355c-620d-4ee9-a8d6-23cc15f1903a\n[/Mindwtr Calendar Mirror]';
        expect(hasCalendarPushTaskMarker(notes)).toBe(true);
        expect(hasCalendarPushTaskMarker(`${notes}\n`)).toBe(true);
        expect(hasCalendarPushTaskMarker(`${notes} \r\n\r\n`)).toBe(true);
        expect(hasCalendarPushTaskMarker(notes.replace(/\n/g, ' \n'))).toBe(true);

        expect(hasCalendarPushTaskMarker(notes.replace('\n\n[Mindwtr', '\n[Mindwtr'))).toBe(false);
    });

    it('rejects malformed markers and incidental prose mentions', () => {
        const marker = '[Mindwtr Calendar Mirror]\nMindwtr-Task-ID: task-123\n[/Mindwtr Calendar Mirror]';
        expect(hasCalendarPushTaskMarker(`Please read ${marker}`)).toBe(false);
        expect(hasCalendarPushTaskMarker(marker.replace('task-123', ''))).toBe(false);
        expect(hasCalendarPushTaskMarker(marker.replace('task-123', 'bad%ZZ'))).toBe(false);
        expect(hasCalendarPushTaskMarker(marker.replace('task-123', 'bad%20id'))).toBe(true);
        expect(hasCalendarPushTaskMarker(marker.replace('task-123', '%20'))).toBe(false);
        expect(hasCalendarPushTaskMarker('Mindwtr-Task-ID: task-123')).toBe(false);
    });

    it('omits the effort line when the task has no estimate', () => {
        const result = buildCalendarPushEventFields(task({ timeEstimate: undefined }));
        expect(result.notes).not.toContain('Effort:');
    });

    it('maps an external link to the url field and the notes', () => {
        const result = buildCalendarPushEventFields(
            task({ attachments: [linkAttachment('https://example.com/doc')] }),
        );
        expect(result.url).toBe('https://example.com/doc');
        expect(result.notes).toContain('Link: https://example.com/doc');
    });

    it('drops internal mindwtr:// links that do not resolve in external calendars', () => {
        const result = buildCalendarPushEventFields(
            task({ attachments: [linkAttachment('mindwtr://task/abc')] }),
        );
        expect(result.url).toBeNull();
        expect(result.notes).not.toContain('mindwtr://');
    });

    it('prepends a leading note ahead of metadata and description', () => {
        const result = buildCalendarPushEventFields(
            task({ status: 'inbox', description: 'Body', timeEstimate: undefined }),
            { leadingNote: 'Projected occurrence.' },
        );
        expect(result.notes.startsWith('Projected occurrence.')).toBe(true);
        expect(result.notes).toContain('Body');
    });
});


it('keeps the calendar selected duration over a parsed estimate (#1358)', () => {
    const draft = buildCalendarQuickAddTaskDraft('Write report /estimate:45m', {
        durationMinutes: 120,
        start: new Date('2026-10-11T14:00:00.000Z'),
    });
    expect(draft.title).toBe('Write report');
    expect(draft.props.timeEstimate).toBe('2hr');
});
