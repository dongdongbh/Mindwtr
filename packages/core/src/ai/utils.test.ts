import { describe, expect, it, vi } from 'vitest';
import { fetchTextWithTimeout, filterReviewSuggestionsToKnownIds, parseJson } from './utils';

describe('fetchTextWithTimeout', () => {
    it('keeps the caller abort listener through body consumption and removes it afterwards', async () => {
        const controller = new AbortController();
        const add = vi.spyOn(controller.signal, 'addEventListener');
        const remove = vi.spyOn(controller.signal, 'removeEventListener');

        await expect(fetchTextWithTimeout(
            'https://example.com/models',
            {},
            1_000,
            'Models',
            controller.signal,
            async () => new Response('{"data":[]}'),
        )).resolves.toMatchObject({ bodyText: '{"data":[]}' });

        expect(add).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1]);
    });
});

describe('parseJson', () => {
    it('extracts valid JSON from surrounding model text', () => {
        expect(parseJson('Sure:\n{"ok":true}\nDone.')).toEqual({ ok: true });
    });

    it('wraps parse failures from extracted JSON candidates', () => {
        expect(() => parseJson('Sure:\n{"ok":]}\nDone.')).toThrow(/AI JSON parse error:/);
    });

    type Reviewish = { suggestions: Array<{ id: string; action: string; reason: string }> };
    const isReviewish = (value: unknown): value is Reviewish =>
        typeof value === 'object'
        && value !== null
        && Array.isArray((value as Reviewish).suggestions)
        && (value as Reviewish).suggestions.every(
            (s) => s && typeof s.id === 'string' && typeof s.action === 'string' && typeof s.reason === 'string'
        );

    it('salvages complete array elements when the response is truncated mid-array', () => {
        const truncated = '{"suggestions":[{"id":"a","action":"keep","reason":"still valid"},{"id":"b","action":"arch';
        expect(parseJson<Reviewish>(truncated, isReviewish)).toEqual({
            suggestions: [{ id: 'a', action: 'keep', reason: 'still valid' }],
        });
    });

    it('drops a trailing element that is incomplete against the validator', () => {
        // third object has id+action but its reason string was cut off
        const truncated = '{"suggestions":[{"id":"a","action":"keep","reason":"ok"},{"id":"b","action":"archive","reason":"done"},{"id":"c","action":"someday","reason":"la';
        expect(parseJson<Reviewish>(truncated, isReviewish)).toEqual({
            suggestions: [
                { id: 'a', action: 'keep', reason: 'ok' },
                { id: 'b', action: 'archive', reason: 'done' },
            ],
        });
    });

    it('recovers a truncated string array', () => {
        expect(parseJson('{"steps":["step one","step two","step th')).toEqual({
            steps: ['step one', 'step two'],
        });
    });

    it('still parses a complete response without altering it', () => {
        const full = '{"suggestions":[{"id":"a","action":"keep","reason":"ok"}]}';
        expect(parseJson<Reviewish>(full, isReviewish)).toEqual({
            suggestions: [{ id: 'a', action: 'keep', reason: 'ok' }],
        });
    });

    it('throws when no validator-complete element can be salvaged', () => {
        // The first suggestion is cut off before its required fields, so nothing validates.
        expect(() => parseJson<Reviewish>('{"suggestions":[{"id":"a","act', isReviewish)).toThrow(/AI JSON parse error:/);
    });
    it('limits repair validation attempts for payloads with many boundaries', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const validator = vi.fn((_value: unknown): _value is { items: string[] } => false);
        const quote = String.fromCharCode(34);
        const values = Array.from({ length: 120 }, (_, index) => JSON.stringify('value-' + index)).join(',');
        const truncated = '{' + quote + 'items' + quote + ':[' + values + ',';

        try {
            expect(() => parseJson(truncated, validator)).toThrow(/AI JSON parse error:/);
            expect(validator.mock.calls.length).toBeLessThanOrEqual(50);
        } finally {
            warn.mockRestore();
        }
    });
});

describe('filterReviewSuggestionsToKnownIds', () => {
    const suggestion = (id: string) => ({ id, action: 'archive', reason: 'stale' });

    it('keeps suggestions whose id was among the analyzed items', () => {
        const kept = suggestion('task-1');
        expect(filterReviewSuggestionsToKnownIds([kept], ['task-1', 'task-2'])).toEqual([kept]);
    });

    it('drops suggestions for ids that were never sent', () => {
        const kept = suggestion('task-1');
        expect(filterReviewSuggestionsToKnownIds([kept, suggestion('task-9')], ['task-1'])).toEqual([kept]);
    });

    it('keeps project-prefixed ids, which share the analyzed item list', () => {
        const kept = suggestion('project:p1');
        expect(filterReviewSuggestionsToKnownIds([kept, suggestion('project:p9')], ['project:p1'])).toEqual([kept]);
    });

    it('returns empty for an empty suggestion list', () => {
        expect(filterReviewSuggestionsToKnownIds([], ['task-1'])).toEqual([]);
    });

    it('drops everything when no ids were analyzed', () => {
        expect(filterReviewSuggestionsToKnownIds([suggestion('task-1')], [])).toEqual([]);
    });
});
