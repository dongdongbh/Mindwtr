import { useEffect } from 'react';
import { useTaskStore } from '@mindwtr/core';
import { QuickAddModal } from './components/QuickAddModal';
import { reportError } from './lib/report-error';

export function QuickAddWindowApp() {
    const fetchData = useTaskStore((state) => state.fetchData);

    useEffect(() => {
        fetchData({ silent: true }).catch((error) => reportError('Failed to load quick add data', error));
    }, [fetchData]);

    return (
        <div className="h-full bg-background text-foreground">
            <QuickAddModal standaloneWindow />
        </div>
    );
}
