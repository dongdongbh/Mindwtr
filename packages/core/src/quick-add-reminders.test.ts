import { describe, expect, it } from 'vitest';
import { buildQuickAddParseOptions, parseQuickAdd, parseQuickAddDateCommands } from './quick-add';
import { buildQuickAddPreviewEntries } from './quick-add-preview';
import { planCaptureTask } from './capture';

const now = new Date(2026, 10, 11, 9);
const t = (name: string) => name;

describe('capture reminder syntax', () => {
    it.each([
        ['1m', 1], ['1h', 60], ['1d', 1440], ['1w', 10080], ['10080m', 10080], ['0m', 0], ['2H', 120],
    ])('parses due lead %s as %i existing minutes', (token, minutes) => {
        for (const input of [
            `Call /due:tomorrow 5pm /remind-due:${token}`,
            `Call /remind-due:${token} /due:tomorrow 5pm`,
        ]) {
            const parsed = parseQuickAdd(input, [], now);
            expect(parsed.title).toBe('Call');
            expect(parsed.props.dueReminderLeadMinutes).toBe(minutes);
            expect(parsed.invalidDateCommands).toBeUndefined();
            expect(parsed.props.reminderPolicy).toBeUndefined();
        }
    });

    it.each(['0m', '5m', '15m', '30m', '60m', '1h'])('parses existing start lead %s', token => {
        const parsed = parseQuickAdd(`Call /start:tomorrow 9am /remind-start:${token}`, [], now);
        expect(parsed.props.startReminderLeadMinutes).toBe(token === '1h' ? 60 : Number(token.slice(0, -1)));
        expect(parsed.invalidDateCommands).toBeUndefined();
    });

    it.each(['', '1', '-1m', '1.5h', '1h30m', '8d', '10081m', '1d/m', '999999999999999999999w'])('retains and refuses invalid due lead %s', token => {
        const input = `Call /due:tomorrow 5pm /remind-due:${token}`;
        const parsed = parseQuickAdd(input, [], now);
        expect(parsed.title).toContain(`/remind-due:${token}`);
        expect(parsed.props.dueReminderLeadMinutes).toBeUndefined();
        expect(parsed.invalidDateCommands).toEqual([`/remind-due:${token}`]);
        expect(planCaptureTask({ parsed, rawInput: input, projects: [] })).toMatchObject({ success: false, reason: 'invalid-date-command' });
        expect(buildQuickAddPreviewEntries(parsed, { t })).toContainEqual(expect.objectContaining({
            kind: 'warning', label: expect.stringContaining('Invalid reminder'), value: `/remind-due:${token}`,
        }));
    });

    it.each(['1m', '10m', '90m', '1d'])('does not widen the start range for %s', token => {
        expect(parseQuickAdd(`Call /start:tomorrow 9am /remind-start:${token}`, [], now).invalidDateCommands)
            .toEqual([`/remind-start:${token}`]);
    });

    it.each([
        'Call /remind-due:1d', 'Call tomorrow 5pm /remind-due:1d',
        'Call /due:tomorrow /remind-due:1d', 'Call /due:garbage /remind-due:1d',
        'Call /start:tomorrow /remind-start:30m', 'Call /due:tomorrow 9am /remind-start:30m',
    ])('requires the matching explicit timed command in %s', input => {
        const parsed = parseQuickAdd(input, [], now, [], { defaultScheduleTime: '09:00' });
        expect(parsed.invalidDateCommands?.some(command => command.startsWith('/remind-'))).toBe(true);
        expect(parsed.props.dueReminderLeadMinutes).toBeUndefined();
        expect(parsed.props.startReminderLeadMinutes).toBeUndefined();
        expect(parsed.detectedDate).toBeUndefined();
    });

    it('allows zero without creating dates or changing reminder policy', () => {
        expect(parseQuickAdd('Call /remind-due:0m /remind-start:0m', [], now)).toMatchObject({
            title: 'Call', props: { dueReminderLeadMinutes: 0, startReminderLeadMinutes: 0 },
        });
    });

    it('preserves date, note, link, and taxonomy command boundaries in either order', () => {
        const parsed = parseQuickAdd('Call /note:bring papers /remind-due:1d /due:tomorrow 5pm /link:https://example.com /start:tomorrow 9am /remind-start:30m @phone #work', [], now);
        expect(parsed).toMatchObject({ title: 'Call', props: { description: 'bring papers', dueReminderLeadMinutes: 1440,
            startReminderLeadMinutes: 30, contexts: ['@phone'], tags: ['#work'] } });
        expect(parsed.props.attachments?.[0].uri).toBe('https://example.com');
        expect(parsed.invalidDateCommands).toBeUndefined();
        const entries = buildQuickAddPreviewEntries(parsed, { t });
        expect(entries).toContainEqual(expect.objectContaining({ id: 'due-reminder', value: '1 day before' }));
        expect(entries).toContainEqual(expect.objectContaining({ id: 'start-reminder', value: '30 min before' }));
    });

    it.each([true, false])('refuses unsupported absolute reminder syntax with auto-clean %s without extracting a due date', quickAddAutoClean => {
        const input = 'Call /remind:tomorrow 5pm';
        const parsed = parseQuickAdd(input, [], now, [], buildQuickAddParseOptions({ quickAddAutoClean }));
        expect(parsed.title).toBe(input);
        expect(parsed.props).toEqual({});
        expect(parsed.detectedDate).toBeUndefined();
        expect(parsed.invalidDateCommands).toEqual(['/remind:tomorrow 5pm']);
        expect(planCaptureTask({ parsed, rawInput: input, projects: [] })).toMatchObject({ success: false, reason: 'invalid-date-command' });
    });

    it('preserves unsupported absolute reminders and escaped reminder text', () => {
        expect(parseQuickAdd('Call /remind:tomorrow', [], now).title).toBe('Call /remind:tomorrow');
        expect(parseQuickAdd(String.raw`Call \/remind-due:1d`, [], now).title).toBe('Call /remind-due:1d');
    });

    it('keeps the date-only command consumer aligned', () => {
        expect(parseQuickAddDateCommands('Call /remind-start:30m /start:tomorrow 9am', now)).toMatchObject({
            title: 'Call', props: { startReminderLeadMinutes: 30 }, invalidDateCommands: undefined,
        });
    });
});
