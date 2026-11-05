import { strToU8, zipSync } from 'fflate';

import { timeEstimateToMinutes } from './calendar-scheduling';
import { DEFAULT_TASKNOTES_FOLDER } from './tasknotes-parser';
import type { AppData, Task, TaskPriority } from './types';


const TASKNOTES_STATUS_BY_MINDWTR_STATUS: Partial<Record<Task['status'], string>> = {
    inbox: 'none',
    next: 'in-progress',
    waiting: 'waiting',
    someday: 'someday',
    done: 'done',
    archived: 'cancelled',
};

const TASKNOTES_PRIORITY_BY_MINDWTR_PRIORITY: Record<TaskPriority, string> = {
    low: 'low',
    medium: 'normal',
    high: 'high',
    urgent: 'urgent',
};

const isLive = (entity: { deletedAt?: string; purgedAt?: string }): boolean => (
    !entity.deletedAt && !entity.purgedAt
);


const yamlScalar = (value: string): string => {
    const needsQuotes = value === ''
        || value !== value.trim()
        || /^(true|false)$/i.test(value)
        || /^-?\d+(?:\.\d+)?$/.test(value)
        || /^["'[]/.test(value)
        || value.includes('\n');
    if (!needsQuotes) return value;
    return `"${value.replace(/\r?\n/g, ' ')}"`;
};

const yamlLines = (key: string, value: string | number | string[] | undefined | null): string[] => {
    if (value === undefined || value === null) return [];
    if (typeof value === 'number') return [`${key}: ${value}`];
    if (Array.isArray(value)) {
        if (value.length === 0) return [];
        return [`${key}:`, ...value.map((item) => `  - ${yamlScalar(item)}`)];
    }
    if (!value.trim()) return [];
    return [`${key}: ${yamlScalar(value)}`];
};

const stripToken = (value: string, prefix: string): string => (
    value.startsWith(prefix) ? value.slice(prefix.length) : value
);

const slugifyTitle = (title: string): string => {
    const slug = title
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/g, '');
    return slug || 'task';
};

export type TaskNotesExportFile = {

    path: string;
    content: string;
};

export type TaskNotesExportResult = {
    files: TaskNotesExportFile[];

    skippedReferenceCount: number;
};

export function serializeTaskNotesExport(data: AppData): TaskNotesExportResult {
    const projectTitleById = new Map(
        (data.projects ?? []).filter(isLive).map((project) => [project.id, project.title]),
    );
    const files: TaskNotesExportFile[] = [];
    let skippedReferenceCount = 0;

    for (const task of (data.tasks ?? []).filter(isLive)) {
        const status = TASKNOTES_STATUS_BY_MINDWTR_STATUS[task.status];
        if (!status) {
            if (task.status === 'reference') skippedReferenceCount += 1;
            continue;
        }

        const projectTitle = task.projectId ? projectTitleById.get(task.projectId) : undefined;
        const contexts = (task.contexts ?? [])
            .map((context) => stripToken(context.trim(), '@'))
            .filter(Boolean);
        const tags = (task.tags ?? [])
            .map((tag) => stripToken(tag.trim(), '#'))
            .filter(Boolean);
        const priority = task.priority ? TASKNOTES_PRIORITY_BY_MINDWTR_PRIORITY[task.priority] : undefined;

        const frontmatter = [
            ...yamlLines('title', task.title),
            ...yamlLines('status', status),
            ...yamlLines('priority', priority),
            ...yamlLines('due', task.dueDate),
            ...yamlLines('scheduled', task.startTime),
            ...yamlLines('contexts', contexts),
            ...yamlLines('projects', projectTitle ? [`[[${projectTitle}]]`] : undefined),


            ...yamlLines('tags', ['task', ...tags]),
            ...yamlLines('timeEstimate', task.timeEstimate ? timeEstimateToMinutes(task.timeEstimate) : undefined),
            ...yamlLines('recurrence', typeof task.recurrence === 'object' && task.recurrence ? task.recurrence.rrule : undefined),
            ...yamlLines('completedDate', task.completedAt),
        ];

        const body = (task.description ?? '').trim();
        const content = `---\n${frontmatter.join('\n')}\n---\n${body ? `\n${body}\n` : ''}`;
        files.push({
            path: `${DEFAULT_TASKNOTES_FOLDER}/${slugifyTitle(task.title)}-${task.id.slice(0, 8)}.md`,
            content,
        });
    }

    return { files, skippedReferenceCount };
}


export function buildTaskNotesExportZip(data: AppData): { zip: Uint8Array; fileCount: number; skippedReferenceCount: number } {
    const { files, skippedReferenceCount } = serializeTaskNotesExport(data);
    const entries: Record<string, Uint8Array> = {};
    for (const file of files) {
        entries[file.path] = strToU8(file.content);
    }
    return { zip: zipSync(entries), fileCount: files.length, skippedReferenceCount };
}
