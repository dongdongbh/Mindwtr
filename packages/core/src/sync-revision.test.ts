import { describe, expect, it, vi } from 'vitest';
import {
    MAX_SYNC_REVISION,
    SYNC_REVISION_WARNING_THRESHOLD,
    nextRevision,
    normalizeRevision,
} from './sync-revision';

describe('sync revision helpers', () => {
    it('silently preserves cap and increment policy for pure preparation when explicitly requested', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            expect(nextRevision(MAX_SYNC_REVISION, { warn: false })).toBe(MAX_SYNC_REVISION);
            expect(nextRevision(MAX_SYNC_REVISION + 100, { warn: false })).toBe(MAX_SYNC_REVISION);
            expect(nextRevision(SYNC_REVISION_WARNING_THRESHOLD - 1, { warn: false })).toBe(SYNC_REVISION_WARNING_THRESHOLD);
            expect(warn).not.toHaveBeenCalled();
        } finally { warn.mockRestore(); }
    });
    it('increments revisions up to the safe maximum', () => {
        expect(nextRevision(undefined)).toBe(1);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            expect(nextRevision(MAX_SYNC_REVISION - 1)).toBe(MAX_SYNC_REVISION);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('warns when revisions approach the safe maximum', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            expect(nextRevision(SYNC_REVISION_WARNING_THRESHOLD - 1)).toBe(SYNC_REVISION_WARNING_THRESHOLD);
            expect(warnSpy.mock.calls.some(([message]) => (
                message === 'Sync revision approaching safe maximum'
            ))).toBe(true);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('preserves the cap and warns instead of overflowing', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            expect(nextRevision(MAX_SYNC_REVISION)).toBe(MAX_SYNC_REVISION);
            expect(warnSpy.mock.calls.some(([message]) => (
                message === 'Sync revision reached safe maximum; preserving capped revision'
            ))).toBe(true);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('clamps oversized revisions during normalization', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            expect(normalizeRevision(MAX_SYNC_REVISION + 100)).toBe(MAX_SYNC_REVISION);
            expect(warnSpy.mock.calls.some(([message]) => (
                message === 'Clamped sync revision above safe maximum'
            ))).toBe(true);
        } finally {
            warnSpy.mockRestore();
        }
    });
});
