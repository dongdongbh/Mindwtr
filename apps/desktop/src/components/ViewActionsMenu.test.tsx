import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type Task } from '@mindwtr/core';

import { LanguageProvider } from '../contexts/language-context';
import { ViewExportProvider, useViewExportTasks } from '../contexts/view-export-context';
import { useUiStore } from '../store/ui-store';
import { ViewActionsMenu } from './ViewActionsMenu';

const exportDesktopCsvMock = vi.hoisted(() => vi.fn());
const reportErrorMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/data-transfer', () => ({
    exportDesktopCsv: exportDesktopCsvMock,
}));

vi.mock('../lib/report-error', () => ({
    reportError: reportErrorMock,
}));

const firstTasks = [{ id: 'first', title: 'Private first title' }] as Task[];
const secondTasks = [{ id: 'second', title: 'Private second title' }] as Task[];
const initialTaskState = useTaskStore.getState();

function Source({ tasks }: { tasks: readonly Task[] | null }) {
    useViewExportTasks(tasks);
    return null;
}

const renderMenu = (tasks: readonly Task[] | null) => render(
    <LanguageProvider>
        <ViewExportProvider viewKey="next">
            <Source tasks={tasks} />
            <ViewActionsMenu />
            <button type="button">Outside</button>
        </ViewExportProvider>
    </LanguageProvider>,
);

describe('ViewActionsMenu', () => {
    const showToast = vi.fn();

    beforeEach(() => {
        exportDesktopCsvMock.mockReset();
        reportErrorMock.mockReset();
        showToast.mockReset();
        act(() => {
            useTaskStore.setState(initialTaskState, true);
            useUiStore.setState({ showToast });
        });
    });

    it('keeps empty and unsupported export actions disabled', () => {
        const view = renderMenu(null);
        fireEvent.click(screen.getByRole('button', { name: 'More' }));
        expect(screen.getByRole('menuitem', { name: 'Export current results as CSV' })).toBeDisabled();

        view.rerender(
            <LanguageProvider>
                <ViewExportProvider viewKey="next">
                    <Source tasks={[]} />
                    <ViewActionsMenu />
                    <button type="button">Outside</button>
                </ViewExportProvider>
            </LanguageProvider>,
        );
        expect(screen.getByRole('menuitem', { name: 'Export current results as CSV' })).toBeDisabled();
    });

    it('supports keyboard open/Escape/Tab and does not steal focus on outside close', () => {
        renderMenu(firstTasks);
        const trigger = screen.getByRole('button', { name: 'More' });
        trigger.focus();
        fireEvent.keyDown(trigger, { key: 'ArrowDown' });
        const item = screen.getByRole('menuitem', { name: 'Export current results as CSV' });
        expect(item).toHaveFocus();

        fireEvent.keyDown(item, { key: 'Escape' });
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();

        fireEvent.click(trigger);
        const reopenedItem = screen.getByRole('menuitem', { name: 'Export current results as CSV' });
        fireEvent.keyDown(reopenedItem, { key: 'Tab' });
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(trigger).not.toHaveFocus();

        fireEvent.click(trigger);
        const outside = screen.getByRole('button', { name: 'Outside' });
        outside.focus();
        fireEvent.mouseDown(outside);
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(outside).toHaveFocus();
    });

    it('freezes tasks at click, blocks duplicate export, and toasts only after a real save', async () => {
        let resolveExport: ((saved: boolean) => void) | undefined;
        exportDesktopCsvMock.mockImplementation(() => new Promise<boolean>((resolve) => {
            resolveExport = resolve;
        }));
        const clickTimeTask = { ...firstTasks[0], title: 'Click-time data title' } as Task;
        act(() => {
            useTaskStore.setState({ tasks: [clickTimeTask], _allTasks: [clickTimeTask] });
        });
        const view = renderMenu(firstTasks);

        fireEvent.click(screen.getByRole('button', { name: 'More' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Export current results as CSV' }));
        act(() => {
            useTaskStore.setState({ tasks: secondTasks, _allTasks: secondTasks });
        });
        await waitFor(() => expect(exportDesktopCsvMock).toHaveBeenCalledTimes(1));
        expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();
        const [exportData, exportTasks] = exportDesktopCsvMock.mock.calls[0] as [
            { tasks: Task[] },
            Task[],
        ];
        expect(exportData.tasks.map((task) => task.title)).toEqual(['Click-time data title']);
        expect(exportTasks).toEqual(firstTasks);

        view.rerender(
            <LanguageProvider>
                <ViewExportProvider viewKey="next">
                    <Source tasks={secondTasks} />
                    <ViewActionsMenu />
                    <button type="button">Outside</button>
                </ViewExportProvider>
            </LanguageProvider>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'More' }));
        const pendingItem = screen.getByRole('menuitem', { name: 'Export current results as CSV' });
        expect(pendingItem).toBeDisabled();
        fireEvent.click(pendingItem);
        expect(exportDesktopCsvMock).toHaveBeenCalledTimes(1);
        expect(exportDesktopCsvMock.mock.calls[0]?.[1]).toEqual(firstTasks);

        await act(async () => resolveExport?.(true));
        expect(showToast).toHaveBeenCalledWith('CSV exported successfully!', 'success');
    });

    it('stays quiet on Save cancellation and surfaces rejected exports without task text', async () => {
        exportDesktopCsvMock.mockResolvedValueOnce(false);
        const view = renderMenu(firstTasks);
        fireEvent.click(screen.getByRole('button', { name: 'More' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Export current results as CSV' }));
        await waitFor(() => expect(exportDesktopCsvMock).toHaveBeenCalledTimes(1));
        expect(showToast).not.toHaveBeenCalled();

        exportDesktopCsvMock.mockRejectedValueOnce(new Error('save failed'));
        fireEvent.click(screen.getByRole('button', { name: 'More' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Export current results as CSV' }));
        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Failed to export CSV', 'error'));
        expect(reportErrorMock).toHaveBeenCalledWith('Failed to export filtered CSV', expect.any(Error));
        expect(JSON.stringify(reportErrorMock.mock.calls)).not.toContain('Private first title');
        view.unmount();
    });
});
