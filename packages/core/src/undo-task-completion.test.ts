import { describe, expect, it } from 'vitest';

import { formatProcessInboxCommitMessage } from './process-inbox-model';
import { formatSomedaySectionMoved } from './someday-sections-model';
import { formatTaskMarkedDoneMessage, formatTaskMovedMessage } from './undo-task-completion';

// The two keys ship with different placeholder conventions ('{title}' vs
// '{{title}}'); the formatters interpret the keys as they are, so both platforms
// get the same text from one home instead of hand-rolling a `.replace` each.
describe('task action toast text', () => {
    const passthrough = (key: string) => key;

    it('falls back to English when the key is missing', () => {
        expect(formatTaskMarkedDoneMessage(passthrough, 'File taxes')).toBe('File taxes marked Done');
        expect(formatTaskMovedMessage(passthrough, 'File taxes', 'waiting'))
            .toBe('File taxes moved to waiting');
    });

    it('fills a translated template and the translated status name', () => {
        const t = (key: string) => (
            key === 'task.markedDone' ? '{title} erledigt'
                : key === 'task.movedToStatus' ? '{{title}} nach {{status}} verschoben'
                    : key === 'status.waiting' ? 'Wartend'
                        : key
        );
        expect(formatTaskMarkedDoneMessage(t, 'Steuern')).toBe('Steuern erledigt');
        expect(formatTaskMovedMessage(t, 'Steuern', 'waiting')).toBe('Steuern nach Wartend verschoben');
    });

    it('inserts a title or section name literally, even with $ replacement patterns', () => {
        // String.replace expands $&, $$ and $1 in a replacement string.
        const title = 'Pay $& and $$ {{status}}';
        expect(formatTaskMarkedDoneMessage(passthrough, title)).toBe(`${title} marked Done`);
        expect(formatTaskMovedMessage(passthrough, title, 'waiting')).toBe(`${title} moved to waiting`);
        expect(formatProcessInboxCommitMessage(passthrough, 'trash', title)).toBe(`${title} moved to Trash`);
        expect(formatSomedaySectionMoved(passthrough, 2, 'Ideas $&')).toBe('Moved to Ideas $& (2)');
    });
});
