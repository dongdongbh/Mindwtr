import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    type AppData,
    type AIProviderId,
    type ClarifyResponse,
    type TaskDraftSetter,
    type TimeEstimate,
    createAIProvider,
    generateUUID,
    useTaskStore,
} from '@mindwtr/core';
import { buildAIConfig, buildCopilotConfig, isAIKeyRequired, loadAIKey } from '../../lib/ai-config';
import { logWarn } from '../../lib/app-log';

type TaskItemAiContext = {
    projectTitle: string;
    projectTasks: string[];
} | null;

/** One separately applicable piece of a copilot suggestion. */
export type CopilotPart = { kind: 'context' | 'timeEstimate' | 'tag'; value: string };

type UseTaskItemAiArgs = {
    taskId: string;
    settings: AppData['settings'] | undefined;
    t: (key: string) => string;
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
    /** Off for surfaces that only want the on-demand actions (no background metadata calls). */
    copilotEnabled?: boolean;
};

export function useTaskItemAi({
    taskId,
    settings,
    t,
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
    copilotEnabled = true,
}: UseTaskItemAiArgs) {
    const aiEnabled = settings?.ai?.enabled === true;
    const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
    const copilotModel = settings?.ai?.copilotModel;
    const keyRequired = isAIKeyRequired(settings);

    const [aiKey, setAiKey] = useState('');
    const [aiClarifyResponse, setAiClarifyResponse] = useState<ClarifyResponse | null>(null);
    const [aiError, setAiError] = useState<string | null>(null);
    const [aiBreakdownSteps, setAiBreakdownSteps] = useState<string[] | null>(null);
    const [copilotSuggestion, setCopilotSuggestion] = useState<{ context?: string; timeEstimate?: TimeEstimate; tags?: string[] } | null>(null);
    const [copilotContext, setCopilotContext] = useState<string | undefined>(undefined);
    const [copilotEstimate, setCopilotEstimate] = useState<TimeEstimate | undefined>(undefined);
    const [copilotTags, setCopilotTags] = useState<string[]>([]);
    const [isAIWorking, setIsAIWorking] = useState(false);
    const copilotInputRef = useRef<string>('');
    const copilotAbortRef = useRef<AbortController | null>(null);
    const copilotMountedRef = useRef(true);

    useEffect(() => {
        // No key read for the surfaces that never call a provider: every task
        // row mounts this hook, and most of them have AI switched off.
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
            // Row went inactive with a signature already dispatched (e.g. the
            // editor closed): clear it so reopening with unchanged text isn't
            // treated as a duplicate of a request that never really re-ran.
            copilotInputRef.current = '';
            return;
        }
        const title = editTitle.trim();
        const description = editDescription.trim();
        const input = [title, description].filter(Boolean).join('\n');
        if (input.length < 4) {
            setCopilotSuggestion(null);
            copilotInputRef.current = '';
            return;
        }
        const signature = JSON.stringify({
            input,
            contexts: editContexts,
            provider: aiProvider,
            model: copilotModel ?? '',
            tags: tagOptions,
            timeEstimatesEnabled,
        });
        if (signature === copilotInputRef.current) {
            return;
        }
        let cancelled = false;
        let localAbort: AbortController | null = null;
        const handle = setTimeout(async () => {
            // Record the signature only once the request actually dispatches:
            // a re-render can clear this timer before it fires (effect
            // cleanup below), and marking the ref at schedule time would make
            // that rerun's dedup check see a signature that was never really
            // sent, permanently skipping the reschedule.
            copilotInputRef.current = signature;
            try {
                const currentContexts = editContexts.split(',').map((c) => c.trim()).filter(Boolean);
                const provider = createAIProvider(await buildCopilotConfig(settings ?? {}, aiKey));
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
                    },
                    abortController ? { signal: abortController.signal } : undefined
                );
                if (cancelled || !copilotMountedRef.current) return;
                if (!suggestion.context && (!timeEstimatesEnabled || !suggestion.timeEstimate) && !suggestion.tags?.length) {
                    setCopilotSuggestion(null);
                } else {
                    setCopilotSuggestion(suggestion);
                }
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
            if (copilotAbortRef.current && copilotAbortRef.current === localAbort) {
                copilotAbortRef.current.abort();
                copilotAbortRef.current = null;
            }
        };
    }, [aiEnabled, aiKey, aiProvider, contextOptions, copilotEnabled, copilotModel, editContexts, editDescription, editTitle, keyRequired, settings, tagOptions, taskId, timeEstimatesEnabled]);

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

    // One log line per AI failure, through the app-log adapter: the provider,
    // model and task that produced it are the whole point of the entry.
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
        return createAIProvider(await buildAIConfig(settings, aiKey));
    }, [aiEnabled, aiKey, keyRequired, settings, t]);

    const resetCopilotDraft = useCallback(() => {
        setCopilotContext(undefined);
        setCopilotEstimate(undefined);
        setCopilotTags([]);
    }, []);

    const resetAiState = useCallback(() => {
        setAiClarifyResponse(null);
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
        setAiClarifyResponse(null);
    }, []);

    // The suggestion splits into parts the user applies one at a time (#1022);
    // a part leaves the pending list once it is in the applied markers below.
    const pendingCopilotParts = useMemo<CopilotPart[]>(() => {
        if (!copilotSuggestion) return [];
        const parts: CopilotPart[] = [];
        if (copilotSuggestion.context && copilotSuggestion.context !== copilotContext) {
            parts.push({ kind: 'context', value: copilotSuggestion.context });
        }
        if (timeEstimatesEnabled && copilotSuggestion.timeEstimate && copilotSuggestion.timeEstimate !== copilotEstimate) {
            parts.push({ kind: 'timeEstimate', value: copilotSuggestion.timeEstimate });
        }
        for (const tag of copilotSuggestion.tags ?? []) {
            if (!copilotTags.includes(tag)) parts.push({ kind: 'tag', value: tag });
        }
        return parts;
    }, [copilotContext, copilotEstimate, copilotSuggestion, copilotTags, timeEstimatesEnabled]);

    // Batched on purpose: applying several tags one call at a time would each
    // re-read the same stale draft string and drop all but the last.
    const applyCopilotParts = useCallback((parts: CopilotPart[]) => {
        if (parts.length === 0) return;
        const context = parts.find((part) => part.kind === 'context')?.value;
        const estimate = parts.find((part) => part.kind === 'timeEstimate')?.value;
        const tags = parts.filter((part) => part.kind === 'tag').map((part) => part.value);
        if (context) {
            const currentContexts = editContexts.split(',').map((c) => c.trim()).filter(Boolean);
            setField('contexts', Array.from(new Set([...currentContexts, context])).join(', '));
            setCopilotContext(context);
        }
        if (tags.length) {
            const currentTags = editTags.split(',').map((t) => t.trim()).filter(Boolean);
            setField('tags', Array.from(new Set([...currentTags, ...tags])).join(', '));
            setCopilotTags((prev) => Array.from(new Set([...prev, ...tags])));
        }
        if (estimate && timeEstimatesEnabled) {
            setField('timeEstimate', estimate as TimeEstimate);
            setCopilotEstimate(estimate as TimeEstimate);
        }
    }, [editContexts, editTags, setField, timeEstimatesEnabled]);

    const applyCopilotPart = useCallback((part: CopilotPart) => {
        applyCopilotParts([part]);
    }, [applyCopilotParts]);

    const applyCopilotSuggestion = useCallback(() => {
        applyCopilotParts(pendingCopilotParts);
    }, [applyCopilotParts, pendingCopilotParts]);

    const applyAISuggestion = useCallback((suggested: { title?: string; context?: string; timeEstimate?: TimeEstimate }) => {
        if (suggested.title) setField('title', suggested.title);
        if (suggested.timeEstimate && timeEstimatesEnabled) setField('timeEstimate', suggested.timeEstimate);
        if (suggested.context) {
            const currentContexts = editContexts.split(',').map((c) => c.trim()).filter(Boolean);
            const nextContexts = Array.from(new Set([...currentContexts, suggested.context]));
            setField('contexts', nextContexts.join(', '));
        }
        setAiClarifyResponse(null);
    }, [editContexts, setField, timeEstimatesEnabled]);

    const handleAIClarify = useCallback(async () => {
        if (isAIWorking) return;
        const title = editTitle.trim();
        if (!title) return;
        const provider = await getAIProvider();
        if (!provider) return;
        setIsAIWorking(true);
        setAiError(null);
        setAiBreakdownSteps(null);
        try {
            const currentContexts = editContexts.split(',').map((c) => c.trim()).filter(Boolean);
            const response = await provider.clarifyTask({
                title,
                contexts: Array.from(new Set([...contextOptions, ...currentContexts])),
                startTime: editStartTime || undefined,
                dueDate: editDueDate || undefined,
                reviewAt: editReviewAt || undefined,
                ...(projectContext ?? {}),
            });
            setAiClarifyResponse(response);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setAiError(message);
            logAIFailure('clarify', message);
        } finally {
            setIsAIWorking(false);
        }
    }, [contextOptions, editContexts, editDueDate, editReviewAt, editStartTime, editTitle, getAIProvider, isAIWorking, logAIFailure, projectContext]);

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

    // The three behaviours below used to live as inline closures on the row
    // component; they are AI outcomes, so they belong beside the state they
    // consume.
    const addBreakdownStepsToChecklist = useCallback(() => {
        if (!aiBreakdownSteps?.length) return;
        const { _tasksById, updateTask } = useTaskStore.getState();
        const checklist = _tasksById.get(taskId)?.checklist ?? [];
        const newItems = aiBreakdownSteps.map((step) => ({
            id: generateUUID(),
            title: step,
            isCompleted: false,
        }));
        void updateTask(taskId, { checklist: [...checklist, ...newItems] });
        setAiBreakdownSteps(null);
    }, [aiBreakdownSteps, taskId]);

    const selectClarifyOption = useCallback((action: string) => {
        setField('title', action);
        setAiClarifyResponse(null);
    }, [setField]);

    const applyClarifySuggestion = useCallback(() => {
        if (!aiClarifyResponse?.suggestedAction) return;
        applyAISuggestion(aiClarifyResponse.suggestedAction);
    }, [aiClarifyResponse, applyAISuggestion]);

    return {
        aiEnabled,
        isAIWorking,
        aiClarifyResponse,
        aiError,
        aiBreakdownSteps,
        copilotSuggestion,
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
        handleAIClarify,
        handleAIBreakdown,
    };
}
