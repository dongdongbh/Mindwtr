import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createAIProvider, type AIProviderId, type AppData, type Language, type TimeEstimate } from '@mindwtr/core';
import {
    applyTaskCopilotParts,
    getTaskCopilotParts,
    getTaskCopilotText,
    keepTaskCopilotSuggestion,
    TASK_COPILOT_DELAY_MS,
    type TaskCopilotPart,
} from '@mindwtr/core/ai-task-actions';
import type { TaskDraft, TaskDraftSetter } from '@mindwtr/core/task-draft';
import { buildCopilotConfig, isAIKeyRequired, loadAIKey } from '../../lib/ai-config';
import { logError } from '../../lib/app-log';

type CopilotSuggestion = {
    language: Language;
    context?: string;
    timeEstimate?: TimeEstimate;
    tags?: string[];
};


export type CopilotPart = TaskCopilotPart;

type UseTaskEditCopilotArgs = {
    settings: AppData['settings'];
    language?: Language;
    aiEnabled: boolean;
    aiProvider: AIProviderId;
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
        if (!aiEnabled || (keyRequired && !aiKey)) {
            setCopilotSuggestion(null);
            return;
        }
        const input = getTaskCopilotText(titleDraft, descriptionDraft);
        if (!input) {
            setCopilotSuggestion(null);
            return;
        }
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
                    { title: input, contexts: contextOptionsRef.current, tags: tagOptionsRef.current },
                    abortController ? { signal: abortController.signal } : undefined
                );
                if (cancelled || !copilotMountedRef.current) return;
                const kept = keepTaskCopilotSuggestion(suggestion, timeEstimatesEnabled);
                setCopilotSuggestion(kept ? { ...kept, language } : null);
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
    }, [aiEnabled, aiKey, descriptionDraft, keyRequired, language, settings, timeEstimatesEnabled, titleDraft]);

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


    const pendingCopilotParts = useMemo<CopilotPart[]>(() => getTaskCopilotParts(
        visibleCopilotSuggestion,
        { context: copilotContext, timeEstimate: copilotEstimate, tags: copilotTags },
        timeEstimatesEnabled,
    ), [copilotContext, copilotEstimate, copilotTags, timeEstimatesEnabled, visibleCopilotSuggestion]);


    const applyCopilotParts = useCallback((parts: CopilotPart[]) => {
        if (parts.length === 0) return;
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
    }, [draft?.contexts, draft?.tags, setDraftField, timeEstimatesEnabled]);

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
