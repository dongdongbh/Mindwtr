import { extractChecklistFromMarkdown, generateUUID } from '@mindwtr/core';
import type { Task } from '@mindwtr/core';

export const parseTokenList = (value: string | undefined, tokenPrefix: '@' | '#'): string[] => {
    if (!value) return [];
    const tokens = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
            if (item.startsWith(tokenPrefix)) return item;
            const stripped = item.replace(/^[@#]+/, '').trim();
            if (!stripped) return '';
            return `${tokenPrefix}${stripped}`;
        })
        .filter(Boolean);

    return Array.from(new Set(tokens));
};

export const getActiveTokenQuery = (value: string | undefined, _tokenPrefix: '@' | '#'): string => {
    if (!value) return '';
    const draft = value.split(',').pop()?.trim() ?? '';
    const stripped = draft.replace(/^[@#]+/, '').trim();
    if (!stripped) return '';
    return stripped.toLowerCase();
};

export const replaceTrailingToken = (value: string | undefined, token: string): string => {
    const source = value ?? '';
    const lastCommaIndex = source.lastIndexOf(',');
    if (lastCommaIndex === -1) {
        return `${token}, `;
    }
    const head = source.slice(0, lastCommaIndex + 1).trimEnd();
    return `${head} ${token}, `;
};

const normalizeChecklistKey = (value: string): string => value.trim().toLowerCase();

export const applyMarkdownChecklistToTask = (
    description: string | undefined,
    checklist: Task['checklist'],
): Task['checklist'] => {
    const markdownItems = extractChecklistFromMarkdown(String(description ?? ''));
    if (markdownItems.length === 0) return checklist;

    const current = checklist || [];
    const remainingByTitle = new Map<string, { id: string; title: string; isCompleted: boolean }[]>();
    for (const item of current) {
        if (!item?.title) continue;
        const key = normalizeChecklistKey(item.title);
        const bucket = remainingByTitle.get(key);
        if (bucket) {
            bucket.push(item);
        } else {
            remainingByTitle.set(key, [item]);
        }
    }

    const usedIds = new Set<string>();
    const merged: NonNullable<Task['checklist']> = [];
    for (const item of markdownItems) {
        const key = normalizeChecklistKey(item.title);
        const bucket = remainingByTitle.get(key) || [];
        const reusable = bucket.find((entry) => !usedIds.has(entry.id));
        if (reusable) {
            usedIds.add(reusable.id);
        }
        merged.push({
            id: reusable?.id ?? generateUUID(),
            title: item.title,
            isCompleted: item.isCompleted,
        });
    }

    for (const item of current) {
        if (!item?.id || usedIds.has(item.id)) continue;
        merged.push(item);
    }

    return merged;
};
