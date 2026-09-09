import { useCallback, useRef, useState } from 'react';
import {
    getInMemoryAppDataSnapshot,
    tFallback,
    type AppData,
    type Task,
} from '@mindwtr/core';

import { reportError } from '../../../lib/report-error';

type ShowToast = (
    message: string,
    tone?: 'success' | 'error' | 'info',
) => void;

type SelectedTasksCsvExportDependencies = {
    exportCsv?: (data: AppData, tasks: readonly Task[]) => Promise<boolean>;
    getSnapshot?: () => AppData;
};

type UseSelectedTasksCsvExportOptions = SelectedTasksCsvExportDependencies & {
    showToast?: ShowToast;
    t?: (key: string) => string;
};

const exportCsvWithDesktopDialog = async (data: AppData, tasks: readonly Task[]) => {
    const { exportDesktopCsv } = await import('../../../lib/data-transfer');
    return exportDesktopCsv(data, tasks);
};

export function useSelectedTasksCsvExport(
    selectedTaskIds: readonly string[],
    options: UseSelectedTasksCsvExportOptions = {},
) {
    const {
        exportCsv = exportCsvWithDesktopDialog,
        getSnapshot = getInMemoryAppDataSnapshot,
        showToast,
        t,
    } = options;
    const [isExporting, setIsExporting] = useState(false);
    const exportingRef = useRef(false);

    const exportSelectedTasks = useCallback(async (): Promise<boolean> => {
        if (exportingRef.current || selectedTaskIds.length === 0) return false;

        // Capture both the selected ids and the full metadata snapshot before
        // the lazy import or native save dialog can yield. Only live selected
        // tasks from this snapshot are eligible for the export.
        const frozenSelectedIds = [...selectedTaskIds];
        const exportData = getSnapshot();
        const taskById = new Map(exportData.tasks.map((task) => [task.id, task]));
        const exportTasks = frozenSelectedIds.flatMap((taskId) => {
            const task = taskById.get(taskId);
            return task && !task.deletedAt && !task.purgedAt ? [task] : [];
        });
        if (exportTasks.length === 0) return false;

        exportingRef.current = true;
        setIsExporting(true);
        try {
            const saved = await exportCsv(exportData, exportTasks);
            if (saved) {
                showToast?.(
                    tFallback(t ?? ((key) => key), 'settings.exportCsvSuccess', 'CSV exported successfully!'),
                    'success',
                );
            }
            return saved;
        } catch (error) {
            reportError('Failed to export selected tasks as CSV', error);
            showToast?.(
                tFallback(t ?? ((key) => key), 'settings.exportCsvFailed', 'Failed to export CSV'),
                'error',
            );
            return false;
        } finally {
            exportingRef.current = false;
            setIsExporting(false);
        }
    }, [exportCsv, getSnapshot, selectedTaskIds, showToast, t]);

    return { exportSelectedTasks, isExporting };
}
