


import { hasTimeComponent, safeParseDate } from './date';
import { formatLocalDate } from './import-source-reader';
import type { AppData, Task } from './types';

export type SpeechResultLike = {
    transcript?: string | null;
    title?: string | null;
    description?: string | null;
    dueDate?: string | null;
    startTime?: string | null;
    tags?: string[] | null;
    contexts?: string[] | null;
    projectTitle?: string | null;
};

export type SpeechUpdatePlan = {
    updates: Partial<Task>;
    suggestedProjectTitle?: string;
};

const normalizeSpeechTranscriptForTask = (transcript: string | null | undefined): string | undefined => {
    const trimmed = transcript?.trim();
    if (!trimmed) return undefined;

    const parseStructuredTranscript = (candidate: string): string | undefined | null => {
        try {
            const parsed = JSON.parse(candidate) as unknown;
            if (!parsed || typeof parsed !== 'object') return null;
            const text = (parsed as { text?: unknown; transcript?: unknown }).text
                ?? (parsed as { transcript?: unknown }).transcript;
            if (typeof text !== 'string') return null;
            const normalized = text.trim();
            return normalized || undefined;
        } catch {
            return null;
        }
    };

    const direct = parseStructuredTranscript(trimmed);
    if (direct !== null) return direct;

    const objectStart = trimmed.indexOf('{');
    const objectEnd = trimmed.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
        const embedded = parseStructuredTranscript(trimmed.slice(objectStart, objectEnd + 1));
        if (embedded !== null) return embedded;
    }

    if (/^(?:\[\s*[^\]]+?\s*\]\s*)+$/.test(trimmed)) {
        return undefined;
    }

    return trimmed;
};

export function buildTaskUpdatesFromSpeechResult(
    existing: Pick<Task, 'title' | 'description' | 'dueDate' | 'startTime' | 'tags' | 'contexts' | 'projectId'>,
    result: SpeechResultLike,
    settings?: AppData['settings'],
): SpeechUpdatePlan {
    const updates: Partial<Task> = {};
    const mode = settings?.ai?.speechToText?.mode ?? 'smart_parse';
    const fieldStrategy = settings?.ai?.speechToText?.fieldStrategy ?? 'smart';
    const transcript = normalizeSpeechTranscriptForTask(result.transcript);

    if (mode === 'transcribe_only') {
        if (transcript) {
            if (fieldStrategy === 'description_only') {
                updates.description = transcript;
            } else if (fieldStrategy === 'title_only') {
                updates.title = transcript;
            } else {
                const wordCount = transcript.split(/\s+/).filter(Boolean).length;
                if (wordCount <= 15) {
                    updates.title = transcript;
                } else {
                    updates.description = transcript;
                }
            }
        }
    } else {
        if (result.title && result.title.trim()) updates.title = result.title.trim();
        if (result.description !== undefined && result.description !== null) {
            const description = result.description.trim();
            updates.description = description ? description : undefined;
        }
        if (!updates.title && transcript) {
            if (fieldStrategy === 'description_only') {
                updates.description = transcript;
            } else if (fieldStrategy === 'title_only') {
                updates.title = transcript;
            } else {
                const wordCount = transcript.split(/\s+/).filter(Boolean).length;
                if (wordCount <= 15) {
                    updates.title = transcript;
                } else {
                    const words = transcript.split(/\s+/).filter(Boolean);
                    updates.title = `${words.slice(0, 7).join(' ')}...`;
                    if (!updates.description) {
                        updates.description = transcript;
                    }
                }
            }
        }
    }


    if (result.dueDate) {
        const parsed = safeParseDate(result.dueDate);
        if (parsed) updates.dueDate = hasTimeComponent(result.dueDate) ? parsed.toISOString() : formatLocalDate(parsed);
    }
    if (result.startTime) {
        const parsed = safeParseDate(result.startTime);
        if (parsed) updates.startTime = hasTimeComponent(result.startTime) ? parsed.toISOString() : formatLocalDate(parsed);
    }

    const normalizeList = (items: string[] | null | undefined, prefix: string) => {
        if (!Array.isArray(items)) return [];
        return items
            .map((item) => item.trim())
            .filter(Boolean)
            .map((item) => (item.startsWith(prefix) ? item : `${prefix}${item}`));
    };

    const nextTags = normalizeList(result.tags ?? [], '#');
    const nextContexts = normalizeList(result.contexts ?? [], '@');
    if (nextTags.length) {
        updates.tags = Array.from(new Set([...(existing.tags ?? []), ...nextTags]));
    }
    if (nextContexts.length) {
        updates.contexts = Array.from(new Set([...(existing.contexts ?? []), ...nextContexts]));
    }

    const suggestedProjectTitle = result.projectTitle && !existing.projectId
        ? result.projectTitle.trim()
        : '';

    return {
        updates,
        suggestedProjectTitle: suggestedProjectTitle || undefined,
    };
}
