import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTaskDisplayClock } from './useTaskDisplayClock';

function Probe({ enabled = true }: { enabled?: boolean }) {
    return <span data-testid="clock">{useTaskDisplayClock(enabled)}</span>;
}

describe('useTaskDisplayClock', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('shares one timer/listener, pauses, refreshes within the same minute, and cleans up', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 9, 9, 12, 59, 30));
        let hidden = false;
        vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
        const addListener = vi.spyOn(document, 'addEventListener');
        const removeListener = vi.spyOn(document, 'removeEventListener');
        const view = render(<><Probe /><Probe /><Probe enabled={false} /></>);
        try {
            expect(addListener.mock.calls.filter(([event]) => event === 'visibilitychange')).toHaveLength(1);
            expect(vi.getTimerCount()).toBe(1);
            const before = Number(view.getAllByTestId('clock')[0].textContent);
            act(() => { vi.advanceTimersByTime(30_000); });
            expect(Number(view.getAllByTestId('clock')[0].textContent)).toBe(before);
            act(() => { vi.advanceTimersByTime(1); });
            expect(Number(view.getAllByTestId('clock')[0].textContent)).toBe(before + 1);
            act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
            expect(vi.getTimerCount()).toBe(0);
            act(() => {
                vi.advanceTimersByTime(10_000);
                hidden = false;
                document.dispatchEvent(new Event('visibilitychange'));
            });
            expect(Number(view.getAllByTestId('clock')[0].textContent)).toBe(before + 2);
            expect(vi.getTimerCount()).toBe(1);
            view.rerender(<Probe />);
            expect(vi.getTimerCount()).toBe(1);
            expect(removeListener.mock.calls.filter(([event]) => event === 'visibilitychange')).toHaveLength(0);
        } finally {
            view.unmount();
        }
        expect(vi.getTimerCount()).toBe(0);
        expect(removeListener.mock.calls.filter(([event]) => event === 'visibilitychange')).toHaveLength(1);
    });

    it('does no work while disabled or initially hidden', () => {
        vi.useFakeTimers();
        const addListener = vi.spyOn(document, 'addEventListener');
        const view = render(<Probe enabled={false} />);
        expect(addListener.mock.calls.filter(([event]) => event === 'visibilitychange')).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        view.rerender(<Probe />);
        expect(vi.getTimerCount()).toBe(0);
        view.unmount();
    });
});
