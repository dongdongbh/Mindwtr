import { useCallback, useEffect, useMemo, useState } from 'react';
import { Play } from 'lucide-react';
import { safeParseDate, type Area, type Project, type Task } from '@mindwtr/core';

import { InboxProcessingWizard, type ProcessingStep } from '../InboxProcessingWizard';

type InboxProcessorProps = {
    t: (key: string) => string;
    isInbox: boolean;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    addProject: (title: string, color: string) => Promise<Project>;
    updateTask: (id: string, updates: Partial<Task>) => Promise<void>;
    deleteTask: (id: string) => Promise<void>;
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
    addProject,
    updateTask,
    deleteTask,
    allContexts,
    isProcessing,
    setIsProcessing,
}: InboxProcessorProps) {
    const [processingTask, setProcessingTask] = useState<Task | null>(null);
    const [processingStep, setProcessingStep] = useState<ProcessingStep>('actionable');
    const [selectedContexts, setSelectedContexts] = useState<string[]>([]);
    const [delegateWho, setDelegateWho] = useState('');
    const [delegateFollowUp, setDelegateFollowUp] = useState('');
    const [projectSearch, setProjectSearch] = useState('');
    const [processingTitle, setProcessingTitle] = useState('');
    const [processingDescription, setProcessingDescription] = useState('');
    const [convertToProject, setConvertToProject] = useState(false);
    const [projectTitleDraft, setProjectTitleDraft] = useState('');
    const [nextActionDraft, setNextActionDraft] = useState('');
    const [customContext, setCustomContext] = useState('');

    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);

    const filteredProjects = useMemo(() => {
        if (!projectSearch.trim()) return projects;
        const query = projectSearch.trim().toLowerCase();
        return projects.filter((project) => project.title.toLowerCase().includes(query));
    }, [projects, projectSearch]);

    const hasExactProjectMatch = useMemo(() => {
        if (!projectSearch.trim()) return false;
        const query = projectSearch.trim().toLowerCase();
        return projects.some((project) => project.title.toLowerCase() === query);
    }, [projects, projectSearch]);

    const inboxCount = useMemo(() => (
        tasks.filter((task) => {
            if (task.status !== 'inbox' || task.deletedAt) return false;
            const start = safeParseDate(task.startTime);
            if (start && start > new Date()) return false;
            return true;
        }).length
    ), [tasks]);

    const remainingInboxCount = useMemo(
        () => tasks.filter((task) => task.status === 'inbox').length,
        [tasks]
    );

    useEffect(() => {
        if (isProcessing) return;
        setProcessingTask(null);
        setProcessingStep('actionable');
        setSelectedContexts([]);
        setDelegateWho('');
        setDelegateFollowUp('');
        setProjectSearch('');
        setProcessingTitle('');
        setProcessingDescription('');
        setConvertToProject(false);
        setProjectTitleDraft('');
        setNextActionDraft('');
        setCustomContext('');
    }, [isProcessing]);

    const hydrateProcessingTask = useCallback((task: Task) => {
        setProcessingTask(task);
        setProcessingStep('refine');
        setSelectedContexts(task.contexts ?? []);
        setCustomContext('');
        setProjectSearch('');
        setProcessingTitle(task.title);
        setProcessingDescription(task.description || '');
        setConvertToProject(false);
        setProjectTitleDraft(task.title);
        setNextActionDraft('');
    }, []);

    const startProcessing = useCallback(() => {
        const inboxTasks = tasks.filter((task) => task.status === 'inbox');
        if (inboxTasks.length === 0) return;
        hydrateProcessingTask(inboxTasks[0]);
        setIsProcessing(true);
    }, [tasks, hydrateProcessingTask, setIsProcessing]);

    const processNext = useCallback(() => {
        const currentTaskId = processingTask?.id;
        const inboxTasks = tasks.filter((task) => task.status === 'inbox' && task.id !== currentTaskId);
        if (inboxTasks.length > 0) {
            hydrateProcessingTask(inboxTasks[0]);
            return;
        }
        setIsProcessing(false);
        setProcessingTask(null);
        setSelectedContexts([]);
    }, [hydrateProcessingTask, processingTask?.id, tasks, setIsProcessing]);

    const applyProcessingEdits = useCallback((updates: Partial<Task>) => {
        if (!processingTask) return;
        const trimmedTitle = processingTitle.trim();
        const title = trimmedTitle.length > 0 ? trimmedTitle : processingTask.title;
        const description = processingDescription.trim();
        updateTask(processingTask.id, {
            title,
            description: description.length > 0 ? description : undefined,
            ...updates,
        });
    }, [processingDescription, processingTask, processingTitle, updateTask]);

    const handleNotActionable = useCallback((action: 'trash' | 'someday') => {
        if (!processingTask) return;
        if (action === 'trash') {
            deleteTask(processingTask.id);
        } else {
            applyProcessingEdits({ status: 'someday' });
        }
        processNext();
    }, [applyProcessingEdits, deleteTask, processNext, processingTask]);

    const handleActionable = () => setProcessingStep('twomin');

    const handleTwoMinDone = () => {
        if (processingTask) {
            applyProcessingEdits({ status: 'done' });
        }
        processNext();
    };

    const handleTwoMinNo = () => setProcessingStep('decide');

    const handleDelegate = () => {
        setDelegateWho('');
        setDelegateFollowUp('');
        setProcessingStep('delegate');
    };

    const handleConfirmWaiting = () => {
        if (processingTask) {
            const baseDescription = processingDescription.trim() || processingTask.description || '';
            const who = delegateWho.trim();
            const waitingLine = who ? `Waiting for: ${who}` : '';
            const nextDescription = [baseDescription, waitingLine]
                .map((line) => line.trim())
                .filter(Boolean)
                .join('\n');
            const followUpIso = delegateFollowUp
                ? new Date(`${delegateFollowUp}T09:00:00`).toISOString()
                : undefined;
            applyProcessingEdits({
                status: 'waiting',
                description: nextDescription.length > 0 ? nextDescription : undefined,
                reviewAt: followUpIso,
            });
        }
        setDelegateWho('');
        setDelegateFollowUp('');
        processNext();
    };

    const handleDelegateBack = () => {
        setProcessingStep('decide');
    };

    const handleSendDelegateRequest = () => {
        if (!processingTask) return;
        const title = processingTitle.trim() || processingTask.title;
        const baseDescription = processingDescription.trim() || processingTask.description || '';
        const who = delegateWho.trim();
        const greeting = who ? `Hi ${who},` : 'Hi,';
        const bodyParts = [
            greeting,
            '',
            `Could you please handle: ${title}`,
            baseDescription ? `\nDetails:\n${baseDescription}` : '',
            '',
            'Thanks!',
        ];
        const body = bodyParts.join('\n');
        const subject = `Delegation: ${title}`;
        const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        window.open(mailto);
    };

    const handleDefer = () => {
        setSelectedContexts(processingTask?.contexts ?? []);
        setProcessingStep('context');
    };

    const toggleContext = (ctx: string) => {
        setSelectedContexts((prev) =>
            prev.includes(ctx) ? prev.filter((item) => item !== ctx) : [...prev, ctx]
        );
    };

    const addCustomContext = () => {
        if (customContext.trim()) {
            const ctx = `@${customContext.trim().replace(/^@/, '')}`;
            if (!selectedContexts.includes(ctx)) {
                setSelectedContexts((prev) => [...prev, ctx]);
            }
            setCustomContext('');
        }
    };

    const handleConfirmContexts = () => {
        setProcessingStep('project');
    };

    const handleSetProject = (projectId: string | null) => {
        if (processingTask) {
            applyProcessingEdits({
                status: 'next',
                contexts: selectedContexts,
                projectId: projectId || undefined,
            });
        }
        processNext();
    };

    const handleConvertToProject = async () => {
        if (!processingTask) return;
        const projectTitle = projectTitleDraft.trim() || processingTitle.trim();
        const nextAction = nextActionDraft.trim();
        if (!projectTitle) return;
        if (!nextAction) {
            alert(t('process.nextActionRequired'));
            return;
        }
        const existing = projects.find((project) => project.title.toLowerCase() === projectTitle.toLowerCase());
        const project = existing ?? await addProject(projectTitle, '#94a3b8');
        applyProcessingEdits({
            title: nextAction,
            status: 'next',
            contexts: selectedContexts,
            projectId: project.id,
        });
        processNext();
    };

    if (!isInbox) return null;

    return (
        <>
            {inboxCount > 0 && !isProcessing && (
                <button
                    onClick={startProcessing}
                    className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground py-3 px-4 rounded-lg font-medium hover:bg-primary/90 transition-colors"
                >
                    <Play className="w-4 h-4" />
                    {t('process.btn')} ({inboxCount})
                </button>
            )}

            <InboxProcessingWizard
                t={t}
                isProcessing={isProcessing}
                processingTask={processingTask}
                processingStep={processingStep}
                processingTitle={processingTitle}
                processingDescription={processingDescription}
                setProcessingTitle={setProcessingTitle}
                setProcessingDescription={setProcessingDescription}
                setIsProcessing={setIsProcessing}
                handleRefineNext={() => setProcessingStep('actionable')}
                handleNotActionable={handleNotActionable}
                handleActionable={handleActionable}
                handleTwoMinDone={handleTwoMinDone}
                handleTwoMinNo={handleTwoMinNo}
                handleDefer={handleDefer}
                handleDelegate={handleDelegate}
                delegateWho={delegateWho}
                setDelegateWho={setDelegateWho}
                delegateFollowUp={delegateFollowUp}
                setDelegateFollowUp={setDelegateFollowUp}
                handleDelegateBack={handleDelegateBack}
                handleSendDelegateRequest={handleSendDelegateRequest}
                handleConfirmWaiting={handleConfirmWaiting}
                selectedContexts={selectedContexts}
                allContexts={allContexts}
                customContext={customContext}
                setCustomContext={setCustomContext}
                addCustomContext={addCustomContext}
                toggleContext={toggleContext}
                handleConfirmContexts={handleConfirmContexts}
                convertToProject={convertToProject}
                setConvertToProject={setConvertToProject}
                setProjectTitleDraft={setProjectTitleDraft}
                setNextActionDraft={setNextActionDraft}
                projectTitleDraft={projectTitleDraft}
                nextActionDraft={nextActionDraft}
                handleConvertToProject={handleConvertToProject}
                projectSearch={projectSearch}
                setProjectSearch={setProjectSearch}
                projects={projects}
                filteredProjects={filteredProjects}
                addProject={addProject}
                handleSetProject={handleSetProject}
                hasExactProjectMatch={hasExactProjectMatch}
                areaById={areaById}
                remainingCount={remainingInboxCount}
            />
        </>
    );
}
