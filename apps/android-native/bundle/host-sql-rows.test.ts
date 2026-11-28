import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { rowsFromArrayReply } from './host-sql-rows';

type Case = { sql: string; params: string; objects: string; arrays: string };

const corpus = JSON.parse(readFileSync(new URL('./host-sql-rows.corpus.json', import.meta.url), 'utf8')) as Case[];
const frozenFile = new URL('./host-sql-rows.digests.json', import.meta.url);

const describeValue = (value: unknown): unknown => (Object.is(value, -0) ? '-0' : [typeof value, value]);

const digest = (rows: unknown[]): string => createHash('sha256').update(JSON.stringify(rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
        prototype: Object.getPrototypeOf(record) === Object.prototype,
        keys: Reflect.ownKeys(record).map((key) => {
            const property = Object.getOwnPropertyDescriptor(record, key)!;
            return [String(key), property.enumerable, property.writable, property.configurable, describeValue(property.value)];
        }),
    };
}))).digest('hex');

describe('SQL rows from the Android array reply', () => {
    it('builds exactly the row objects that parsing the old object reply built, for every corpus case', () => {
        const oldDigests = corpus.map((entry) => digest(JSON.parse(entry.objects) as unknown[]));
        if (process.env.UPDATE_SQL_ROWS_DIGESTS === '1') writeFileSync(frozenFile, `${JSON.stringify(oldDigests, null, 1)}\n`);
        const frozen = JSON.parse(readFileSync(frozenFile, 'utf8')) as string[];

        expect(corpus.length).toBeGreaterThan(9);
        expect(oldDigests).toEqual(frozen);
        expect(corpus.map((entry) => digest(rowsFromArrayReply(entry.arrays)))).toEqual(frozen);
    });

    it('keeps a __proto__ column as an own property and a repeated column in its first place with its last value', () => {
        const [row] = rowsFromArrayReply<Record<string, unknown>>('[["__proto__","b","1","b","__proto__"],[1,2,3,4,5]]');

        expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
        expect(Object.entries(row)).toEqual([['1', 3], ['__proto__', 5], ['b', 4]]);
    });

    it('returns no rows for a reply that only names its columns', () => {
        expect(rowsFromArrayReply('[["id","title"]]')).toEqual([]);
    });
});
