import { createCustomTimeEstimate, TIME_ESTIMATE_OPTIONS } from './calendar-scheduling';
import {
    applyCaptureModalCopilotParts, formatCaptureModalCopilotApplied, getCaptureModalCopilotParts,
    getCaptureModalCopilotTokens, keepCaptureModalCopilotSuggestion, shouldRequestCaptureModalCopilot,
    type CaptureModalCopilotApplied, type CaptureModalCopilotPart, type CaptureModalCopilotSuggestion,
} from './capture-modal-model';
import { tFallback, type TranslateFn } from './i18n';
import { detach, exact, record } from './native-host-contract-project-shared';
import { planQuickCaptureSave, type QuickCaptureOptions } from './quick-capture-model';
import { resolveFeatureFlags } from './resolve-feature-flags';
import type { AppSettings, Task, TimeEstimate } from './types';
import { deterministicHash128 } from './uuid';

export type NativeCaptureCopilotApplied = CaptureModalCopilotApplied;
export type NativeCaptureCopilotSuggestion = CaptureModalCopilotSuggestion & { language: string };
export type NativeCaptureCopilotApplyEdit = { type: 'apply'; parts: CaptureModalCopilotPart[] };
export type NativeCaptureCopilotOptionsInput = { text: string; options: QuickCaptureOptions;
    applied: NativeCaptureCopilotApplied; aiKey: { required: boolean; available: boolean } };
export type NativeCaptureCopilotEditInput = { text: string; options: QuickCaptureOptions; revision: string;
    suggestion: NativeCaptureCopilotSuggestion | null; applied: NativeCaptureCopilotApplied;
    edit: NativeCaptureCopilotApplyEdit | null };

export const isNativeCaptureCopilotEstimate = (value: unknown): value is TimeEstimate => {
    if (typeof value !== 'string' || value.length > 50) return false;
    if (TIME_ESTIMATE_OPTIONS.some((estimate) => estimate === value)) return true;
    const minutes = value.startsWith('custom:') ? Number(value.slice(7)) : NaN;
    return Number.isSafeInteger(minutes) && minutes > 0 && createCustomTimeEstimate(minutes) === value;
};
const token = (value: unknown): value is string => typeof value === 'string' && value.length > 0
    && value.length <= 200 && value.trim() === value && Array.from(value).every((character) => character.charCodeAt(0) >= 32);
const tags = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 50
    && value.every(token) && new Set(value).size === value.length;

export const readNativeCaptureCopilotApplied = (value: unknown): NativeCaptureCopilotApplied | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['tags', ...(input.context === undefined ? [] : ['context']),
        ...(input.timeEstimate === undefined ? [] : ['timeEstimate'])]) || !tags(input.tags)
        || input.context !== undefined && !token(input.context)
        || input.timeEstimate !== undefined && !isNativeCaptureCopilotEstimate(input.timeEstimate)) return null;
    return { tags: input.tags, ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.timeEstimate === undefined ? {} : { timeEstimate: input.timeEstimate }) };
};

export const readNativeCaptureCopilotSuggestion = (value: unknown): NativeCaptureCopilotSuggestion | null | undefined => {
    if (value === null) return null;
    const input = detach<Record<string, unknown>>(value);
    if (!input || typeof input.language !== 'string' || !input.language || input.language.length > 100
        || !exact(input, ['language', ...(input.context === undefined ? [] : ['context']),
            ...(input.timeEstimate === undefined ? [] : ['timeEstimate']), ...(input.tags === undefined ? [] : ['tags'])])
        || input.context !== undefined && !token(input.context)
        || input.timeEstimate !== undefined && !isNativeCaptureCopilotEstimate(input.timeEstimate)
        || input.tags !== undefined && !tags(input.tags)) return undefined;
    return { language: input.language, ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.timeEstimate === undefined ? {} : { timeEstimate: input.timeEstimate }) };
};

export const readNativeCaptureCopilotEdit = (value: unknown): NativeCaptureCopilotApplyEdit | null | undefined => {
    if (value === null) return null;
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['type', 'parts']) || input.type !== 'apply' || !Array.isArray(input.parts)
        || !input.parts.length || input.parts.length > 52) return undefined;
    const parts: CaptureModalCopilotPart[] = [];
    for (const part of input.parts) {
        if (!record(part) || !exact(part, ['kind', 'value']) || !token(part.value)
            || (part.kind !== 'context' && part.kind !== 'timeEstimate' && part.kind !== 'tag')
            || part.kind === 'timeEstimate' && !isNativeCaptureCopilotEstimate(part.value)
            || parts.some((entry) => entry.kind === part.kind && entry.value === part.value)) return undefined;
        parts.push({ kind: part.kind, value: part.value });
    }
    return { type: 'apply', parts };
};

export const nativeCaptureCopilotRevision = (base: string, text: string, options: QuickCaptureOptions): string =>
    `${base}:${deterministicHash128(JSON.stringify([text, options]))}`;

export function buildNativeCaptureCopilotOptions(input: NativeCaptureCopilotOptionsInput, context: {
    settings: AppSettings; tasks: Task[]; t: TranslateFn; revision: string; title: string | null;
}) {
    const single = planQuickCaptureSave(input.text).kind === 'single';
    const title = context.title?.trim() ?? '';
    const canRequest = single && shouldRequestCaptureModalCopilot({ aiEnabled: context.settings.ai?.enabled === true,
        keyRequired: input.aiKey.required, hasKey: input.aiKey.available, title });
    const choices = canRequest ? getCaptureModalCopilotTokens(context.settings, context.tasks) : { contexts: [], tags: [] };
    return {
        revision: nativeCaptureCopilotRevision(context.revision, input.text, input.options),
        request: canRequest
            ? { title, contexts: choices.contexts.filter(token).slice(0, 1000), tags: choices.tags.filter(token).slice(0, 1000) } : null,
        labels: { suggest: tFallback(context.t, 'copilot.suggest', 'Suggest'), working: context.t('ai.working'), applyAll: context.t('copilot.applyAll'),
            applied: context.t('copilot.applied'), hint: context.t('copilot.applyHint'),
            errorTitle: context.t('ai.errorTitle'), errorBody: context.t('ai.errorBody') },
        applied: single ? input.applied : { tags: [] },
    };
}

export function buildNativeCaptureCopilotEdit(input: NativeCaptureCopilotEditInput, settings: AppSettings, t: TranslateFn) {
    if (planQuickCaptureSave(input.text).kind !== 'single') return {
        suggestion: null, applied: { tags: [] }, chips: [], applyAll: null, appliedLabel: null,
    };
    const estimates = resolveFeatureFlags(settings).timeEstimates;
    const suggestion = settings.ai?.enabled === true && input.suggestion
        ? keepCaptureModalCopilotSuggestion(input.suggestion, estimates) : null;
    const offered = getCaptureModalCopilotParts(suggestion, input.applied, estimates);
    if (input.edit && !input.edit.parts.every((part) => offered.some((entry) => entry.kind === part.kind && entry.value === part.value))) return null;
    const applied = input.edit ? applyCaptureModalCopilotParts(input.applied, input.edit.parts, estimates) : input.applied;
    const pending = getCaptureModalCopilotParts(suggestion, applied, estimates);
    const choice = (parts: CaptureModalCopilotPart[]): { label: string; edit: NativeCaptureCopilotApplyEdit } =>
        ({ label: parts.length === 1 ? parts[0].value : t('copilot.applyAll'), edit: { type: 'apply', parts } });
    return { suggestion, applied, chips: pending.map((part) => choice([part])),
        applyAll: pending.length > 1 ? choice(pending) : null,
        appliedLabel: formatCaptureModalCopilotApplied(t, applied, estimates) };
}
