import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AppData, Task } from '@mindwtr/core';

import { useSelectedTasksCsvExport } from './useSelectedTasksCsvExport';

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/report-error', () => ({ reportError: reportErrorMock }));

const now = '2026-09-09T12:00:00.000Z';
const task = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
});
const data = (tasks: Task[]): AppData => ({
    tasks,
    projects: [{
        id: 'project-1',
        title: 'Snapshot project',
        status: 'active',
        color: '#3b82f6',
        order: 0,
        tagIds: [],
        createdAt: now,
        updatedAt: now,
    }],
    sections: [],
    areas: [],
    people: [],
    settings: {},
});

describe('useSelectedTasksCsvExport', () => {
    it('freezes the selected subset and full metadata before awaiting export', async () => {
        let resolveExport!: (saved: boolean) => void;
        const exportCsv = vi.fn<(data: AppData, tasks: readonly Task[]) => Promise<boolean>>(() => new Promise<boolean>((resolve) => {
            resolveExport = resolve;
        }));
        const liveData = data([task('a'), task('b'), task('c')]);
        const getSnapshot = vi.fn(() => structuredClone(liveData));
        const selectedIds = ['b', 'a'];
        let selectionExport!: ReturnType<typeof useSelectedTasksCsvExport>;

        function Probe() {
            selectionExport = useSelectedTasksCsvExport(selectedIds, { exportCsv, getSnapshot });
            return null;
        }

        act(() => { renderer.create(<Probe />); });
        let exporting!: Promise<boolean>;
        act(() => {
            exporting = selectionExport.exportSelectedTasks();
        });

        expect(selectionExport.isExporting).toBe(true);
        expect(getSnapshot).toHaveBeenCalledTimes(1);
        expect(exportCsv).toHaveBeenCalledTimes(1);
        const [snapshot, selectedTasks] = exportCsv.mock.calls[0]!;
        expect(selectedTasks.map((item) => item.id)).toEqual(['b', 'a']);
        expect(snapshot.projects[0]?.title).toBe('Snapshot project');

        liveData.tasks[0]!.title = 'Changed while save dialog was open';
        liveData.projects[0]!.title = 'Changed metadata';
        selectedIds.splice(0, selectedIds.length, 'c');
        expect(selectedTasks.map((item) => item.title)).toEqual(['Task b', 'Task a']);
        expect(snapshot.projects[0]?.title).toBe('Snapshot project');

        await act(async () => {
            resolveExport(true);
            await exporting;
        });
        expect(selectionExport.isExporting).toBe(false);
        expect(selectedIds).toEqual(['c']);
    });

    it('does not export an empty, missing, deleted, or purged selection', async () => {
        const exportCsv = vi.fn().mockResolvedValue(true);
        const snapshot = data([
            task('live'),
            task('deleted', { deletedAt: now }),
            task('purged', { purgedAt: now }),
        ]);
        let selectionExport!: ReturnType<typeof useSelectedTasksCsvExport>;

        function Probe({ selectedIds }: { selectedIds: string[] }) {
            selectionExport = useSelectedTasksCsvExport(selectedIds, {
                exportCsv,
                getSnapshot: () => structuredClone(snapshot),
            });
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        act(() => { root = renderer.create(<Probe selectedIds={[]} />); });
        await act(async () => { await selectionExport.exportSelectedTasks(); });
        act(() => { root.update(<Probe selectedIds={['missing', 'deleted', 'purged']} />); });
        await act(async () => { await selectionExport.exportSelectedTasks(); });

        expect(exportCsv).not.toHaveBeenCalled();
    });

    it('guards repeated export while pending even if the selection bar hides and returns', async () => {
        let resolveExport!: (saved: boolean) => void;
        const exportCsv = vi.fn(() => new Promise<boolean>((resolve) => {
            resolveExport = resolve;
        }));
        const snapshot = data([task('a')]);
        let selectionExport!: ReturnType<typeof useSelectedTasksCsvExport>;
        const showToast = vi.fn();

        function Probe({ selectedIds }: { selectedIds: string[] }) {
            selectionExport = useSelectedTasksCsvExport(selectedIds, {
                exportCsv,
                getSnapshot: () => structuredClone(snapshot),
                showToast,
            });
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        act(() => { root = renderer.create(<Probe selectedIds={['a']} />); });
        let firstExport!: Promise<boolean>;
        act(() => { firstExport = selectionExport.exportSelectedTasks(); });
        act(() => { root.update(<Probe selectedIds={[]} />); });
        act(() => { root.update(<Probe selectedIds={['a']} />); });
        await act(async () => {
            await expect(selectionExport.exportSelectedTasks()).resolves.toBe(false);
        });

        expect(exportCsv).toHaveBeenCalledTimes(1);
        expect(selectionExport.isExporting).toBe(true);
        await act(async () => {
            resolveExport(true);
            await firstExport;
        });
        expect(showToast).toHaveBeenCalledWith('CSV exported successfully!', 'success');
    });

    it('keeps cancel silent and reports an export error without throwing', async () => {
        const showToast = vi.fn();
        const snapshot = data([task('a')]);
        const exportCsv = vi
            .fn()
            .mockResolvedValueOnce(false)
            .mockRejectedValueOnce(new Error('disk full'));
        let selectionExport!: ReturnType<typeof useSelectedTasksCsvExport>;

        function Probe() {
            selectionExport = useSelectedTasksCsvExport(['a'], {
                exportCsv,
                getSnapshot: () => structuredClone(snapshot),
                showToast,
            });
            return null;
        }

        act(() => { renderer.create(<Probe />); });
        await act(async () => {
            await expect(selectionExport.exportSelectedTasks()).resolves.toBe(false);
        });
        expect(showToast).not.toHaveBeenCalled();
        expect(reportErrorMock).not.toHaveBeenCalled();

        await act(async () => {
            await expect(selectionExport.exportSelectedTasks()).resolves.toBe(false);
        });
        expect(reportErrorMock).toHaveBeenCalledWith(
            'Failed to export selected tasks as CSV',
            expect.objectContaining({ message: 'disk full' }),
        );
        expect(showToast).toHaveBeenCalledWith('Failed to export CSV', 'error');
    });
});
