// Pass D1c step 0 (design §8, code review P2): the transfer limit check-data-device.mjs proposes from its measured rows.
import { describe, expect, it } from 'bun:test';
import { boundaryVerdict, MEASURE_SHAPES, MEASURE_WORKLOADS, proposeTransferLimit, rowBound } from './data-transfer-limit.mjs';
import { IMPORT_TEXT_CAP_BYTES, importTexts } from './data-measure-fixtures.mjs';

const row = (shape, workload, fields) => ({ shape, workload, sourceMiB: 0, libraryBeforeMiB: 0, libraryAfterMiB: 0, pass: true, ...fields });
/** Every workload and shape, each passing at [mib] (a file over nothing; an import leaving that library). */
const everyWorkload = (mib) => MEASURE_SHAPES.flatMap((shape) => MEASURE_WORKLOADS.map((workload) => row(shape, workload,
    workload.startsWith('import-') ? { libraryAfterMiB: mib } : { sourceMiB: mib })));

describe('the step 0 transfer limit', () => {
    it('is half of the smallest workload bound when every workload and shape has rows', () => {
        const rows = [...everyWorkload(64), row('notes', 'merge-over', { sourceMiB: 20, libraryBeforeMiB: 20 }), row('notes', 'merge-over', { sourceMiB: 30, libraryBeforeMiB: 30, pass: false })];
        expect(proposeTransferLimit(rows.filter((item) => !(item.shape === 'notes' && item.workload === 'merge-over' && item.sourceMiB === 64)))).toMatchObject({ limitMiB: 20, smallestMiB: 40 });
    });

    it('a failing smaller row caps its workload, whatever larger rows passed (8 MiB fails, 16 passes: no limit above 0)', () => {
        const rows = everyWorkload(64).filter((item) => !(item.shape === 'rows' && item.workload === 'restore-fresh'));
        rows.push(row('rows', 'restore-fresh', { sourceMiB: 8, pass: false }), row('rows', 'restore-fresh', { sourceMiB: 16 }));
        expect(proposeTransferLimit(rows)).toMatchObject({ limitMiB: 0 });
    });

    it('a TaskNotes export, bounded at 12 MiB on its own, never caps the limit', () => {
        const rows = [...everyWorkload(64), row('rows', 'export-tasknotes', { libraryBeforeMiB: 26, pass: false })];
        expect(proposeTransferLimit(rows)).toMatchObject({ limitMiB: 32 });
    });

    it('proposes nothing while a workload or shape has no row', () => {
        const rows = everyWorkload(64).filter((item) => !(item.shape === 'notes' && item.workload === 'capture'));
        const proposal = proposeTransferLimit(rows);
        expect(proposal.limitMiB).toBeNull();
        expect(proposal.missing).toEqual(['notes/capture']);
    });

    it('counts an import by the library it left, not its compressed file over the library before', () => {
        expect(rowBound(row('rows', 'import-todoist', { sourceMiB: 1, libraryBeforeMiB: 40, libraryAfterMiB: 140 }))).toBe(140);
        expect(rowBound(row('rows', 'restore-over', { sourceMiB: 30, libraryBeforeMiB: 40, libraryAfterMiB: 35 }))).toBe(70);
    });

    // Code review 2 #5: an import counts the library it left alone; a duplicate import that adds nothing counts that library.
    it('counts an 8 MiB duplicate import over 40 MiB that leaves 40 MiB as 40', () => {
        expect(rowBound(row('rows', 'import-mindwtr-csv', { sourceMiB: 8, libraryBeforeMiB: 40, libraryAfterMiB: 40 }))).toBe(40);
    });

    it('is established only once every workload and shape passed again at its admitted boundary', () => {
        const boundary = everyWorkload(20).map((item) => ({ ...item, boundary: true }));
        expect(boundaryVerdict(boundary, 20)).toMatchObject({ established: true });
        const failed = boundary.map((item) => (item.workload === 'undo' && item.shape === 'rows' ? { ...item, pass: false } : item));
        expect(boundaryVerdict(failed, 20)).toMatchObject({ established: false, failed: ['rows/undo'] });
        expect(boundaryVerdict(boundary.filter((item) => item.workload !== 'cold-start'), 20)).toMatchObject({ established: false, missing: ['rows/cold-start', 'notes/cold-start'] });
    });

    // Code review 2 #4: a boundary row proves the limit only by its bytes: at the limit (within 15 %), or with a refused attempt
    // just above it (the app's own admission says nothing larger runs). Every workload at 2 MiB does not establish 32.
    it('checks each boundary row\'s bytes, not its label', () => {
        const small = everyWorkload(2).map((item) => ({ ...item, boundary: true }));
        const verdict = boundaryVerdict(small, 32);
        expect(verdict.established).toBe(false);
        expect(verdict.belowBoundary).toHaveLength(MEASURE_SHAPES.length * MEASURE_WORKLOADS.length);
        const proven = small.map((item) => ({ ...item, refusedAboveMiB: 2.2 }));
        expect(boundaryVerdict(proven, 32)).toMatchObject({ established: true });
        const loose = small.map((item) => ({ ...item, refusedAboveMiB: 4 }));
        expect(boundaryVerdict(loose, 32).established).toBe(false);
        const atLimit = everyWorkload(28).map((item) => ({ ...item, boundary: true }));
        expect(boundaryVerdict(atLimit, 32)).toMatchObject({ established: true });
        // The refused attempt above a boundary row is its evidence, never a failed cell.
        const withRefusals = [...proven, ...small.map((item) => ({ ...item, sourceMiB: 2.2, pass: false, refused: true }))];
        expect(boundaryVerdict(withRefusals, 32)).toMatchObject({ established: true });
    });
});

// Code review 2 (new P2): each importer's step 0 file is built to core's caps by its encoded bytes.
describe('the step 0 import fixtures', () => {
    it('keep every text within core\'s 8 MiB text cap, 16 MiB in all and 100 000 rows, filled close to the cap', () => {
        const texts = importTexts('123456789012');
        expect(Object.keys(texts).sort()).toEqual(['dgt', 'mindwtr-csv', 'omnifocus', 'ticktick', 'todoist']);
        for (const [key, entries] of Object.entries(texts)) {
            const sizes = entries.map(([, text]) => Buffer.byteLength(text));
            for (const size of sizes) expect(size, key).toBeLessThanOrEqual(IMPORT_TEXT_CAP_BYTES);
            expect(sizes.reduce((sum, size) => sum + size, 0), key).toBeLessThanOrEqual(16 * 1024 * 1024);
            const rows = entries.reduce((sum, [, text]) => sum + (key === 'dgt' ? JSON.parse(text).TASK.length : text.trim().split('\n').length - 1), 0);
            expect(rows, key).toBeLessThanOrEqual(100_000);
            expect(Math.max(...sizes) > IMPORT_TEXT_CAP_BYTES - 256 * 1024 || rows >= 99_000, key).toBe(true);
        }
    });
});
