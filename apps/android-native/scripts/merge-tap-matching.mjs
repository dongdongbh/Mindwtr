// The merge measurement's tap accounting (measure-merge-device.mjs analyze). Pure: no trace processor, no phone.
//
// The run taps the Focus and Inbox tabs in turn from launch, Focus first. Each tab tap answers with one read on the app's read
// thread: `core:focus` for Focus, `core:menuRead` for Inbox. A tap is matched only to its own tab's read, the first one that starts
// after the tap and before that tab's next tap, so a delayed answer stays with its own tap instead of being
// credited to the next one. Every other read (launch reads, the screens' refresh after a sync publishes, worker calls) answers no
// tap. A tap with no such read is unanswered: its answer, if any, is not measured, and the budget counts it as a failure.

export const TAB_READS = ['core:focus', 'core:menuRead'];
/** The run taps nine times per sample (measure-merge-device.mjs run); the tab order holds only when the app saw all nine. */
export const TAPS_PER_SAMPLE = 9;

/**
 * taps: [{ tap, first, last }] in time order (one tap = its DOWN and UP input events, by eventTimeNano; ns).
 * calls: [{ ts, end, op }] host calls on the read thread, in time order (ns).
 * Returns one entry per tap: { tap, first, last, call: the matched call or null, answerMs: call end − tap UP, or null }.
 */
export function assignTapAnswers(taps, calls) {
    // A tab's taps have disjoint windows (each ends at that tab's next tap), so no read can answer two taps.
    return taps.map((tap, index) => {
        const op = TAB_READS[index % 2];
        const sameTabNext = taps[index + 2]?.first ?? Infinity;
        const call = calls.find((candidate) => candidate.op === op && candidate.ts >= tap.first && candidate.ts < sameTabNext) ?? null;
        return { ...tap, call, answerMs: call ? Math.round((call.end - tap.last) / 1e5) / 10 : null };
    });
}

/**
 * The taps that measure an answer. A cold start (the app process starts in the trace) skips two: tap 0 meets a launch read and
 * tap 1 taps the tab the app opened on, which makes no read. A resume skips one: the app comes back on Focus, the previous
 * sample's last tab, so tap 0 (Focus) makes no read, while tap 1 (Inbox) always switches tabs and is a real answer.
 */
export function measuredTaps(answers, coldStart) {
    return answers.slice(coldStart ? 2 : 1);
}
