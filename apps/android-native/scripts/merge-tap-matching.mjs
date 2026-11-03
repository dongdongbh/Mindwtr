


export const TAB_READS = ['core:focus', 'core:menuRead'];

export const TAPS_PER_SAMPLE = 9;


export function assignTapAnswers(taps, calls) {

    return taps.map((tap, index) => {
        const op = TAB_READS[index % 2];
        const sameTabNext = taps[index + 2]?.first ?? Infinity;
        const call = calls.find((candidate) => candidate.op === op && candidate.ts >= tap.first && candidate.ts < sameTabNext) ?? null;
        return { ...tap, call, answerMs: call ? Math.round((call.end - tap.last) / 1e5) / 10 : null };
    });
}


export function measuredTaps(answers, coldStart) {
    return answers.slice(coldStart ? 2 : 1);
}
