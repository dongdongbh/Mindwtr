// The merge series' resume budget (measure-merge-device.mjs analyze --budget). The primary gate is the engine's longest
// uninterrupted block during sync: one long block decides the tap p90 by how many taps happen to land in it, so the tap gate
// alone passed or failed the same ~900 ms block by chance (D9b change 5). Known-good builds sit at about 330 / 375 ms
// (median / p90), the regressed ones at 900+; 300 would fail the good ones.

export const BLOCK_MEDIAN_MS = 450;
export const BLOCK_P90_MS = 550;
/** Good samples (traces that analyzed without an error) a budget run needs: about 160 measured taps. */
export const BUDGET_SAMPLES = 20;

/**
 * The verdict for one series: `pass`, `fail`, or `repeat` when the block gate and the tap gate disagree (run the series
 * again with `repeat`; a second disagreement fails as noisy). Too few good samples, no tap in the sync span, or too many
 * unanswered taps fail outright.
 * Returns `{ verdict, reasons }`.
 */
export const budgetVerdict = (summary, { tapP90Ms, repeat = false }) => {
    const reasons = [];
    if (!(summary.samples >= BUDGET_SAMPLES)) {
        reasons.push(`${summary.samples} good samples of ${summary.traces} traces, the budget needs ${BUDGET_SAMPLES}`);
    }
    if (!summary.tapsInSyncSpan.n) reasons.push('no tap landed in the sync span');
    if (!(summary.taps.unansweredShare <= 0.05)) {
        reasons.push(`${summary.taps.unanswered} of ${summary.taps.inSpan} taps in the sync span have no read of their own tab `
            + `(share ${summary.taps.unansweredShare} > 0.05)`);
    }
    if (reasons.length) return { verdict: 'fail', reasons };
    const block = summary.longestBlockMs;
    const blockOk = block.median <= BLOCK_MEDIAN_MS && block.p90 <= BLOCK_P90_MS;
    const tapOk = summary.tapsInSyncSpan.p90 <= tapP90Ms;
    const blockLine = `longest block ${block.median} / ${block.p90} ms (limit ${BLOCK_MEDIAN_MS} / ${BLOCK_P90_MS})`;
    const taps = summary.tapsInSyncSpan;
    const tapLine = `tap in sync span p90 ${taps.p90} ms (limit ${tapP90Ms}, n ${taps.n})`;
    if (blockOk && tapOk) return { verdict: 'pass', reasons: [blockLine, tapLine] };
    if (!blockOk && !tapOk) return { verdict: 'fail', reasons: [blockLine, tapLine] };
    return repeat
        ? { verdict: 'fail', reasons: ['noisy: the gates disagreed twice', blockLine, tapLine] }
        : { verdict: 'repeat', reasons: ['the gates disagree: run the series again, analyze it with --repeat', blockLine, tapLine] };
};
