import { describe, expect, it } from 'vitest';
import { isFileContentChange } from './file-change-event';

describe('file content events', () => {
    it.each([
        { access: { kind: 'open', mode: 'any' } },
        { access: { kind: 'close', mode: 'read' } },
        { access: { kind: 'close', mode: 'write' } },
        { access: { kind: 'any' } },
        { modify: { kind: 'metadata', mode: 'access-time' } },
    ])('ignores read-side and access-only events: %j', type => {
        expect(isFileContentChange({ type })).toBe(false);
    });
    it.each([
        undefined, 'any', 'other', {},
        { create: { kind: 'file' } }, { remove: { kind: 'file' } },
        { modify: { kind: 'data', mode: 'content' } },
        { modify: { kind: 'rename', mode: 'both' } },
        { modify: { kind: 'metadata', mode: 'write-time' } },
    ])('preserves content, replacement, and unknown events: %j', type => {
        expect(isFileContentChange({ type })).toBe(true);
    });
});
