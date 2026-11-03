
export { buildProjectTaskReorderGroups, flattenProjectReorderGroups, resolveProjectReorderDropPlan, sortProjectTasksByOrder } from '@mindwtr/core';
export type { ProjectTaskReorderListItem, ProjectTaskReorderGroup, ProjectReorderFlatItem, ProjectReorderDropPlan } from '@mindwtr/core';

export const getBulkActionFailureMessage = (error: unknown, fallback: string): string => {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const trimmed = message.trim();
    return trimmed || fallback;
};
