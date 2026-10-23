// Pass D1c step 0 (design §8, code review P2): the transfer limit from check-data-device.mjs's measured rows. Pure, so its
// rule is tested apart from the phone (data-transfer-limit.test.mjs).

/**
 * Every Data workload the limit must hold for, each measured in every shape. A TaskNotes export is measured but has its own
 * 12 MiB bound (step 0 run 4), so it does not set the limit.
 */
export const MEASURE_WORKLOADS = ['restore-fresh', 'merge-over', 'restore-over', 'undo', 'export-json', 'export-csv',
    'capture', 'import-todoist', 'import-ticktick', 'import-dgt', 'import-omnifocus', 'import-mindwtr-csv', 'cold-start', 'recovery-boot'];
export const MEASURE_SHAPES = ['rows', 'notes'];

/**
 * A row's size in MiB. An import counts the library it left, alone (its file is compressed and expands, and a duplicate adds
 * nothing: code review 2); an export, a capture or a start the library it read; a restore, merge or Undo the file and the
 * library it went over, or the library it left, whichever is larger.
 */
export const rowBound = (row) => row.workload?.startsWith('import-') ? row.libraryAfterMiB ?? 0
    : Math.max((row.sourceMiB ?? 0) + (row.libraryBeforeMiB ?? 0), row.libraryAfterMiB ?? 0);

/** The largest size below a workload's first failure: a failing smaller row caps it, whatever larger rows passed. */
const workloadBound = (rows) => {
    // At one size, a failure sorts first, so it caps that size too.
    const sorted = [...rows].sort((left, right) => rowBound(left) - rowBound(right) || Number(left.pass) - Number(right.pass));
    let bound = 0;
    for (const row of sorted) {
        if (!row.pass) break;
        bound = rowBound(row);
    }
    return bound;
};

/**
 * A workload and shape. An import runs on its own fresh install (step 0 run 6), so the library's shape does not reach it: one
 * import row counts for every shape.
 */
const key = (row) => (row.workload?.startsWith('import-') ? `*/${row.workload}` : `${row.shape}/${row.workload}`);
const cells = (shapes, workloads) => [...new Set(shapes.flatMap((shape) => workloads.map((workload) => key({ shape, workload }))))];

/**
 * Half of the smallest workload bound over the whole matrix (D1a's margin), or null while any workload or shape has no row.
 * Boundary reruns ([row.boundary]) are not part of the proposal.
 */
export function proposeTransferLimit(rows, { shapes = MEASURE_SHAPES, workloads = MEASURE_WORKLOADS } = {}) {
    const measured = rows.filter((row) => !row.boundary);
    const bounds = Object.fromEntries(cells(shapes, workloads).map((cell) => [cell, measured.filter((row) => key(row) === cell)]));
    const missing = Object.keys(bounds).filter((cell) => bounds[cell].length === 0);
    const sizes = Object.fromEntries(Object.entries(bounds).filter(([, list]) => list.length).map(([cell, list]) => [cell, workloadBound(list)]));
    if (missing.length) return { limitMiB: null, missing, bounds: sizes };
    const smallestMiB = Math.min(...Object.values(sizes));
    return { limitMiB: Math.floor(smallestMiB / 2), smallestMiB, missing: [], bounds: sizes };
}

/** How close a boundary row must come: within 15 % of the limit, or of a refused attempt just above it. */
export const BOUNDARY_SLACK = 0.15;

/**
 * Whether an admitted boundary row ran at its boundary, by its bytes (code review 2): its size is within [BOUNDARY_SLACK] of
 * the limit, or the app refused the attempt just above it ([above]) and that attempt was at most that much larger, so nothing
 * larger is admitted. A row is compared with its own kind of size: a restore or merge by its file and the library it went
 * over (step 0 run 6: a 5 MiB merge over 4.5 MiB left 10.8 MiB, and the refused 5.6 over 4.5 read as smaller than the
 * library it left); an import by the library it left, the refused one's scaled by the two files' expanded bytes.
 */
export const atBoundary = (row, limitMiB, above = null) => {
    const bound = rowBound(row);
    if (bound >= limitMiB * (1 - BOUNDARY_SLACK)) return true;
    if (!above) return false;
    const imported = row.workload?.startsWith('import-');
    const admitted = imported ? bound : (row.sourceMiB ?? 0) + (row.libraryBeforeMiB ?? 0);
    const refused = imported ? (row.libraryAfterMiB ?? 0) * (above.expandedMiB ?? 0) / (row.expandedMiB || Infinity)
        : (above.sourceMiB ?? 0) + (above.libraryBeforeMiB ?? 0);
    return refused > admitted && refused <= admitted * (1 + BOUNDARY_SLACK) + 0.5;
};

/** The Java heap ceiling: half the 256 MiB growth limit, which is a real crash limit (native has none). */
export const MEASURE_JAVA_MIB = 128;
/** The native heap ceiling dd set (10-18). */
export const MEASURE_NATIVE_MIB = 512;
/**
 * A run's Java peak: the app's own sampler when the run has its line, else `dumpsys meminfo`'s one sample, which counts
 * garbage not yet collected (step 0 run 6: notes cold start read 162 MiB at a 16.6 MiB library, 92 at 24.7).
 */
export const javaPeakOf = (run) => run.appJavaMiB ?? run.javaMiB;
/** A matrix row's pass (the search for each workload's bound B): finished, native peak at most 512 MiB. */
export const nativePasses = (row) => row.outcome === 'done' && Math.max(row.nativeMiB ?? 0, row.appNativeMiB ?? 0) <= MEASURE_NATIVE_MIB;
/**
 * A boundary row's pass (the coordinator's rule, 10-19): nativePasses, and its Java peak at most 128 MiB. Java is checked only
 * here, not in the matrix: one `dumpsys meminfo` sample swings with garbage collection timing, and a row whose Java crosses
 * gets two reruns ([row.javaRuns]) and fails only when 2 of its 3 runs cross.
 */
export const rowPasses = (row) => {
    if (!nativePasses(row)) return false;
    const runs = row.javaRuns ?? [javaPeakOf(row)];
    const crossed = runs.filter((java) => java > MEASURE_JAVA_MIB).length;
    // A crossing with no reruns behind it (a run that cannot repeat on the same library) fails.
    return crossed === 0 || (runs.length >= 3 && crossed < 2);
};
/** The rule a row follows: Java only at the boundary; a rerun that did not finish or passed 512 MiB native fails it. */
export const rowPassesFor = (row) => !row.rerunFailed && (row.boundary ? rowPasses(row) : nativePasses(row));

/**
 * Whether every workload and shape passed again at the proposed limit's admitted boundary ([row.boundary] rows). The evidence
 * comes from the order the rows ran in, so a saved log gives the same answer as the run: an admitted row's attempt above is
 * the refused row just before it on the same workload, and an Undo is at its boundary when the restore it undoes (the last
 * admitted restore-over in its shape) is.
 */
export function boundaryVerdict(rows, limitMiB, { shapes = MEASURE_SHAPES, workloads = MEASURE_WORKLOADS } = {}) {
    const atLimit = new Set();
    const restoreAtLimit = {};
    let above = null;
    for (const row of rows.filter((item) => item.boundary)) {
        // An attempt the app refused for its size is the next row's evidence, not a failure.
        if (row.refused) { above = row; continue; }
        const at = row.workload === 'undo' ? restoreAtLimit[row.shape] === true
            : atBoundary(row, limitMiB, above && key(above) === key(row) ? above : null);
        if (row.workload === 'restore-over') restoreAtLimit[row.shape] = at && row.pass;
        if (at) atLimit.add(row);
        above = null;
    }
    const boundary = rows.filter((row) => row.boundary && !row.refused);
    const missing = cells(shapes, workloads).filter((cell) => !boundary.some((row) => key(row) === cell));
    const failed = cells(shapes, workloads).filter((cell) => boundary.some((row) => key(row) === cell && !row.pass));
    const belowBoundary = cells(shapes, workloads).filter((cell) => boundary.some((row) => key(row) === cell && row.pass)
        && !boundary.some((row) => key(row) === cell && row.pass && atLimit.has(row)));
    return { established: missing.length === 0 && failed.length === 0 && belowBoundary.length === 0, limitMiB, missing, failed, belowBoundary };
}

// `node data-transfer-limit.mjs <measure.log> <limit MiB>`: the boundary verdict of a saved step 0 log, each row's pass
// recomputed by the rule its kind of row follows.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const { readFileSync } = await import('node:fs');
    const rows = readFileSync(process.argv[2], 'utf8').split('\n').filter((line) => line.startsWith('measure {'))
        .map((line) => JSON.parse(line.slice('measure '.length))).map((row) => ({ ...row, pass: rowPassesFor(row) }));
    const limitMiB = Number(process.argv[3]);
    const shapes = [...new Set(rows.map((row) => row.shape))];
    const verdict = boundaryVerdict(rows, limitMiB, { shapes });
    console.log(verdict.established ? `T established: ${limitMiB} MiB` : `T not established at ${limitMiB} MiB: ${JSON.stringify(verdict)}`);
}
