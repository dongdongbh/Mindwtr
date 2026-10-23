// Pass D1c step 0 (design §8, code review P2): the transfer limit check-data-device.mjs proposes from its measured rows.
import { describe, expect, it } from 'bun:test';
import { atBoundary, boundaryVerdict, MEASURE_SHAPES, MEASURE_WORKLOADS, proposeTransferLimit, rowBound, rowPasses, rowPassesFor } from './data-transfer-limit.mjs';
import { IMPORT_TEXT_CAP_BYTES, importTasksFor, importTexts } from './data-measure-fixtures.mjs';

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

    // Step 0 run 6: an import starts on a fresh install, so its rows (measured once) count for every shape.
    it('counts one shape\'s import rows for every shape', () => {
        const rows = everyWorkload(64).filter((item) => !(item.shape === 'notes' && item.workload.startsWith('import-')));
        expect(proposeTransferLimit(rows)).toMatchObject({ limitMiB: 32, missing: [] });
        const capped = rows.map((item) => (item.workload === 'import-dgt' ? { ...item, libraryAfterMiB: 24 } : item));
        expect(proposeTransferLimit(capped)).toMatchObject({ limitMiB: 12 });
        expect(boundaryVerdict(rows.map((item) => ({ ...item, boundary: true })), 32)).toMatchObject({ established: true });
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
        const imports = MEASURE_WORKLOADS.filter((workload) => workload.startsWith('import-')).length;
        expect(verdict.belowBoundary).toHaveLength(MEASURE_SHAPES.length * (MEASURE_WORKLOADS.length - imports) + imports);
        // Each admitted row right after the attempt the app refused ([grow] times larger): the refusal is its evidence, never a
        // failed cell. An import's refused file is compared by its expanded bytes.
        const imported = (item) => item.workload.startsWith('import-');
        const withAbove = (grow) => small.flatMap((item) => [
            { ...item, sourceMiB: item.sourceMiB * grow, expandedMiB: imported(item) ? grow : null, pass: false, refused: true },
            { ...item, expandedMiB: imported(item) ? 1 : null }]);
        expect(boundaryVerdict(withAbove(1.1), 32)).toMatchObject({ established: true });
        expect(boundaryVerdict(withAbove(2), 32).established).toBe(false);
        const atLimit = everyWorkload(28).map((item) => ({ ...item, boundary: true }));
        expect(boundaryVerdict(atLimit, 32)).toMatchObject({ established: true });
    });
});

// The coordinator's ruling (10-19): native at most 512 MiB; Java at most 128 MiB by the app's own sampler where the row has
// it, else by dumpsys; a row whose Java crosses fails only when 2 of its 3 runs cross.
describe('the step 0 pass rule', () => {
    const done = { outcome: 'done', nativeMiB: 300, javaMiB: 90 };
    it('reads Java from the app\'s sampler before dumpsys, and native from the larger of the two', () => {
        expect(rowPasses({ ...done, javaMiB: 140, appJavaMiB: 121 })).toBe(true);
        expect(rowPasses({ ...done, javaMiB: 90, appJavaMiB: 130 })).toBe(false);
        expect(rowPasses({ ...done, appNativeMiB: 513 })).toBe(false);
        expect(rowPasses({ ...done, outcome: 'died' })).toBe(false);
    });
    it('checks Java at the boundary only: a matrix row passes by native alone', () => {
        expect(rowPassesFor({ ...done, javaMiB: 162 })).toBe(true);
        expect(rowPassesFor({ ...done, javaMiB: 162, boundary: true })).toBe(false);
        expect(rowPassesFor({ ...done, nativeMiB: 545 })).toBe(false);
        expect(rowPassesFor({ ...done, boundary: true, javaMiB: 140, javaRuns: [140, 90, 95], rerunFailed: true })).toBe(false);
    });
    it('fails a Java crossing only when 2 of 3 runs cross, and a lone crossing with no reruns', () => {
        expect(rowPasses({ ...done, javaMiB: 162 })).toBe(false);
        expect(rowPasses({ ...done, javaMiB: 162, javaRuns: [162, 92, 101] })).toBe(true);
        expect(rowPasses({ ...done, javaMiB: 162, javaRuns: [162, 131, 101] })).toBe(false);
    });
});

// Step 0 run 6's boundary: a refused restore or merge leaves no library, so it is compared by S + L, not by the admitted
// row's library after; an Undo follows the restore it undoes.
describe('a boundary row over a library', () => {
    // Step 0 run 6's log: the admitted merge left 10.8 MiB; the refused one above it was 5.6 over 4.5 = 10.1. Compared with
    // the admitted row's own file and library (9.5), the refusal is just above it; compared with its library after, it read
    // as smaller and the check printed "T not established".
    const refused = { workload: 'merge-over', shape: 'rows', boundary: true, refused: true, pass: false, sourceMiB: 5.6, libraryBeforeMiB: 4.5, libraryAfterMiB: 4.5 };
    const merge = { workload: 'merge-over', shape: 'rows', boundary: true, pass: true, sourceMiB: 5, libraryBeforeMiB: 4.5, libraryAfterMiB: 10.8 };
    it('is compared with its own file and library, not with the library it left', () => {
        expect(atBoundary(merge, 15, refused)).toBe(true);
        expect(atBoundary(merge, 15, null)).toBe(false);
        expect(atBoundary(merge, 15, { ...refused, sourceMiB: 8 })).toBe(false);
    });
    it('passes an Undo whose restore was at its boundary, from the rows\' order', () => {
        const over = (fields) => ({ ...merge, workload: 'restore-over', ...fields });
        const undo = { workload: 'undo', shape: 'rows', boundary: true, pass: true, sourceMiB: 0, libraryBeforeMiB: 11, libraryAfterMiB: 11.8 };
        const rows = [refused, merge, over({ refused: true, pass: false, sourceMiB: 5 }), over({ sourceMiB: 4.4, libraryAfterMiB: 11 }), undo];
        const scope = { shapes: ['rows'], workloads: ['merge-over', 'restore-over', 'undo'] };
        expect(boundaryVerdict(rows, 15, scope)).toMatchObject({ established: true });
        expect(boundaryVerdict(rows.filter((row) => !(row.workload === 'restore-over' && row.refused)), 15, scope).belowBoundary).toEqual(['rows/restore-over', 'rows/undo']);
    });
});


// Code review 2 (new P2): each importer's step 0 file is built to core's caps by its encoded bytes.
describe('the step 0 import fixtures', () => {
    // Step 0 run 6: an import sized to the limit's range, not to core's caps (run 5's 100 000 Todoist tasks grew the library 101 MiB).
    it('stop at the task count asked for', () => {
        const tasks = importTasksFor(24);
        expect(tasks).toBe(24_576);
        for (const [key, entries] of Object.entries(importTexts('123456789012', tasks))) {
            const rows = entries.reduce((sum, [, text]) => sum + (key === 'dgt' ? JSON.parse(text).TASK.length : text.trim().split('\n').length - 1), 0);
            expect(rows, key).toBe(tasks);
        }
        expect(importTasksFor(1024)).toBe(99_999);
    });

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
