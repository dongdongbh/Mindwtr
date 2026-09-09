import { describe, expect, it } from 'vitest';
import { chooseDeterministicWinner, toComparableValue } from './sync-signatures';

// Pinned pre-optimization implementation. This is intentionally independent
// of production helpers: changing signature bytes can change equal-revision
// winners across app versions even when both versions look deterministic alone.
const ignored = new Set(['rev', 'revBy', 'updatedAt', 'createdAt', 'localStatus', 'purgedAt', 'order', 'orderNum', 'boardOrder', 'focusOrder']);
const opaque = new Set(['statusBeforeProjectArchive', 'completedAtBeforeProjectArchive', 'isFocusedTodayBeforeProjectArchive', 'deletedAtBeforeProjectArchive', 'projectArchivedAt']);
function legacy(value: unknown, includeIgnoredKeys = false): unknown {
    if (Array.isArray(value)) {
        const array = value.map(item => legacy(item, includeIgnoredKeys)).filter(item => item !== undefined && item !== null);
        return array.length ? array : undefined;
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
            if (opaque.has(key)) continue;
            if (!includeIgnoredKeys && ignored.has(key)) continue;
            if (!includeIgnoredKeys && key === 'uri' && record.kind === 'file') continue;
            const next = legacy(record[key], includeIgnoredKeys);
            if (next === undefined || next === null) continue;
            result[key] = next;
        }
        return Object.keys(result).length ? result : undefined;
    }
    if (typeof value === 'string') return value.trim() || undefined;
    return value;
}

function corpus(): unknown[] {
    let state = 718;
    const random = (length: number) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % length;
    };
    const leaves = [undefined, null, '', '  ', ' alpha ', '0', 0, -0, 1, false, true, NaN, Infinity];
    const names = ['title', 'id', 'z', 'a', '2', '10', 'rev', 'revBy', 'order', 'localStatus', 'purgedAt', 'statusBeforeProjectArchive', 'uri', 'kind', 'contexts'];
    const value = (depth: number): unknown => {
        if (!depth || random(3) === 0) return leaves[random(leaves.length)];
        if (random(3) === 0) return Array.from({ length: random(5) }, () => value(depth - 1));
        const result: Record<string, unknown> = {};
        for (let i = 0, length = random(12); i < length; i++) result[names[random(names.length)]] = value(depth - 1);
        return result;
    };
    return [
        {}, [], [null, undefined, '', {}, []], { b: undefined, a: null },
        JSON.parse('{"__proto__":{"title":"legacy"}}'),
        JSON.parse('{"__proto__":{"title":"legacy"},"constructor":"keep","id":"1"}'),
        { 'é': 1, '中': 2, 'a': 3, '10': 'ten', '2': 'two' },
        { kind: 'file', uri: '/local/file', rev: 3, localStatus: 'available', title: ' A ' },
        { kind: 'link', uri: 'https://example.test', order: 0, projectArchivedAt: '2026-01-01' },
        { viewSectionIds: { next: 'one', inbox: 'two' }, nested: { rev: 4, description: ' Keep ' } },
        ...Array.from({ length: 500 }, () => value(3)),
    ];
}

describe('signature optimization cross-version parity', () => {
    it('keeps exact JSON bytes for both content and deterministic signatures', () => {
        for (const value of corpus()) {
            for (const includeIgnoredKeys of [false, true]) {
                expect(JSON.stringify(toComparableValue(value, { includeIgnoredKeys })))
                    .toBe(JSON.stringify(legacy(value, includeIgnoredKeys)));
            }
        }
    });

    it('keeps equal-time winner selection identical to the previous implementation', () => {
        const values = corpus().filter(value => value && typeof value === 'object');
        for (let i = 0; i < values.length; i++) {
            const left = values[i];
            const right = i % 3 === 0 ? structuredClone(left) : values[(i + 1) % values.length];
            const a = JSON.stringify(legacy(left));
            const b = JSON.stringify(legacy(right));
            const fullA = a === b ? JSON.stringify(legacy(left, true)) : a;
            const fullB = a === b ? JSON.stringify(legacy(right, true)) : b;
            const winner = fullA === fullB || fullB! > fullA! ? right : left;
            expect(chooseDeterministicWinner(left, right)).toBe(winner);
        }
    });
});
