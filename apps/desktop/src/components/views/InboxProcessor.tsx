import { Play } from 'lucide-react';
import type { AppData, Area, Project, Task } from '@mindwtr/core';

import { InboxProcessingQuickPanel } from '../InboxProcessingQuickPanel';
import { InboxProcessingWizard } from '../InboxProcessingWizard';
import { useInboxProcessingController } from './inbox/useInboxProcessingController';

type InboxProcessorProps = {
    t: (key: string) => string;
    isInbox: boolean;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings?: AppData['settings'];
    addProject: (title: string, color: string) => Promise<Project | null>;
    updateTask: (id: string, updates: Partial<Task>) => Promise<unknown>;
    deleteTask: (id: string) => Promise<unknown>;
    allContexts: string[];
    isProcessing: boolean;
    setIsProcessing: (value: boolean) => void;
};

export function InboxProcessor({
    t,
    isInbox,
    tasks,
    projects,
    areas,
    settings,
    addProject,
    updateTask,
    deleteTask,
    allContexts,
    isProcessing,
    setIsProcessing,
}: InboxProcessorProps) {
    const {
        inboxCount,
        quickPanelProps,
        showStartButton,
        startProcessing,
        wizardProps,
    } = useInboxProcessingController({
        t,
        tasks,
        projects,
        areas,
        settings,
        addProject,
        updateTask,
        deleteTask,
        allContexts,
        isProcessing,
        setIsProcessing,
    });

    if (!isInbox) return null;

    return (
        <>
            {showStartButton && (
                <button
                    onClick={startProcessing}
                    className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground py-3 px-4 rounded-lg font-medium hover:bg-primary/90 transition-colors"
                >
                    <Play className="w-4 h-4" />
                    {t('process.btn')} ({inboxCount})
                </button>
            )}

            {quickPanelProps ? (
                <InboxProcessingQuickPanel {...quickPanelProps} />
            ) : (
                <InboxProcessingWizard {...wizardProps} />
            )}
        </>
    );
}
