import { describe, expect, it } from 'vitest';
import { buildQuickAddPreviewEntries } from './quick-add-preview';
import { buildQuickAddParseOptions, parseQuickAdd } from './quick-add';
import type { Project } from './types';

const t = (key: string) => key;

const project = (overrides: Partial<Project> = {}): Project => ({
    id: 'p1',
    title: 'Home Reno',
    color: '#000000',
    status: 'active',
    order: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
} as Project);

const now = new Date(2026, 7, 11, 9, 0, 0);

describe('buildQuickAddPreviewEntries', () => {
    it('shows nothing for a plain title', () => {
        const parsed = parseQuickAdd('call mom', [], now);
        expect(buildQuickAddPreviewEntries(parsed, { t, rawInput: 'call mom' })).toEqual([]);
    });

    it('renders the values the parse resolved, never the matched text', () => {
        const input = 'call mom @errands #family +"Home Reno" /due:tomorrow 5pm';
        const parsed = parseQuickAdd(input, [project()], now);
        const entries = buildQuickAddPreviewEntries(parsed, {
            t,
            projects: [project()],
            rawInput: input,
        });
        const byKind = Object.fromEntries(entries.map((entry) => [entry.kind, entry.value]));

        // The resolved date, formatted — not the words the user typed.
        expect(byKind.due).not.toContain('tomorrow');
        expect(byKind.due).toContain('2026');
        expect(byKind.context).toBe('@errands');
        expect(byKind.tag).toBe('#family');
        expect(byKind.project).toBe('Home Reno');
        expect(byKind.title).toBe('call mom');
    });

    it('shows the priority and energy levels as their own chips', () => {
        const input = 'call mom /priority:urgent /energy:low';
        const parsed = parseQuickAdd(input, [], now);
        // The identity `t` above falls back, so translate here to prove the keys.
        const translations: Record<string, string> = {
            'priority.urgent': 'Urgent',
            'energyLevel.low': 'Low energy',
            'taskEdit.priorityLabel': 'Priority',
        };
        const entries = buildQuickAddPreviewEntries(parsed, {
            t: (key: string) => translations[key] ?? key,
            rawInput: input,
        });
        const byKind = Object.fromEntries(entries.map((entry) => [entry.kind, entry.value]));

        expect(byKind.priority).toBe('Urgent');
        expect(byKind.energy).toBe('Low energy');
        expect(entries.find((entry) => entry.kind === 'priority')?.label).toBe('Priority');
    });

    it('flags every invalid date command as a warning chip', () => {
        const input = 'call mom /due:notaday';
        const parsed = parseQuickAdd(input, [], now);
        const entries = buildQuickAddPreviewEntries(parsed, { t, rawInput: input });
        expect(entries.filter((entry) => entry.tone === 'warning').map((entry) => entry.value))
            .toEqual(['/due:notaday']);
    });

    it('shows a trailing natural date as the due date it becomes', () => {
        const input = 'call mom tomorrow';
        const parsed = parseQuickAdd(input, [], now);
        expect(parsed.detectedDate?.date).toBeTruthy();
        const entries = buildQuickAddPreviewEntries(parsed, { t, rawInput: input });
        expect(entries.some((entry) => entry.kind === 'due')).toBe(true);
    });

    it('shows a picked due date instead of the trailing natural one', () => {
        const input = 'call mom tomorrow';
        const parsed = parseQuickAdd(input, [], now);
        expect(parsed.detectedDate?.date).toBeTruthy();
        const dueOf = (options: Parameters<typeof buildQuickAddPreviewEntries>[1]) =>
            buildQuickAddPreviewEntries(parsed, options).find((entry) => entry.kind === 'due')?.value;

        expect(dueOf({ t, rawInput: input })).toContain('2026');
        expect(dueOf({ t, rawInput: input, overrides: { dueDate: '2027-03-04' } })).toContain('2027');
    });

    it('shows a picked due date instead of an explicit /due command', () => {
        const input = 'call mom /due:2026-09-01';
        const parsed = parseQuickAdd(input, [], now);
        const entries = buildQuickAddPreviewEntries(parsed, {
            t,
            rawInput: input,
            overrides: { dueDate: '2027-03-04' },
        });
        expect(entries.find((entry) => entry.kind === 'due')?.value).toContain('2027');
    });

    it('shows a picked start time instead of the parsed one', () => {
        const input = 'call mom /start:2026-09-01';
        const parsed = parseQuickAdd(input, [], now);
        const entries = buildQuickAddPreviewEntries(parsed, {
            t,
            rawInput: input,
            overrides: { startTime: '2027-03-04T10:00:00.000Z' },
        });
        expect(entries.find((entry) => entry.kind === 'start')?.value).toContain('2027');
    });

    it('shows a picked project instead of one the text would create', () => {
        const input = 'call mom +Brand New';
        const parsed = parseQuickAdd(input, [], now);
        const entries = buildQuickAddPreviewEntries(parsed, {
            t,
            projects: [project()],
            rawInput: input,
            overrides: { projectId: 'p1' },
        });
        expect(entries.find((entry) => entry.kind === 'project')?.value).toBe('Home Reno');
    });

    it('keeps chip ids stable while the draft grows', () => {
        const first = parseQuickAdd('call mom @errands', [], now);
        const second = parseQuickAdd('call mom @errands #family', [], now);
        const idsOf = (parsed: typeof first) => buildQuickAddPreviewEntries(parsed, { t }).map((entry) => entry.id);
        expect(idsOf(first)).toEqual(['context:@errands']);
        expect(idsOf(second)).toEqual(['context:@errands', 'tag:#family']);
    });

    it('names a project the capture would create', () => {
        const input = 'call mom +Brand New';
        const parsed = parseQuickAdd(input, [], now);
        const entries = buildQuickAddPreviewEntries(parsed, { t, rawInput: input });
        expect(entries.find((entry) => entry.kind === 'project')?.value).toBe('Brand New');
    });

    it('shows no priority chip while the Priorities feature is off (#1107)', () => {
        const input = 'call mom /priority:high';
        const options = buildQuickAddParseOptions({ features: { priorities: false } });
        const parsed = parseQuickAdd(input, [], now, undefined, options);
        const entries = buildQuickAddPreviewEntries(parsed, { t, rawInput: input });

        expect(entries.some((entry) => entry.kind === 'priority')).toBe(false);

        const enabled = parseQuickAdd(input, [], now, undefined, buildQuickAddParseOptions({}));
        expect(buildQuickAddPreviewEntries(enabled, { t, rawInput: input })
            .some((entry) => entry.kind === 'priority')).toBe(true);
    });
});
