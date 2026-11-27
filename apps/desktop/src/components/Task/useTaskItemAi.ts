import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    type AppData,
    type AIProviderId,
    type Area,
    type CopilotResponse,
    type Language,
    type ClarifyResponse,
    type TaskCopilotPart,
    type TaskDraft,
    type TaskDraftSetter,
    type TimeEstimate,
    createAIProvider,
    formatTaskTokenInput,
    generateUUID,
    getAIAreaCandidates,
    getTaskCopilotParts,
    keepTaskCopilotSuggestion,
    resolveSuggestedArea,
    splitTaskTokenInput,
    updateTaskFromLatest,
} from '@mindwtr/core';
import { buildAIConfig, buildCopilotConfig, isAIKeyRequired, loadAIKey } from '../../lib/ai-config';
import { logInfo, logWarn } from '../../lib/app-log';

type TaskItemAiContext = {
    projectTitle: string;
    projectTasks: string[];
} | null;


export type CopilotPart = Exclude<TaskCopilotPart, { kind: 'area' }>;
type AreaSuggestionDestination = Partial<Pick<TaskDraft, 'areaId' | 'projectId' | 'sectionId'>>;
const NO_AREAS: readonly Area[] = [];

type UseTaskItemAiArgs = {
    taskId: string;
    settings: AppData['settings'] | undefined;
    t: (key: string) => string;
    language?: Language;
    editTitle: string;
    editDescription: string;
    editContexts: string;
    editTags: string;
    editStartTime: string;
    editDueDate: string;
    editReviewAt: string;
    contextOptions: string[];
    tagOptions: string[];
    projectContext: TaskItemAiContext;
    timeEstimatesEnabled: boolean;
    setField: TaskDraftSetter;
    areas?: readonly Area[];
    destination?: AreaSuggestionDestination;
    destinationRevision?: number;
    editorSessionRevision?: number;

    copilotEnabled?: boolean;
};

export function useTaskItemAi({
    taskId,
    settings,
    t,
    language = 'en',
    editTitle,
    editDescription,
    editContexts,
    editTags,
    editStartTime,
    editDueDate,
    editReviewAt,
    contextOptions,
    tagOptions,
    projectContext,
    timeEstimatesEnabled,
    setField,
    areas = NO_AREAS,
    destination: { areaId, projectId, sectionId } = {},
    destinationRevision = 0,
    editorSessionRevision = 0,
    copilotEnabled = true,
}: UseTaskItemAiArgs) {
    const aiEnabled = settings?.ai?.enabled === true;
    const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
    const copilotModel = settings?.ai?.copilotModel;
    const keyRequired = isAIKeyRequired(settings);
    const title = editTitle.trim();
    const description = copilotEnabled ? editDescription.trim() : '';
    const clarifyRequestKey = JSON.stringify([taskId, editorSessionRevision, title]);
    const copilotRequestKey = copilotEnabled ? JSON.stringify([taskId, editorSessionRevision, title, description]) : '';

    const [aiKey, setAiKey] = useState('');
    const [clarifyResult, setClarifyResult] = useState<{ requestKey: string; response: ClarifyResponse; areaRevision?: number } | null>(null);
    const visibleClarifyResult = clarifyResult?.requestKey === clarifyRequestKey ? clarifyResult : null;
    const aiClarifyResponse = visibleClarifyResult?.response ?? null;
    const [aiError, setAiError] = useState<string | null>(null);
    const [aiBreakdownSteps, setAiBreakdownSteps] = useState<string[] | null>(null);
    const [copilotSuggestion, setCopilotSuggestion] = useState<(CopilotResponse & {
        language?: Language;
        areaRequest?: { key: string; revision: number };
    }) | null>(null);
    const visibleCopilotSuggestion = copilotSuggestion?.language === language ? copilotSuggestion : null;
    const [copilotContext, setCopilotContext] = useState<string | undefined>(undefined);
    const [copilotEstimate, setCopilotEstimate] = useState<TimeEstimate | undefined>(undefined);
    const [copilotTags, setCopilotTags] = useState<string[]>([]);
    const [isAIWorking, setIsAIWorking] = useState(false);
    const copilotInputRef = useRef<string>('');
    const copilotAbortRef = useRef<AbortController | null>(null);
    const copilotMountedRef = useRef(true);
    const areaCandidates = useMemo(() => getAIAreaCandidates(areas, { areaId, projectId, sectionId }), [areas, areaId, projectId, sectionId]);
    const getCurrentArea = useCallback((suggestedId: string | undefined, areaRevision: number | undefined) => (
        areaRevision === destinationRevision ? resolveSuggestedArea(suggestedId, areas, { areaId, projectId, sectionId }) : undefined
    ), [areaId, areas, destinationRevision, projectId, sectionId]);

    useEffect(() => {


        if (!aiEnabled) return;
        let active = true;
        loadAIKey(aiProvider)
            .then((key) => {
                if (active) setAiKey(key);
            })
            .catch(() => {
                if (active) setAiKey('');
            });
        return () => {
            active = false;
        };
    }, [aiEnabled, aiProvider]);

    useEffect(() => {
        if (!aiEnabled || !copilotEnabled || (keyRequired && !aiKey)) {
            setCopilotSuggestion(null);


            copilotInputRef.current = '';
            return;
        }
        const input = [title, description].filter(Boolean).join('\n');
        if (input.length < 4) {
            setCopilotSuggestion(null);
            copilotInputRef.current = '';
            return;
        }
        const signature = JSON.stringify({
            request: copilotRequestKey,
            contexts: editContexts,
            provider: aiProvider,
            language,
            model: copilotModel ?? '',
            tags: tagOptions,
            timeEstimatesEnabled,
            areas: areaCandidates,
        });
        if (signature === copilotInputRef.current) {
            return;
        }
        let cancelled = false;
        let completed = false;
        let localAbort: AbortController | null = null;
        const handle = setTimeout(async () => {


            copilotInputRef.current = signature;
            try {
                const currentContexts = splitTaskTokenInput(editContexts);
                const provider = createAIProvider(await buildCopilotConfig(settings ?? {}, aiKey, language));
                if (cancelled) return;
                const abortController = typeof AbortController === 'function' ? new AbortController() : null;
                localAbort = abortController;
                const previousController = copilotAbortRef.current;
                if (abortController) {
                    copilotAbortRef.current = abortController;
                }
                if (previousController) {
                    previousController.abort();
                }
                const suggestion = await provider.predictMetadata(
                    {
                        title: input,
                        contexts: Array.from(new Set([...contextOptions, ...currentContexts])),
                        tags: tagOptions,
                        ...(areaCandidates.length ? { areas: areaCandidates } : {}),
                    },
                    abortController ? { signal: abortController.signal } : undefined
                );
                if (cancelled || !copilotMountedRef.current) return;
                completed = true;
                const areaRequest = areaCandidates.some((area) => area.id === suggestion.areaId)
                    ? { key: copilotRequestKey, revision: destinationRevision }
                    : undefined;
                const next = keepTaskCopilotSuggestion(suggestion, timeEstimatesEnabled);
                setCopilotSuggestion(next ? { ...next, language, areaRequest } : null);
            } catch (error) {
                if (!cancelled && copilotMountedRef.current) {
                    setCopilotSuggestion(null);
                    const message = error instanceof Error ? error.message : String(error);
                    void logWarn('AI copilot failed', {
                        scope: 'ai',
                        extra: {
                            step: 'copilot',
                            provider: aiProvider,
                            model: copilotModel ?? '',
                            taskId,
                            error: message,
                        },
                    });
                }
            }
        }, 800);
        return () => {
            cancelled = true;
            clearTimeout(handle);
            if (!completed && copilotInputRef.current === signature) copilotInputRef.current = '';
            if (copilotAbortRef.current && copilotAbortRef.current === localAbort) {
                copilotAbortRef.current.abort();
                copilotAbortRef.current = null;
            }
        };
    }, [aiEnabled, aiKey, aiProvider, areaCandidates, contextOptions, copilotEnabled, copilotModel, copilotRequestKey, description, destinationRevision, editContexts, keyRequired, language, settings, tagOptions, taskId, timeEstimatesEnabled, title]);

    useEffect(() => {
        copilotMountedRef.current = true;
        return () => {
            copilotMountedRef.current = false;
            if (copilotAbortRef.current) {
                copilotAbortRef.current.abort();
                copilotAbortRef.current = null;
            }
        };
    }, []);


    const logAIFailure = useCallback((step: string, message: string) => {
        void logWarn(`AI ${step} failed`, {
            scope: 'ai',
            extra: {
                step,
                provider: aiProvider,
                model: settings?.ai?.model ?? '',
                taskId,
                error: message,
            },
        });
    }, [aiProvider, settings?.ai?.model, taskId]);

    const getAIProvider = useCallback(async () => {
        if (!aiEnabled) {
            setAiError(t('ai.disabledBody'));
            return null;
        }
        if (keyRequired && !aiKey) {
            setAiError(t('ai.missingKeyBody'));
            return null;
        }
        return createAIProvider(await buildAIConfig(settings, aiKey, language));
    }, [aiEnabled, aiKey, keyRequired, language, settings, t]);

    const resetCopilotDraft = useCallback(() => {
        setCopilotContext(undefined);
        setCopilotEstimate(undefined);
        setCopilotTags([]);
    }, []);

    const resetAiState = useCallback(() => {
        setClarifyResult(null);
        setAiError(null);
        setAiBreakdownSteps(null);
        setCopilotSuggestion(null);
        setCopilotContext(undefined);
        setCopilotEstimate(undefined);
        setCopilotTags([]);
        copilotInputRef.current = '';
    }, []);

    const clearAiBreakdown = useCallback(() => {
        setAiBreakdownSteps(null);
    }, []);

    const clearAiClarify = useCallback(() => {
        setClarifyResult(null);
    }, []);


    const copilotAreaRevision = visibleCopilotSuggestion?.areaRequest?.key === copilotRequestKey
        ? visibleCopilotSuggestion.areaRequest.revision
        : undefined;
    const pendingCopilotParts = useMemo(() => getTaskCopilotParts(
        visibleCopilotSuggestion,
        { context: copilotContext, timeEstimate: copilotEstimate, tags: copilotTags },
        timeEstimatesEnabled,
        getCurrentArea(visibleCopilotSuggestion?.areaId, copilotAreaRevision),
    ), [copilotAreaRevision, copilotContext, copilotEstimate, copilotTags, getCurrentArea, timeEstimatesEnabled, visibleCopilotSuggestion]);

    const applyAreaSuggestion = useCallback((suggestedId: string, areaRevision: number | undefined, source: 'clarify' | 'copilot') => {
        const current = getCurrentArea(suggestedId, areaRevision);
        if (!current) return;
        setField('areaId', current.id);
        void logInfo('AI area suggestion applied to draft', {
            scope: 'ai',
            extra: { releaseCheck: 'v1.3.10/ai-area-suggestion', source },
        });
    }, [getCurrentArea, setField]);


    const applyCopilotParts = useCallback((parts: TaskCopilotPart[]) => {
        if (parts.length === 0) return;
        const context = parts.find((part) => part.kind === 'context')?.value;
        const estimate = parts.find((part) => part.kind === 'timeEstimate')?.value;
        const tags = parts.filter((part) => part.kind === 'tag').map((part) => part.value);
        if (context) {
            const currentContexts = splitTaskTokenInput(editContexts);
            setField('contexts', formatTaskTokenInput([...new Set([...currentContexts, context])]));
            setCopilotContext(context);
        }
        if (tags.length) {
            const currentTags = splitTaskTokenInput(editTags);
            setField('tags', formatTaskTokenInput([...new Set([...currentTags, ...tags])]));
            setCopilotTags((prev) => Array.from(new Set([...prev, ...tags])));
        }
        if (estimate && timeEstimatesEnabled) {
            setField('timeEstimate', estimate as TimeEstimate);
            setCopilotEstimate(estimate as TimeEstimate);
        }
        const area = parts.find((part) => part.kind === 'area');
        if (area && area.value === visibleCopilotSuggestion?.areaId) {
            applyAreaSuggestion(area.value, copilotAreaRevision, 'copilot');
        }
    }, [applyAreaSuggestion, copilotAreaRevision, editContexts, editTags, setField, timeEstimatesEnabled, visibleCopilotSuggestion]);

    const applyCopilotPart = useCallback((part: TaskCopilotPart) => {
        applyCopilotParts([part]);
    }, [applyCopilotParts]);

    const applyCopilotSuggestion = useCallback(() => {
        applyCopilotParts(pendingCopilotParts);
    }, [applyCopilotParts, pendingCopilotParts]);

    const applyAISuggestion = useCallback((suggested: { title?: string; context?: string; timeEstimate?: TimeEstimate }) => {
        if (suggested.title) setField('title', suggested.title);
        if (suggested.timeEstimate && timeEstimatesEnabled) setField('timeEstimate', suggested.timeEstimate);
        if (suggested.context) {
            const currentContexts = splitTaskTokenInput(editContexts);
            const nextContexts = Array.from(new Set([...currentContexts, suggested.context]));
            setField('contexts', formatTaskTokenInput(nextContexts));
        }
        setClarifyResult(null);
    }, [editContexts, setField, timeEstimatesEnabled]);

    const handleAIClarify = useCallback(async () => {
        if (isAIWorking) return;
        if (!title) return;
        const provider = await getAIProvider();
        if (!provider) return;
        setIsAIWorking(true);
        setAiError(null);
        setAiBreakdownSteps(null);
        try {
            const currentContexts = splitTaskTokenInput(editContexts);
            const response = await provider.clarifyTask({
                title,
                contexts: Array.from(new Set([...contextOptions, ...currentContexts])),
                startTime: editStartTime || undefined,
                dueDate: editDueDate || undefined,
                reviewAt: editReviewAt || undefined,
                ...(areaCandidates.length ? { areas: areaCandidates } : {}),
                ...(projectContext ?? {}),
            });
            const areaRevision = areaCandidates.some((area) => area.id === response.suggestedAction?.areaId) ? destinationRevision : undefined;
            setClarifyResult({ requestKey: clarifyRequestKey, response, areaRevision });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setAiError(message);
            logAIFailure('clarify', message);
        } finally {
            setIsAIWorking(false);
        }
    }, [areaCandidates, clarifyRequestKey, contextOptions, destinationRevision, editContexts, editDueDate, editReviewAt, editStartTime, getAIProvider, isAIWorking, logAIFailure, projectContext, title]);

    const handleAIBreakdown = useCallback(async () => {
        if (isAIWorking) return;
        const title = editTitle.trim();
        if (!title) return;
        const provider = await getAIProvider();
        if (!provider) return;
        setIsAIWorking(true);
        setAiError(null);
        setAiBreakdownSteps(null);
        try {
            const response = await provider.breakDownTask({
                title,
                description: editDescription,
                ...(projectContext ?? {}),
            });
            const steps = response.steps.map((step) => step.trim()).filter(Boolean).slice(0, 8);
            if (steps.length === 0) return;
            setAiBreakdownSteps(steps);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setAiError(message);
            logAIFailure('breakdown', message);
        } finally {
            setIsAIWorking(false);
        }
    }, [editDescription, editTitle, getAIProvider, isAIWorking, logAIFailure, projectContext]);


    const addBreakdownStepsToChecklist = useCallback(() => {
        if (!aiBreakdownSteps?.length) return;
        const newItems = aiBreakdownSteps.map((step) => ({
            id: generateUUID(),
            title: step,
            isCompleted: false,
        }));

        void updateTaskFromLatest(taskId, (latest) => ({ checklist: [...(latest.checklist ?? []), ...newItems] }));
        setAiBreakdownSteps(null);
    }, [aiBreakdownSteps, taskId]);

    const selectClarifyOption = useCallback((action: string) => {
        if (!aiClarifyResponse?.options.some((option) => option.action === action)) return;
        setField('title', action);
        setClarifyResult(null);
    }, [aiClarifyResponse, setField]);

    const applyClarifySuggestion = useCallback(() => {
        if (!aiClarifyResponse?.suggestedAction) return;
        applyAISuggestion(aiClarifyResponse.suggestedAction);
    }, [aiClarifyResponse, applyAISuggestion]);

    const clarifyArea = getCurrentArea(aiClarifyResponse?.suggestedAction?.areaId, visibleClarifyResult?.areaRevision);
    const applyClarifyArea = useCallback(() => {
        const suggestedId = aiClarifyResponse?.suggestedAction?.areaId;
        if (suggestedId) applyAreaSuggestion(suggestedId, visibleClarifyResult?.areaRevision, 'clarify');
    }, [aiClarifyResponse, applyAreaSuggestion, visibleClarifyResult?.areaRevision]);

    return {
        aiEnabled,
        isAIWorking,
        aiClarifyResponse,
        clarifyArea,
        aiError,
        aiBreakdownSteps,
        copilotSuggestion: visibleCopilotSuggestion,
        copilotContext,
        copilotEstimate,
        copilotTags,
        pendingCopilotParts,
        resetCopilotDraft,
        resetAiState,
        clearAiBreakdown,
        clearAiClarify,
        applyCopilotPart,
        applyCopilotSuggestion,
        addBreakdownStepsToChecklist,
        selectClarifyOption,
        applyClarifySuggestion,
        applyClarifyArea,
        handleAIClarify,
        handleAIBreakdown,
    };
}
