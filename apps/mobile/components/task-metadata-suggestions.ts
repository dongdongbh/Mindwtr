import type { Task } from '@mindwtr/core';

const getTaskTimestamp = (task: Task): number => {
  const value = Date.parse(task.updatedAt || task.createdAt || '');
  return Number.isFinite(value) ? value : 0;
};

export const getAssignedToSuggestions = (
  tasks: Task[],
  value: string | undefined,
  limit: number,
): string[] => {
  const query = String(value ?? '').trim().toLowerCase();
  if (!query) return [];

  const usageByName = new Map<string, { name: string; count: number; lastUsedAt: number }>();
  for (const task of tasks) {
    if (task.deletedAt) continue;
    const name = task.assignedTo?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const current = usageByName.get(key);
    if (current) {
      current.count += 1;
      current.lastUsedAt = Math.max(current.lastUsedAt, getTaskTimestamp(task));
    } else {
      usageByName.set(key, {
        name,
        count: 1,
        lastUsedAt: getTaskTimestamp(task),
      });
    }
  }

  return Array.from(usageByName.values())
    .filter((entry) => entry.name.toLowerCase().includes(query))
    .filter((entry) => entry.name.toLowerCase() !== query)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name);
};
