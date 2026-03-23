import { describe, expect, it } from 'vitest';

import { getBulkActionFailureMessage } from './task-list-utils';

describe('getBulkActionFailureMessage', () => {
    it('returns the error message when one exists', () => {
        expect(getBulkActionFailureMessage(new Error('Tasks not found: t1'), 'Move failed.')).toBe('Tasks not found: t1');
    });

    it('uses the fallback when the error message is empty', () => {
        expect(getBulkActionFailureMessage(new Error('   '), 'Delete failed.')).toBe('Delete failed.');
    });
});
