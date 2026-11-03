


export const MEASURE_WORKLOADS = ['restore-fresh', 'merge-over', 'restore-over', 'undo', 'export-json', 'export-csv',
    'capture', 'import-todoist', 'import-ticktick', 'import-dgt', 'import-omnifocus', 'import-mindwtr-csv', 'cold-start', 'recovery-boot'];
export const MEASURE_SHAPES = ['rows', 'notes'];


export const rowBound = (row) => row.workload?.startsWith('import-') ? row.libraryAfterMiB ?? 0
    : Math.max((row.sourceMiB ?? 0) + (row.libraryBeforeMiB ?? 0), row.libraryAfterMiB ?? 0);


const workloadBound = (rows) => {

    const sorted = [...rows].sort((left, right) => rowBound(left) - rowBound(right) || Number(left.pass) - Number(right.pass));
    let bound = 0;
    for (const row of sorted) {
        if (!row.pass) break;
        bound = rowBound(row);
    }
    return bound;
};


const key = (row) => (row.workload?.startsWith('import-') ? `*/${row.workload}` : `${row.shape}/${row.workload}`);
const cells = (shapes, workloads) => [...new Set(shapes.flatMap((shape) => workloads.map((workload) => key({ shape, workload }))))];


export function proposeTransferLimit(rows, { shapes = MEASURE_SHAPES, workloads = MEASURE_WORKLOADS } = {}) {
    const measured = rows.filter((row) => !row.boundary);
    const bounds = Object.fromEntries(cells(shapes, workloads).map((cell) => [cell, measured.filter((row) => key(row) === cell)]));
    const missing = Object.keys(bounds).filter((cell) => bounds[cell].length === 0);
    const sizes = Object.fromEntries(Object.entries(bounds).filter(([, list]) => list.length).map(([cell, list]) => [cell, workloadBound(list)]));
    if (missing.length) return { limitMiB: null, missing, bounds: sizes };
    const smallestMiB = Math.min(...Object.values(sizes));
    return { limitMiB: Math.floor(smallestMiB / 2), smallestMiB, missing: [], bounds: sizes };
}


export const BOUNDARY_SLACK = 0.15;


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


export const MEASURE_JAVA_MIB = 128;

export const MEASURE_NATIVE_MIB = 512;


export const javaPeakOf = (run) => run.appJavaMiB ?? run.javaMiB;

export const nativePasses = (row) => row.outcome === 'done' && Math.max(row.nativeMiB ?? 0, row.appNativeMiB ?? 0) <= MEASURE_NATIVE_MIB;


export const rowPasses = (row) => {
    if (!nativePasses(row)) return false;
    const runs = row.javaRuns ?? [javaPeakOf(row)];
    const crossed = runs.filter((java) => java > MEASURE_JAVA_MIB).length;

    return crossed === 0 || (runs.length >= 3 && crossed < 2);
};

export const rowPassesFor = (row) => !row.rerunFailed && (row.boundary ? rowPasses(row) : nativePasses(row));


export function boundaryVerdict(rows, limitMiB, { shapes = MEASURE_SHAPES, workloads = MEASURE_WORKLOADS } = {}) {
    const atLimit = new Set();
    const restoreAtLimit = {};
    let above = null;
    for (const row of rows.filter((item) => item.boundary)) {

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


if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const { readFileSync } = await import('node:fs');
    const rows = readFileSync(process.argv[2], 'utf8').split('\n').filter((line) => line.startsWith('measure {'))
        .map((line) => JSON.parse(line.slice('measure '.length))).map((row) => ({ ...row, pass: rowPassesFor(row) }));
    const limitMiB = Number(process.argv[3]);
    const shapes = [...new Set(rows.map((row) => row.shape))];
    const verdict = boundaryVerdict(rows, limitMiB, { shapes });
    console.log(verdict.established ? `T established: ${limitMiB} MiB` : `T not established at ${limitMiB} MiB: ${JSON.stringify(verdict)}`);
}
