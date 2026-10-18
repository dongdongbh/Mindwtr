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

const key = (row) => `${row.shape}/${row.workload}`;
const cells = (shapes, workloads) => shapes.flatMap((shape) => workloads.map((workload) => `${shape}/${workload}`));

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
 * Whether a boundary row ran at its admitted boundary, by its bytes (code review 2): its size is within [BOUNDARY_SLACK] of
 * the limit, or the app refused an attempt ([row.refusedAboveMiB]) at most that much larger, so nothing larger is admitted.
 */
export const atBoundary = (row, limitMiB) => {
    const bound = rowBound(row);
    if (bound >= limitMiB * (1 - BOUNDARY_SLACK)) return true;
    return typeof row.refusedAboveMiB === 'number' && row.refusedAboveMiB > bound && row.refusedAboveMiB <= bound * (1 + BOUNDARY_SLACK) + 0.5;
};

/** Whether every workload and shape passed again at the proposed limit's admitted boundary ([row.boundary] rows). */
export function boundaryVerdict(rows, limitMiB, { shapes = MEASURE_SHAPES, workloads = MEASURE_WORKLOADS } = {}) {
    // An attempt the app refused for its size is the boundary's evidence (refusedAboveMiB), not a failure.
    const boundary = rows.filter((row) => row.boundary && !row.refused);
    const missing = cells(shapes, workloads).filter((cell) => !boundary.some((row) => key(row) === cell));
    const failed = cells(shapes, workloads).filter((cell) => boundary.some((row) => key(row) === cell && !row.pass));
    const belowBoundary = cells(shapes, workloads).filter((cell) => boundary.some((row) => key(row) === cell && row.pass)
        && !boundary.some((row) => key(row) === cell && row.pass && atBoundary(row, limitMiB)));
    return { established: missing.length === 0 && failed.length === 0 && belowBoundary.length === 0, limitMiB, missing, failed, belowBoundary };
}
