import { sortViewSectionDefinitions, type AppSettings, type ViewSectionDefinition, type ViewSectionScope } from '@mindwtr/core';
import * as z from 'zod';

import { ValidationError } from './errors.js';

export const listViewSectionsSchema = z.object({ view: z.enum(['someday', 'waiting', 'focus']).optional() }).strict();
export type ListViewSectionsInput = z.infer<typeof listViewSectionsSchema>;
export type ViewSectionEntry = Pick<ViewSectionDefinition, 'id' | 'title'> & { view: ViewSectionScope; order?: number };

export const viewSectionIdsSchema = z.record(z.string().refine((value) => value.trim().length > 0))
  .describe('Full per-view section assignment map. Resolve IDs with mindwtr_list_view_sections. Replaces the entire map; {} clears all assignments.');

export const normalizeViewSectionIds = (value: unknown, allowNull = false): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (allowNull && value === null) return {};
  const parsed = viewSectionIdsSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError('viewSectionIds must be an object mapping view names to nonempty section IDs.');
  return parsed.data;
};

export const listViewSectionsFromSettings = (settings: AppSettings, input: ListViewSectionsInput = {}): ViewSectionEntry[] => {
  const parsed = listViewSectionsSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError('Invalid view section catalogue input.');
  const views: ViewSectionScope[] = parsed.data.view ? [parsed.data.view] : ['someday', 'waiting', 'focus'];
  return views.flatMap((view) => {
    const definitions = settings?.gtd?.viewSections?.[view];
    if (!Array.isArray(definitions)) return [];
    return sortViewSectionDefinitions(definitions.filter((definition) => (
      definition && typeof definition === 'object' && (!('deletedAt' in definition) || !definition.deletedAt)
    ))).map(({ id, title, order }) => ({ view, id, title, ...(Number.isFinite(order) ? { order } : {}) }));
  });
};

export const logViewSectionWrite = (
  logger: ((message: string, context?: Record<string, unknown>) => void) | undefined,
  entityType: 'task' | 'project',
  operation: 'create' | 'update',
  value: unknown,
): void => {
  if (value === undefined) return;
  try {
    logger?.('MCP view section assignment committed', { extra: { releaseCheck: 'v1.3.8/mcp-view-sections', entityType, operation } });
  } catch { /* logging cannot change a completed write */ }
};
