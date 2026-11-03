import { useEffect, useRef } from 'react';
import { normalizeClockTimeInput, type Area, type Person, type Project, type Section, type TimeEstimate } from '@mindwtr/core';
import { joinDateTime, splitDateTime } from '@mindwtr/core/date-draft';


export function useProcessingTitleFocus(taskId?: string, step?: string) {
    const ref = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        const input = ref.current;
        if (!input) return;
        input.focus();
        const caret = input.value.length;
        input.setSelectionRange(caret, caret);
    }, [taskId, step]);
    return ref;
}


export const resolveDelegateEmail = (people: readonly Person[], who: string): string => {
    const name = who.trim().toLowerCase();
    if (!name) return '';
    const person = people.find((candidate) => !candidate.deletedAt && candidate.name.trim().toLowerCase() === name);
    const referenceLink = person?.referenceLink?.trim() ?? '';
    if (!referenceLink.toLowerCase().startsWith('mailto:')) return '';
    return referenceLink.slice('mailto:'.length).split('?')[0] ?? '';
};

export const parseTokenListInput = (value: string, prefix: '@' | '#'): string[] => Array.from(
    new Set(
        value
            .split(/[,\n]+/)
            .map((part) => part.trim())
            .map((part) => part.replace(/^[@#]+/, '').trim())
            .filter(Boolean)
            .map((part) => `${prefix}${part}`)
    )
);

export const formatTokenListInput = (tokens: string[]): string => tokens.join(', ');


export const parseContextsInput = (value: string): string[] => parseTokenListInput(value, '@');
export const parseTagsInput = (value: string): string[] => parseTokenListInput(value, '#');

export const mergeSuggestedTokens = (...groups: string[][]): string[] =>
    Array.from(new Set(groups.flat()));

export const normalizeTimeInput = normalizeClockTimeInput;

export const getDateFieldDraft = (value?: string): { date: string; time: string; timeDraft: string } => {
    const { date, time } = splitDateTime(value);
    return { date, time, timeDraft: time };
};

export const resolveCommittedTime = (
    draft: string,
    committed: string,
): { time: string; timeDraft: string } => {
    const normalized = normalizeTimeInput(draft);
    if (normalized === null) {
        return {
            time: committed,
            timeDraft: committed,
        };
    }

    return {
        time: normalized,
        timeDraft: normalized,
    };
};

export const buildDateTimeUpdate = (
    date: string,
    timeDraft: string,
    committedTime: string,
): string | undefined => {
    if (!date) return undefined;
    const normalized = normalizeTimeInput(timeDraft);
    const resolvedTime = normalized === null ? committedTime : normalized;
    return joinDateTime(date, resolvedTime);
};


export type InboxProcessingVisibility = {
    showProjectField: boolean;
    showAreaField: boolean;
    showContextsField: boolean;
    showTagsField: boolean;
    showPriorityField: boolean;
    showEnergyLevelField: boolean;
    showAssignedToField: boolean;
    showTimeEstimateField: boolean;
    showScheduleFields: boolean;
    showReferenceOption: boolean;
};


export type InboxProcessingOptionLists = {
    projects: Project[];

    sections: Section[];
    areas: Area[];
    allContexts: string[];
    allTags: string[];
    suggestedContexts: string[];
    suggestedTags: string[];
    personOptions: string[];
    timeEstimateOptions: TimeEstimate[];
};
