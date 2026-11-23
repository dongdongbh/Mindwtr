import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createAIProvider, useTaskStore, type AIProviderId, type AppData, type Area, type Language, type TimeEstimate } from '@mindwtr/core';
import {
    applyTaskCopilotParts,
    getAIAreaCandidates,
    getTaskCopilotParts,
    getTaskCopilotText,
    keepTaskCopilotSuggestion,
    resolveSuggestedArea,
    TASK_COPILOT_DELAY_MS,
    type TaskCopilotPart,
} from '@mindwtr/core/ai-task-actions';
import type { TaskDraft, TaskDraftSetter } from '@mindwtr/core/task-draft';
import { buildCopilotConfig, isAIKeyRequired, loadAIKey } from '../../lib/ai-config';
import { logError, logInfo } from '../../lib/app-log';
import type { TaskAIAreaDestination } from './use-task-edit-state';

type CopilotSuggestion = {
    language: Language;
    context?: string;
    timeEstimate?: TimeEstimate;
    tags?: string[];
    areaId?: string;
    areaRevision?: number;
    text: string;
};


export type CopilotPart = TaskCopilotPart;

type UseTaskEditCopilotArgs = {
    settings: AppData['settings'];
    language?: Language;
    aiEnabled: boolean;
    aiProvider: AIProviderId;
    areas?: readonly Area[];
    getAreaDestination?: () => TaskAIAreaDestination | null;
    timeEstimatesEnabled: boolean;
    titleDraft: string;
    descriptionDraft: string;
    contextOptions: string[];
    tagOptions: string[];
    draft: TaskDraft | null;
    visible: boolean;
    setDraftField: TaskDraftSetter;
};

export function useTaskEditCopilot({
    settings,
    language = 'en',
    aiEnabled,
    aiProvider,
    areas,
    getAreaDestination,
    timeEstimatesEnabled,
    titleDraft,
    descriptionDraft,
    contextOptions,
    tagOptions,
    draft,
    visible,
    setDraftField,
}: UseTaskEditCopilotArgs) {
    const [aiKey, setAiKey] = useState('');
    const keyRequired = isAIKeyRequired(settings);
    const [copilotSuggestion, setCopilotSuggestion] = useState<CopilotSuggestion | null>(null);
    const copilotText = getTaskCopilotText(titleDraft, descriptionDraft);
    const visibleCopilotSuggestion = copilotSuggestion?.language === language ? copilotSuggestion : null;
    const [copilotContext, setCopilotContext] = useState<string | undefined>(undefined);
    const [copilotEstimate, setCopilotEstimate] = useState<TimeEstimate | undefined>(undefined);
    const [copilotTags, setCopilotTags] = useState<string[]>([]);
    const [showAllContexts, setShowAllContexts] = useState(false);
    const [showAllTags, setShowAllTags] = useState(false);
    const copilotMountedRef = useRef(true);
    const copilotAbortRef = useRef<AbortController | null>(null);
    const contextOptionsRef = useRef<string[]>([]);
    const tagOptionsRef = useRef<string[]>([]);

    useEffect(() => {
        Promise.resolve()
            .then(() => loadAIKey(aiProvider))
            .then((value) => {
                setAiKey(typeof value === 'string' ? value : '');
            })
            .catch((error) => {
                void logError(error, { scope: 'ai', extra: { message: 'Failed to load AI key' } });
                setAiKey('');
            });
    }, [aiProvider]);

    useEffect(() => {
        copilotMountedRef.current = true;
        return () => {
            copilotMountedRef.current = false;
        };
    }, []);

    useEffect(() => {
        contextOptionsRef.current = contextOptions;
        tagOptionsRef.current = tagOptions;
    }, [contextOptions, tagOptions]);

    useEffect(() => {
        if (!visible || !aiEnabled || (keyRequired && !aiKey)) {
            setCopilotSuggestion(null);
            return;
        }
        const input = copilotText;
        if (!input) {
            setCopilotSuggestion(null);
            return;
        }
        const destination = getAreaDestination?.();
        const candidates = destination ? getAIAreaCandidates(useTaskStore.getState().areas, destination) : [];
        let cancelled = false;
        let localAbortController: AbortController | null = null;
        const handle = setTimeout(async () => {
            const abortController = typeof AbortController === 'function' ? new AbortController() : null;
            localAbortController = abortController;
            const previousController = copilotAbortRef.current;
            if (abortController) {
                copilotAbortRef.current = abortController;
            }
            if (previousController) {
                previousController.abort();
            }
            try {
                const provider = createAIProvider(buildCopilotConfig(settings, aiKey, language));
                const suggestion = await provider.predictMetadata(
                    { title: input, contexts: contextOptionsRef.current, tags: tagOptionsRef.current, ...(candidates.length ? { areas: candidates } : {}) },
                    abortController ? { signal: abortController.signal } : undefined
                );
                if (cancelled || !copilotMountedRef.current) return;
                const areaId = candidates.find((area) => area.id === suggestion.areaId)?.id;
                const kept = keepTaskCopilotSuggestion({ ...suggestion, areaId }, timeEstimatesEnabled);
                setCopilotSuggestion(kept ? { ...kept, language, text: input, areaRevision: destination?.revision } : null);
            } catch {
                if (!cancelled && copilotMountedRef.current) setCopilotSuggestion(null);
            }
        }, TASK_COPILOT_DELAY_MS);
        return () => {
            cancelled = true;
            clearTimeout(handle);
            if (copilotAbortRef.current && copilotAbortRef.current === localAbortController) {
                copilotAbortRef.current.abort();
                copilotAbortRef.current = null;
            }
        };
    }, [aiEnabled, aiKey, copilotText, getAreaDestination, keyRequired, language, settings, timeEstimatesEnabled, visible]);

    useEffect(() => {
        if (!visible) {
            setCopilotSuggestion(null);
            setCopilotContext(undefined);
            setCopilotEstimate(undefined);
            setCopilotTags([]);
            if (copilotAbortRef.current) {
                copilotAbortRef.current.abort();
                copilotAbortRef.current = null;
            }
        }
    }, [visible]);

    const resetCopilotDraft = useCallback(() => {
        setCopilotContext(undefined);
        setCopilotEstimate(undefined);
        setCopilotTags([]);
    }, []);

    const resetCopilotState = useCallback(() => {
        setCopilotSuggestion(null);
        setCopilotContext(undefined);
        setCopilotEstimate(undefined);
        setCopilotTags([]);
    }, []);


    const destination = getAreaDestination?.();
    const area = aiEnabled && visible && destination && visibleCopilotSuggestion?.text === copilotText && visibleCopilotSuggestion.areaRevision === destination.revision
        ? resolveSuggestedArea(visibleCopilotSuggestion.areaId, areas ?? [], destination)
        : undefined;
    const pendingCopilotParts = useMemo<CopilotPart[]>(() => getTaskCopilotParts(
        visibleCopilotSuggestion,
        { context: copilotContext, timeEstimate: copilotEstimate, tags: copilotTags },
        timeEstimatesEnabled,
        area,
    ), [area, copilotContext, copilotEstimate, copilotTags, timeEstimatesEnabled, visibleCopilotSuggestion]);


    const applyCopilotParts = useCallback((parts: CopilotPart[]) => {
        if (parts.length === 0) return;
        const areaPart = parts.find((part) => part.kind === 'area');
        const destination = areaPart && getAreaDestination?.();
        if (areaPart && destination && areaPart.value === area?.id && destination.revision === visibleCopilotSuggestion?.areaRevision
            && getTaskCopilotText(destination.title, destination.description) === visibleCopilotSuggestion?.text
            && resolveSuggestedArea(areaPart.value, useTaskStore.getState().areas, destination)) {
            setDraftField('areaId', areaPart.value);
            void logInfo('AI Area suggestion accepted', {
                scope: 'ai', extra: { releaseCheck: 'v1.3.10/ai-area-suggestion', surface: 'editor-copilot' },
            });
        }
        const applied = applyTaskCopilotParts({ contexts: draft?.contexts, tags: draft?.tags }, parts, timeEstimatesEnabled);
        if (applied.context) {
            setDraftField('contexts', applied.patch.contexts ?? '');
            setCopilotContext(applied.context);
        }
        if (applied.tags.length) {
            setDraftField('tags', applied.patch.tags ?? '');
            setCopilotTags((prev) => Array.from(new Set([...prev, ...applied.tags])));
        }
        if (applied.timeEstimate) {
            setDraftField('timeEstimate', applied.timeEstimate);
            setCopilotEstimate(applied.timeEstimate);
        }
    }, [area?.id, draft?.contexts, draft?.tags, getAreaDestination, setDraftField, timeEstimatesEnabled, visibleCopilotSuggestion]);

    const applyCopilotPart = useCallback((part: CopilotPart) => {
        applyCopilotParts([part]);
    }, [applyCopilotParts]);

    const applyCopilotSuggestion = useCallback(() => {
        applyCopilotParts(pendingCopilotParts);
    }, [applyCopilotParts, pendingCopilotParts]);

    return {
        aiKey,
        pendingCopilotParts,
        copilotContext,
        copilotEstimate,
        copilotTags,
        showAllContexts,
        setShowAllContexts,
        showAllTags,
        setShowAllTags,
        resetCopilotDraft,
        resetCopilotState,
        applyCopilotPart,
        applyCopilotSuggestion,
    };
}
