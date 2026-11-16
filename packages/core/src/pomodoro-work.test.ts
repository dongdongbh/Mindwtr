import { describe, expect, it } from 'vitest';
import { advancePomodoroState, createPomodoroState } from './pomodoro';
import { accumulatePomodoroWork, settlePomodoroWork } from './pomodoro-work';

const durations = { focusMinutes: 25, breakMinutes: 5 };
const running = { ...createPomodoroState(durations), isRunning: true };

describe('Pomodoro work accounting', () => {
    it('credits partial elapsed seconds once across pause, restart, and resume', () => {
        const paused = { ...running, isRunning: false, remainingSeconds: 1409 };
        const work = accumulatePomodoroWork({ timerState: running, durations, selectedTaskId: 'a', workSecondsByTaskId: {} }, paused);
        expect(work).toEqual({ a: 91 });
        const settled = settlePomodoroWork(work);
        expect(settled).toEqual({ workSecondsByTaskId: { a: 31 }, credits: [{ taskId: 'a', minutes: 1 }] });
        expect(accumulatePomodoroWork({ timerState: paused, durations, selectedTaskId: 'a', ...settled }, paused)).toEqual({ a: 31 });
        const resumed = { ...paused, isRunning: true };
        const next = { ...resumed, remainingSeconds: 1380 };
        expect(settlePomodoroWork(accumulatePomodoroWork({ timerState: resumed, durations, selectedTaskId: 'a', ...settled }, next)))
            .toEqual({ workSecondsByTaskId: {}, credits: [{ taskId: 'a', minutes: 1 }] });
    });
    it('keeps separate subminute work for each owner and ignores paused and break time', () => {
        const work = { a: 40, b: 30 };
        expect(accumulatePomodoroWork({ timerState: { ...running, isRunning: false }, durations, selectedTaskId: 'a', workSecondsByTaskId: work },
            { ...running, remainingSeconds: 1300 })).toEqual(work);
        const breakState = { ...createPomodoroState(durations, 'break'), isRunning: true };
        expect(accumulatePomodoroWork({ timerState: breakState, durations, selectedTaskId: 'a', workSecondsByTaskId: work },
            { ...breakState, remainingSeconds: 100 })).toEqual(work);
        expect(settlePomodoroWork(accumulatePomodoroWork({ timerState: running, durations, selectedTaskId: 'b', workSecondsByTaskId: work },
            { ...running, remainingSeconds: 1470 }))).toEqual({ workSecondsByTaskId: { a: 40 }, credits: [{ taskId: 'b', minutes: 1 }] });
    });
    it('includes active focus across multiple completed focus and break intervals', () => {
        const next = advancePomodoroState(running, durations, 3730, { autoStartFocus: true, autoStartBreaks: true }).state;
        expect(accumulatePomodoroWork({ timerState: running, durations, selectedTaskId: 'a', workSecondsByTaskId: {} }, next)).toEqual({ a: 3130 });
    });
    it('adopts only legacy current focus progress, keeping completed sessions separate', () => {
        const previous = { ...running, remainingSeconds: 200, completedFocusSessions: 4 };
        const next = { ...previous, remainingSeconds: 100 };
        expect(accumulatePomodoroWork({ timerState: previous, durations, selectedTaskId: 'a' }, next)).toEqual({ a: 1400 });
        expect(accumulatePomodoroWork({ timerState: { ...previous, isRunning: false }, durations, selectedTaskId: 'a' }, previous)).toEqual({ a: 1300 });
        expect(accumulatePomodoroWork({ timerState: previous, durations }, next)).toEqual({});
    });
    it('rejects unsafe map entries and prototype identities without mutating its inputs', () => {
        const work = JSON.parse('{"a":61,"b":-1,"c":1.5,"__proto__":60,"constructor":120,"prototype":180}');
        work.d = Infinity; work.e = Number.MAX_SAFE_INTEGER + 1;
        expect(settlePomodoroWork(work)).toEqual({ workSecondsByTaskId: { a: 1 }, credits: [{ taskId: 'a', minutes: 1 }] });
        expect(work.a).toBe(61);
        expect(accumulatePomodoroWork({ timerState: running, durations, selectedTaskId: '__proto__' }, { ...running, remainingSeconds: 1000 })).toEqual({});
        expect(() => accumulatePomodoroWork({ timerState: running, durations, selectedTaskId: 'a', workSecondsByTaskId: { a: Number.MAX_SAFE_INTEGER } },
            { ...running, remainingSeconds: 1499 })).toThrow();
    });
    it('consumes oversized work at the supported task credit limit and keeps its subminute remainder', () => {
        expect(settlePomodoroWork({ a: 60_000_031 })).toEqual({
            workSecondsByTaskId: { a: 31 }, credits: [{ taskId: 'a', minutes: 100_000 }],
        });
    });
});
