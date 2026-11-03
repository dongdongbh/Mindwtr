


export const BLOCK_MEDIAN_MS = 450;
export const BLOCK_P90_MS = 550;

export const BUDGET_SAMPLES = 20;


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
