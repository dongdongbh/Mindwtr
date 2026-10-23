import { nextRevision, normalizeTagId } from './store-helpers';
import { dedupeTagValuesLastWins, formatTagIdPreservingCase } from './store-projects/shared';
import type { AppSettings, Project, Task, TaxonomyCatalog } from './types';
import { normalizeTaxonomyToken, planTaxonomyCatalogChange } from './taxonomy-catalog';

export type TaxonomyKind = 'context' | 'tag';
export type TaxonomyAction = 'create' | 'rename' | 'delete';
export type TaxonomyScope = { tasks: Task[]; projects: Project[]; catalogue?: TaxonomyCatalog | null };
export type TaxonomyEffect = { tasks: Array<{ before: Task; after: Task }>;
    projects: Array<{ before: Project; after: Project }>;
    catalogue?: { before: TaxonomyCatalog | null; after: TaxonomyCatalog } };

const key = (kind: TaxonomyKind, value: string, catalogued = false) => catalogued
    ? normalizeTaxonomyToken(kind, value).toLowerCase() : kind === 'tag' ? normalizeTagId(value) : value.trim().toLowerCase();

/** The exact RN early-return policy; `to` retains the text supplied by its caller. */
export function taxonomyDestination(kind: TaxonomyKind, action: TaxonomyAction,
    name: string, to: string | null): string | null | undefined {
    const source = key(kind, name);
    if (!source) return undefined;
    if (action === 'create') return normalizeTaxonomyToken(kind, name) || undefined;
    if (action === 'delete') return null;
    if (to === null) return undefined;
    const destination = kind === 'tag' ? formatTagIdPreservingCase(to) : to.trim();
    if (!key(kind, to) || !destination) return undefined;
    if (kind === 'tag' ? source === key(kind, to) && formatTagIdPreservingCase(name) === destination
        : source === destination.toLowerCase() && name.trim() === destination) return undefined;
    return destination;
}

export function selectTaxonomyScope(kind: TaxonomyKind, name: string,
    tasks: readonly Task[], projects: readonly Project[], settings?: AppSettings, action?: TaxonomyAction): TaxonomyScope {
    const target = key(kind, name, settings !== undefined);
    const has = (values: readonly string[]) => values.some((value) => key(kind, value, settings !== undefined) === target);
    return { tasks: action === 'create' ? [] : tasks.filter((task) => has(kind === 'tag' ? task.tags ?? [] : task.contexts ?? [])),
        projects: action !== 'create' && kind === 'tag' ? projects.filter((project) => has(project.tagIds ?? [])) : [],
        ...(settings === undefined ? {} : { catalogue: settings.taxonomy ?? null }) };
}

/** Preserves RN's first-match rename, context first-wins and tag last-wins rules. */
export function planTaxonomyEffect(kind: TaxonomyKind, action: TaxonomyAction, name: string,
    to: string | null, scope: TaxonomyScope, deviceId: string, now: string): TaxonomyEffect | null {
    const destination = taxonomyDestination(kind, action, name, to);
    if (destination === undefined) return null;
    const catalogue = scope.catalogue === undefined ? undefined : { before: scope.catalogue,
        after: planTaxonomyCatalogChange(scope.catalogue, kind, action, name, to, deviceId, now) };
    if (action === 'create') return { tasks: [], projects: [], ...(catalogue ? { catalogue } : {}) };
    const target = key(kind, name, scope.catalogue !== undefined);
    const valuesAfter = (values: string[]): string[] | null => {
        if (action === 'delete') {
            const filtered = values.filter((value) => key(kind, value, scope.catalogue !== undefined) !== target);
            return filtered.length === values.length ? null : filtered;
        }
        const index = values.findIndex((value) => key(kind, value, scope.catalogue !== undefined) === target);
        if (index < 0) return null;
        const replaced = [...values];
        replaced[index] = destination!;
        if (kind === 'tag') return dedupeTagValuesLastWins(replaced, destination!);
        const seen = new Set<string>();
        return replaced.filter((value) => {
            const normalized = key(kind, value, scope.catalogue !== undefined);
            if (seen.has(normalized)) return false;
            seen.add(normalized);
            return true;
        });
    };
    return {
        ...(catalogue ? { catalogue } : {}),
        tasks: scope.tasks.flatMap((before) => {
            const field = kind === 'tag' ? 'tags' : 'contexts';
            const values = valuesAfter(before[field] ?? []);
            return values === null ? [] : [{ before, after: { ...before, [field]: values,
                updatedAt: now, rev: nextRevision(before.rev), revBy: deviceId } }];
        }),
        projects: kind === 'tag' ? scope.projects.flatMap((before) => {
            const values = valuesAfter(before.tagIds ?? []);
            return values === null ? [] : [{ before, after: { ...before, tagIds: values,
                updatedAt: now, rev: nextRevision(before.rev), revBy: deviceId } }];
        }) : [],
    };
}
