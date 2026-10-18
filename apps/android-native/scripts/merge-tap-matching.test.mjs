import { describe, expect, it } from 'bun:test';
import { assignTapAnswers, measuredTaps } from './merge-tap-matching.mjs';

const ms = (value) => value * 1e6;
const tap = (at) => ({ tap: String(at), first: ms(at), last: ms(at + 5) });
const call = (at, end, op) => ({ ts: ms(at), end: ms(end), op });

describe('merge measurement tap matching', () => {
    it('matches each tap to its own tab read, so a delayed answer is never credited to the next tap', () => {
        // Focus tap at 0 answers only at 740 ms, after the Inbox tap at 450 (whose own read follows).
        const answers = assignTapAnswers([tap(0), tap(450)], [call(700, 745, 'core:focus'), call(760, 800, 'core:menuRead')]);
        expect(answers.map((answer) => answer.answerMs)).toEqual([740, 345]);
    });

    it('gives a tap one sample however many calls follow it, and none to worker or refresh calls', () => {
        const answers = assignTapAnswers([tap(0), tap(450), tap(900)], [
            call(10, 60, 'core:focus'), call(20, 30, 'core:remindersCycle'), call(70, 90, 'core:projects'),
            // A sync publish refreshes both tabs: the Inbox tap at 450 takes the menu read after it, not the one before.
            call(300, 320, 'core:menuRead'), call(460, 500, 'core:menuRead'), call(910, 950, 'core:focus'),
        ]);
        expect(answers.map((answer) => answer.answerMs)).toEqual([55, 45, 45]);
        expect(answers.filter((answer) => answer.call).length).toBe(3);
    });

    it('leaves a tap with no read of its own tab before that tab\'s next tap unanswered', () => {
        const answers = assignTapAnswers([tap(0), tap(450), tap(900), tap(1350)], [
            call(10, 40, 'core:focus'), call(910, 950, 'core:focus'), call(1360, 1400, 'core:menuRead'),
        ]);
        // The Inbox tap at 450 made no menu read before the Inbox tap at 1350; the read at 1360 is that later tap's.
        expect(answers.map((answer) => answer.answerMs)).toEqual([35, null, 45, 45]);
    });

    it('never gives one read to two taps', () => {
        const answers = assignTapAnswers([tap(0), tap(450), tap(900)], [call(950, 990, 'core:focus')]);
        expect(answers.map((answer) => answer.answerMs)).toEqual([null, null, 85]);
    });

    it('skips two start taps on a cold start and one on a resume, so a resume keeps its first tab switch', () => {
        // Cold: tap 0 (Focus) meets the launch read, tap 1 (Inbox) taps the tab the app opened on and makes no read.
        const cold = assignTapAnswers([tap(0), tap(450), tap(900), tap(1350)], [
            call(100, 300, 'core:menuRead'), call(120, 320, 'core:focus'), call(910, 950, 'core:focus'), call(1360, 1400, 'core:menuRead'),
        ]);
        expect(measuredTaps(cold, true).map((answer) => answer.answerMs)).toEqual([45, 45]);
        // Resume: the app is back on Focus, so tap 0 makes no read; tap 1 switches to Inbox and its slow answer counts.
        const resume = assignTapAnswers([tap(0), tap(450), tap(900)], [call(470, 2400, 'core:menuRead'), call(910, 950, 'core:focus')]);
        expect(measuredTaps(resume, false).map((answer) => answer.answerMs)).toEqual([1945, 45]);
    });
});
