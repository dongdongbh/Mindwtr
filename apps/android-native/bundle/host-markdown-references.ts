import {
    getActiveMarkdownReferenceQuery,
    isMarkdownEditorAssistEnabled,
    searchMarkdownReferences,
    serializeMarkdownReference,
} from '../../../packages/core/src/markdown';
import type { Project, Task } from '../../../packages/core/src/types';


type Strings = (keys: string[]) => Record<string, string>;
type Store = { _allTasks: Task[]; projects: Project[]; settings?: { markdownEditorAssist?: boolean } | null };
type Input = { value: string; start: number; end: number; taskId?: string | null };
type Reply = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

const SUGGESTION_LIMIT = 6;

export const readMarkdownReferences = (input: Input, state: Store, strings: Strings): Reply => {
    const index = (value: unknown, max: number): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
    if (!input || typeof input.value !== 'string' || input.value.length > 1_000_000 || !index(input.start, input.value.length)
        || !index(input.end, input.value.length) || input.start > input.end || (input.taskId != null && typeof input.taskId !== 'string')) {
        return { ok: false, error: { code: 'INVALID_INPUT', message: 'The text, a selection inside it and an optional task id are required' } };
    }
    const query = getActiveMarkdownReferenceQuery(input.value, { start: input.start, end: input.end },
        { assist: isMarkdownEditorAssistEnabled(state.settings) });
    if (!query) return { ok: true, value: { start: input.start, end: input.end, suggestions: [] } };
    const found = searchMarkdownReferences(state._allTasks, state.projects, query.query, SUGGESTION_LIMIT,
        { excludeTaskIds: input.taskId ? [input.taskId] : undefined });
    const labels = strings(['taskEdit.tab.task', 'taskEdit.projectLabel', ...found.map((item) => `status.${item.status}`)]);
    const typeLabel = { task: labels['taskEdit.tab.task'] ?? 'Task', project: labels['taskEdit.projectLabel'] ?? 'Project' };
    return { ok: true, value: {
        start: query.start,
        end: query.end,
        suggestions: found.map((item) => ({
            id: `${item.entityType}:${item.id}`,
            title: item.title,
            meta: `${typeLabel[item.entityType]} • ${labels[`status.${item.status}`] ?? item.status}`,
            token: serializeMarkdownReference({ entityType: item.entityType, id: item.id, label: item.title }),
        })),
    } };
};
