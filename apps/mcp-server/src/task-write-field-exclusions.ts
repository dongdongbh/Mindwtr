


import type { Task } from '@mindwtr/core';

export const TASK_WRITE_FIELD_EXCLUSIONS: Readonly<Partial<Record<keyof Task, string>>> = {
    orderNum: 'Legacy alias of `order` (same SQLite column) — this surface exposes only '
        + '`order` to avoid two keys writing one value.',
};
