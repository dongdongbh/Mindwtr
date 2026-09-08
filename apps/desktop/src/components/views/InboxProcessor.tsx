import { Play } from 'lucide-react';
import type { AppData, Area, Project, StoreActionResult, Task } from '@mindwtr/core';

import {
    dismissDesktopOnboardingHint,
} from '../../lib/desktop-onboarding-events';
import { InboxProcessingQuickPanel } from '../InboxProcessingQuickPanel';
import { InboxProcessingWizard } from '../InboxProcessingWizard';
import { MindSweepLauncher, MindSweepTrigger } from '../MindSweepModal';
import { useInboxProcessingController } from './inbox/useInboxProcessingController';

type InboxProcessorProps = {
    t: (key: string) => string;
    isInbox: boolean;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings?: AppData['settings'];
    addTask: (title: string, initialProps?: Partial<Task>) => Promise<StoreActionResult>;
    addProject: (title: string, color: string, initialProps?: Partial<Project>) => Promise<Project | null>;
    updateTask: (id: string, updates: Partial<Task>) => Promise<StoreActionResult>;
    deleteTask: (id: string) => Promise<StoreActionResult>;
    allContexts: string[];
    allTags: string[];
    isProcessing: boolean;
    setIsProcessing: (value: boolean) => void;
    onOpenMindSweep?: () => void;
};

export function InboxProcessor({
    t,
    isInbox,
    tasks,
    projects,
    areas,
    settings,
    addTask,
    addProject,
    updateTask,
    deleteTask,
    allContexts,
    allTags,
    isProcessing,
    setIsProcessing,
    onOpenMindSweep,
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
        addTask,
        updateTask,
        deleteTask,
        allContexts,
        allTags,
        isProcessing,
        setIsProcessing,
    });

    if (!isInbox) return null;

    return (
        <>
            {showStartButton && (
                <div className="flex flex-wrap items-stretch gap-2">
                    <button
                        onClick={() => {
                            dismissDesktopOnboardingHint('inbox-project');
                            startProcessing();
                        }}
                        className="flex flex-1 items-center justify-center gap-2 whitespace-nowrap bg-primary px-4 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/90 rounded-lg"
                    >
                        <Play className="w-4 h-4" />
                        {t('process.btn')} ({inboxCount})
                    </button>
                    {onOpenMindSweep ? (
                        <MindSweepTrigger t={t} onOpen={onOpenMindSweep} variant="secondary" />
                    ) : (
                        <MindSweepLauncher t={t} addTask={addTask} variant="secondary" />
                    )}
                </div>
            )}

            {quickPanelProps ? (
                <InboxProcessingQuickPanel {...quickPanelProps} />
            ) : (
                <InboxProcessingWizard
                    key={wizardProps.processingTask?.id ?? 'idle'}
                    {...wizardProps}
                />
            )}
        </>
    );
}
