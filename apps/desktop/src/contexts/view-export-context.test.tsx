import { StrictMode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Task } from '@mindwtr/core';
import { ViewExportProvider, useViewExport, useViewExportTasks } from './view-export-context';

const first = [{ id: 'first' }] as Task[];
const second = [{ id: 'second' }, { id: 'third' }] as Task[];
function Source({ tasks }: { tasks: readonly Task[] | null }) {
    useViewExportTasks(tasks);
    return null;
}
function Consumer() {
    const { tasks } = useViewExport();
    return <button disabled={!tasks?.length}>{tasks?.map((task) => task.id).join(',') ?? 'unsupported'}</button>;
}

describe('current view export scope', () => {
    it('is harmless without a provider', () => {
        render(<><Source tasks={first} /><Consumer /></>);
        expect(screen.getByRole('button')).toBeDisabled();
    });

    it('follows current results without keeping an old route or unmounted source', () => {
        const view = (route: string, tasks: readonly Task[] | null, mounted = true) => (
            <ViewExportProvider viewKey={route}>
                {mounted && <Source tasks={tasks} />}
                <Consumer />
            </ViewExportProvider>
        );
        const { rerender } = render(view('contexts', first));
        expect(screen.getByRole('button')).toHaveTextContent('first');
        rerender(view('contexts', second));
        expect(screen.getByRole('button')).toHaveTextContent('second,third');
        // Even if a previous view is briefly retained, its unchanged results
        // must not become the new route's export scope.
        rerender(view('settings', second));
        expect(screen.getByRole('button')).toHaveTextContent('unsupported');
        rerender(view('settings', null, false));
        expect(screen.getByRole('button')).toBeDisabled();
        rerender(view('next', first));
        expect(screen.getByRole('button')).toHaveTextContent('first');
        rerender(view('next', [], true));
        expect(screen.getByRole('button')).toBeDisabled();
    });

    it('does not let an old cleanup clear a newer registration', () => {
        const view = (oldMounted: boolean) => (
            <StrictMode>
                <ViewExportProvider viewKey="contexts">
                    {oldMounted && <Source key="old" tasks={first} />}
                    <Source key="new" tasks={second} />
                    <Consumer />
                </ViewExportProvider>
            </StrictMode>
        );
        const { rerender } = render(view(true));
        expect(screen.getByRole('button')).toHaveTextContent('second,third');
        rerender(view(false));
        expect(screen.getByRole('button')).toHaveTextContent('second,third');
        fireEvent.click(screen.getByRole('button'));
        expect(screen.getByRole('button')).toBeEnabled();
    });

    it('does not resurrect a retained registration when returning to its old route', () => {
        const view = (route: string) => (
            <ViewExportProvider viewKey={route}>
                <Source tasks={first} />
                <Consumer />
            </ViewExportProvider>
        );
        const { rerender } = render(view('contexts'));
        expect(screen.getByRole('button')).toHaveTextContent('first');
        rerender(view('settings'));
        expect(screen.getByRole('button')).toBeDisabled();
        rerender(view('contexts'));
        expect(screen.getByRole('button')).toBeDisabled();
    });

    it('accepts changed results from a retained active source on the same or a new route', () => {
        const view = (route: string, tasks: readonly Task[]) => (
            <ViewExportProvider viewKey={route}>
                <Source tasks={tasks} />
                <Consumer />
            </ViewExportProvider>
        );
        const { rerender } = render(view('list:inbox', first));
        expect(screen.getByRole('button')).toHaveTextContent('first');

        rerender(view('list:inbox', second));
        expect(screen.getByRole('button')).toHaveTextContent('second,third');

        rerender(view('list:next', first));
        expect(screen.getByRole('button')).toHaveTextContent('first');
    });

    it('does not rerender a registering leaf when export state changes', () => {
        let sourceRenders = 0;
        function CountingSource() {
            sourceRenders += 1;
            useViewExportTasks(first);
            return null;
        }

        render(
            <ViewExportProvider viewKey="contexts">
                <CountingSource />
                <Consumer />
            </ViewExportProvider>,
        );

        expect(screen.getByRole('button')).toHaveTextContent('first');
        expect(sourceRenders).toBe(1);
    });
});
