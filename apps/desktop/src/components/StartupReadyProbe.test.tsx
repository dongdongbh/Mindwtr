import { act, render } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StartupReadyProbe } from './StartupReadyProbe';

const mocks = vi.hoisted(() => ({ mark: vi.fn(), paints: [] as Array<{ callback: () => void; cancelled: boolean }> }));
vi.mock('../lib/startup-profiler', () => ({ markDesktopStartup: mocks.mark }));
vi.mock('@mindwtr/core', () => ({ afterPaint: (callback: () => void) => {
    const entry = { callback, cancelled: false };
    mocks.paints.push(entry);
    return () => { entry.cancelled = true; };
} }));
afterEach(() => vi.restoreAllMocks());
beforeEach(() => { mocks.mark.mockClear(); mocks.paints.length = 0; });
it('waits for hydration and visibility, and cancels readiness on unmount', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const tree = render(<StartupReadyProbe ready={false} />);
    tree.rerender(<StartupReadyProbe ready />);
    expect(mocks.paints).toHaveLength(0);
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(mocks.paints).toHaveLength(1);
    act(() => { for (const entry of mocks.paints.splice(0)) if (!entry.cancelled) entry.callback(); });
    expect(mocks.mark).toHaveBeenCalledExactlyOnceWith('interactive_ready');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    tree.unmount();
    expect(mocks.paints[0].cancelled).toBe(true);
});

it('does not report readiness while the screen is suspended', async () => {
    let resolved = false;
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    function Screen() {
        if (!resolved) throw pending;
        return <div>Loaded screen</div>;
    }
    const tree = render(<Suspense fallback={<div>Loading</div>}><Screen /><StartupReadyProbe ready /></Suspense>);
    expect(tree.getByText('Loading')).toBeDefined();
    expect(mocks.paints).toHaveLength(0);
    await act(async () => { resolved = true; resolve(); await pending; });
    expect(tree.getByText('Loaded screen')).toBeDefined();
    expect(mocks.paints).toHaveLength(1);
    tree.unmount();
});
