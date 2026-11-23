import { resolveSuggestedArea } from './areas';
import type { AIAreaCandidate, BreakdownResponse, ClarifyResponse, ClarifySuggestion, CopilotResponse, ReviewAction, ReviewAnalysisResponse } from './types';
import { normalizeTags, normalizeTimeEstimate, parseJson } from './utils';

const REVIEW_ACTIONS: ReviewAction[] = ['someday', 'archive', 'breakdown', 'keep'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

type RawClarifyResponse = Omit<ClarifyResponse, 'suggestedAction'> & {
    suggestedAction?: (Omit<ClarifySuggestion, 'areaId'> & { areaId?: unknown }) | null;
};

const isClarifyResponse = (value: unknown): value is RawClarifyResponse => {
    if (!isRecord(value)) return false;
    if (typeof value.question !== 'string') return false;
    if (!Array.isArray(value.options)) return false;
    if (value.options.some((option) => !isRecord(option) || typeof option.label !== 'string' || typeof option.action !== 'string')) {
        return false;
    }

    if (value.suggestedAction != null) {
        if (!isRecord(value.suggestedAction)) return false;
        if (value.suggestedAction.title != null && typeof value.suggestedAction.title !== 'string') return false;
        if (value.suggestedAction.context != null && typeof value.suggestedAction.context !== 'string') return false;
        if (value.suggestedAction.timeEstimate != null && typeof value.suggestedAction.timeEstimate !== 'string') return false;
        if (value.suggestedAction.isProject != null && typeof value.suggestedAction.isProject !== 'boolean') return false;
    }
    return true;
};

export const isBreakdownResponse = (value: unknown): value is BreakdownResponse => {
    if (!isRecord(value)) return false;
    return isStringArray(value.steps);
};

export const isReviewAnalysisResponse = (value: unknown): value is ReviewAnalysisResponse => {
    if (!isRecord(value)) return false;
    if (!Array.isArray(value.suggestions)) return false;
    return value.suggestions.every((suggestion) => {
        if (!isRecord(suggestion)) return false;
        if (typeof suggestion.id !== 'string') return false;
        if (typeof suggestion.action !== 'string') return false;
        if (!REVIEW_ACTIONS.includes(suggestion.action as ReviewAction)) return false;
        if (typeof suggestion.reason !== 'string') return false;
        return true;
    });
};

type RawCopilotResponse = {
    context?: string | null;
    timeEstimate?: string | null;
    tags?: string[] | null;
    areaId?: unknown;
};

const isCopilotResponse = (value: unknown): value is RawCopilotResponse => {
    if (!isRecord(value)) return false;

    if (value.context != null && typeof value.context !== 'string') return false;
    if (value.timeEstimate != null && typeof value.timeEstimate !== 'string') return false;
    if (value.tags != null && !isStringArray(value.tags)) return false;
    return true;
};

export function parseClarifyResponse(text: string, areas: readonly AIAreaCandidate[]): ClarifyResponse {
    const { suggestedAction, ...response } = parseJson(text, isClarifyResponse);
    if (!suggestedAction) return { ...response, ...(suggestedAction === null ? { suggestedAction } : {}) };

    const { areaId, ...suggestion } = suggestedAction;
    const area = suggestion.isProject ? undefined : resolveSuggestedArea(areaId, areas);
    return { ...response, suggestedAction: { ...suggestion, ...(area ? { areaId: area.id } : {}) } };
}

export function parseCopilotResponse(text: string, areas: readonly AIAreaCandidate[]): CopilotResponse {
    const parsed = parseJson(text, isCopilotResponse);
    const area = resolveSuggestedArea(parsed.areaId, areas);
    return {
        context: parsed.context ?? undefined,
        timeEstimate: normalizeTimeEstimate(parsed.timeEstimate ?? undefined),
        tags: normalizeTags(parsed.tags),
        ...(area ? { areaId: area.id } : {}),
    };
}
