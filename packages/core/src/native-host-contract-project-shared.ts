import { isValidProjectColorOverride } from './color-constants';
import { isNativeJsonWithinBytes, record } from './native-json';
export { exact, record } from './native-json';
import { PROJECT_SYNC_FIELD_SCHEMA, projectToSqliteRow } from './project-sync-schema';
import type { Project } from './types';

export const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;

/** Reject non-JSON, cycles, hazardous keys, and envelopes above the native 2 MB UTF-8 bound. */
export const detach = <T>(value: unknown): T | null => {
    const valid = (item: unknown, depth: number): boolean => {
        if (depth > 24) return false;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        if (Array.isArray(item)) return item.length <= 100_000 && item.every((part) => valid(part, depth + 1));
        return record(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
            && Object.keys(item).length <= 128 && Object.entries(item).every(([key, part]) =>
                !['__proto__', 'constructor', 'prototype'].includes(key) && valid(part, depth + 1));
    };
    if (!isNativeJsonWithinBytes(value) || !valid(value, 0)) return null;
    return JSON.parse(JSON.stringify(value)) as T;
};

const projectKeys = new Set(PROJECT_SYNC_FIELD_SCHEMA.map((field) => field.name));
const optionalStrings = ['supportNotes', 'dueDate', 'startDate', 'reviewAt', 'cancelledAt',
    'areaId', 'areaTitle', 'revBy', 'deletedAt', 'purgedAt'] as const;
export const validProject = (value: unknown, projectId: string): value is Project => {
    if (!record(value) || Object.keys(value).some((key) => !projectKeys.has(key as keyof Project))
        || value.id !== projectId || typeof value.title !== 'string'
        || !['active', 'someday', 'waiting', 'archived'].includes(String(value.status))
        || !isValidProjectColorOverride(value.colorOverride) || typeof value.color !== 'string' || typeof value.order !== 'number' || !Number.isFinite(value.order)
        || !Array.isArray(value.tagIds) || !value.tagIds.every((tag) => typeof tag === 'string')
        || !iso(value.createdAt) || !iso(value.updatedAt)
        || (value.isFocused !== undefined && typeof value.isFocused !== 'boolean')
        || (value.isSequential !== undefined && typeof value.isSequential !== 'boolean')
        || (value.perSectionFlow !== undefined && typeof value.perSectionFlow !== 'boolean')
        || (value.sequentialScope !== undefined && !['project', 'section'].includes(String(value.sequentialScope)))
        || (value.taskSortBy !== undefined && typeof value.taskSortBy !== 'string')
        || (value.viewSectionIds !== undefined && !(record(value.viewSectionIds)
            && Object.values(value.viewSectionIds).every((sectionId) => typeof sectionId === 'string')))
        || (value.rev !== undefined && !(typeof value.rev === 'number'
            && Number.isSafeInteger(value.rev) && value.rev >= 0))
        || optionalStrings.some((key) => value[key] !== undefined && typeof value[key] !== 'string')
        || value.deletedAt !== undefined || value.purgedAt !== undefined
        || (value.attachments !== undefined && (!Array.isArray(value.attachments)
            || value.attachments.some((attachment) => !record(attachment)
                || typeof attachment.id !== 'string' || !attachment.id
                || !['file', 'link'].includes(String(attachment.kind))
                || typeof attachment.title !== 'string' || typeof attachment.uri !== 'string'
                || !iso(attachment.createdAt) || !iso(attachment.updatedAt))))) return false;
    try { projectToSqliteRow(value as unknown as Project); return true; }
    catch { return false; }
};
