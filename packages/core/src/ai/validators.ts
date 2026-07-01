import type { BreakdownResponse, ClarifyResponse, CopilotResponse, ReviewAction, ReviewAnalysisResponse } from './types';

const REVIEW_ACTIONS: ReviewAction[] = ['someday', 'archive', 'breakdown', 'keep'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

export const isClarifyResponse = (value: unknown): value is ClarifyResponse => {
    if (!isRecord(value)) return false;
    if (typeof value.question !== 'string') return false;
    if (!Array.isArray(value.options)) return false;
    if (value.options.some((option) => !isRecord(option) || typeof option.label !== 'string' || typeof option.action !== 'string')) {
        return false;
    }
    // Treat null like absent: Structured Outputs returns null for omitted optional fields.
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

export const isCopilotResponse = (value: unknown): value is CopilotResponse => {
    if (!isRecord(value)) return false;
    // Treat null like absent: Structured Outputs returns null for omitted optional fields.
    if (value.context != null && typeof value.context !== 'string') return false;
    if (value.timeEstimate != null && typeof value.timeEstimate !== 'string') return false;
    if (value.tags != null && !isStringArray(value.tags)) return false;
    return true;
};
