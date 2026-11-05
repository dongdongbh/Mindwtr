


import { isTaskVisibleInArea, type AreaFilterSelection } from './area-filter';
import { formatI18nTemplate, tFallback } from './i18n';
import { logInfo } from './logger';
import { getSomedaySectionChoices } from './task-editor-model';
import type { AppSettings, Area, Project, Task, ViewSectionDefinition } from './types';
import { buildTaskViewSectionUpdates, sortViewSectionDefinitions } from './view-sections';

type Translate = (key: string) => string;

function makeSomedaySectionId(now = Date.now(), random: () => number = Math.random): string {
    return `someday-${now.toString(36)}-${random().toString(36).slice(2, 8)}`;
}


export function buildSomedaySectionsSettingsUpdate(
    settings: AppSettings | undefined,
    someday: ViewSectionDefinition[],
): Partial<AppSettings> {
    logInfo('Someday sections written; other sections kept as stored', {
        scope: 'someday-sections',
        category: 'storage',
        context: {
            releaseCheck: 'v1.3.3/someday-sections-keep-others',
            count: someday.length,
            hiddenCount: someday.length - sortViewSectionDefinitions(someday).length,
        },
    });
    return {
        gtd: {
            ...(settings?.gtd ?? {}),
            viewSections: {
                ...(settings?.gtd?.viewSections ?? {}),
                someday,
            },
        },
    };
}

export type SomedaySectionCreatePlan =
    | { kind: 'blank' }

    | { kind: 'existing'; id: string }
    | { kind: 'create'; id: string; sections: ViewSectionDefinition[] };

export function planSomedaySectionCreate(
    stored: readonly ViewSectionDefinition[] | undefined,
    title: string,
    newId: () => string = makeSomedaySectionId,
): SomedaySectionCreatePlan {
    const trimmed = title.trim();
    if (!trimmed) return { kind: 'blank' };
    const current = sortViewSectionDefinitions(stored);
    const existing = current.find((section) => section.title.toLowerCase() === trimmed.toLowerCase());
    if (existing) return { kind: 'existing', id: existing.id };
    const id = newId();
    const maxOrder = current.reduce(
        (maximum, section) => Number.isFinite(section.order) ? Math.max(maximum, section.order) : maximum,
        -1,
    );
    return { kind: 'create', id, sections: [...(stored ?? []), { id, title: trimmed, order: maxOrder + 1 }] };
}


export function renameSomedaySection(
    stored: readonly ViewSectionDefinition[] | undefined,
    id: string,
    title: string,
): ViewSectionDefinition[] | null {
    const trimmed = title.trim();
    if (!trimmed) return null;
    return (stored ?? []).map((section) => section?.id === id ? { ...section, title: trimmed } : section);
}


export function orderSomedaySections(
    stored: readonly ViewSectionDefinition[] | undefined,
    ids: readonly string[],
): ViewSectionDefinition[] {
    const orderById = new Map(ids.map((id, order) => [id, order]));
    const shown = new Set(sortViewSectionDefinitions(stored));
    return (stored ?? []).map((section) => {
        const order = shown.has(section) ? orderById.get(section.id) : undefined;
        return order === undefined || section.order === order ? section : { ...section, order };
    });
}


export function moveSomedaySection(
    stored: readonly ViewSectionDefinition[] | undefined,
    id: string,
    offset: -1 | 1,
): ViewSectionDefinition[] | null {
    const ids = sortViewSectionDefinitions(stored).map((section) => section.id);
    const index = ids.indexOf(id);
    const targetIndex = index + offset;
    if (index < 0 || targetIndex < 0 || targetIndex >= ids.length) return null;
    ids.splice(targetIndex, 0, ...ids.splice(index, 1));
    return orderSomedaySections(stored, ids);
}


export function removeSomedaySection(stored: readonly ViewSectionDefinition[] | undefined, id: string): ViewSectionDefinition[] {
    return (stored ?? []).filter((section) => section?.id !== id);
}

const resolveText = (t: Translate, key: string, fallback: string) => tFallback(t, key, fallback);


export function buildSomedaySectionManagerRows(stored: readonly ViewSectionDefinition[] | undefined, t: Translate) {
    const sorted = sortViewSectionDefinitions(stored);
    return sorted.map((section, index) => ({
        id: section.id,
        title: section.title,
        moveUp: {
            label: `${tFallback(t, 'projects.moveUp', 'Move up')}: ${section.title}`,
            disabled: index === 0,
        },
        moveDown: {
            label: `${tFallback(t, 'projects.moveDown', 'Move down')}: ${section.title}`,
            disabled: index === sorted.length - 1,
        },
        renameLabel: `${tFallback(t, 'viewSections.rename', 'Rename section')}: ${section.title}`,
        deleteLabel: `${t('common.delete')}: ${section.title}`,
        deleteConfirm: {
            title: t('common.delete'),
            message: formatI18nTemplate(resolveText(t, 'settings.deleteNamed', 'Delete "{{name}}"?'), { name: section.title }),
            cancelLabel: t('common.cancel'),
            confirmLabel: t('common.delete'),
        },
    }));
}

export function getSomedaySectionManagerText(t: Translate) {
    return {
        title: resolveText(t, 'viewSections.somedaySections', 'Someday sections'),
        emptyHint: resolveText(t, 'viewSections.manageHint', 'Organize ideas without changing their projects or project sections.'),
        nameLabel: tFallback(t, 'viewSections.nameHint', 'Section name'),
        saveLabel: t('common.save'),
    };
}


export type SomedaySectionAssignment = { id: string; sectionId?: string };


export function getSomedaySectionMoveTasks(input: {

    tasks: readonly Task[];
    projects: readonly Project[];
    areas: readonly Area[];
    ids: readonly string[];
    resolvedAreaFilter: AreaFilterSelection;
}): Task[] | null {
    const taskById = new Map(input.tasks.map((task) => [task.id, task]));
    const visibility = {
        areaById: new Map(input.areas.filter((area) => !area.deletedAt).map((area) => [area.id, area])),
        projectById: new Map(input.projects.map((project) => [project.id, project])),
        resolvedAreaFilter: input.resolvedAreaFilter,
    };
    const tasks = input.ids.map((id) => taskById.get(id));
    if (tasks.some((task) => !task || task.status !== 'someday' || !isTaskVisibleInArea(task, visibility))) return null;
    return tasks as Task[];
}

const sameIds = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((id, index) => id === right[index]);


export function planSomedaySectionMove(input: {
    ids: readonly string[];

    tasks: readonly Task[];
    destination?: string;
    pending?: { ids: readonly string[]; destination?: string; previous: readonly SomedaySectionAssignment[] } | null;
}): { updates: ReturnType<typeof buildTaskViewSectionUpdates>; previous: SomedaySectionAssignment[]; resumed: boolean } {
    const updates = buildTaskViewSectionUpdates(input.tasks, 'someday', input.destination);
    const pending = input.pending;
    const resume = pending && sameIds(pending.ids, input.ids)
        && input.tasks.every((task) => (task.viewSectionIds?.someday || undefined) === pending.destination)
        ? pending : null;
    const previousById = new Map((resume?.previous ?? []).map((entry) => [entry.id, entry]));
    for (const update of updates) {
        if (previousById.has(update.id)) continue;
        const task = input.tasks.find((candidate) => candidate.id === update.id);
        previousById.set(update.id, { id: update.id, sectionId: task?.viewSectionIds?.someday });
    }
    return { updates, previous: [...previousById.values()], resumed: Boolean(resume) };
}


export function getSomedaySectionMoveSelection(
    tasks: readonly (Task | undefined)[],
    sections: readonly ViewSectionDefinition[],
): { selectedId: string | undefined; selectionMixed: boolean } {
    const assignments = tasks.map((task) => task?.viewSectionIds?.someday);
    const mixed = assignments.some((assignment) => assignment !== assignments[0]);
    const selectedId = mixed ? undefined : assignments[0];
    return {
        selectedId,
        selectionMixed: mixed || Boolean(selectedId && !sections.some((section) => section.id === selectedId)),
    };
}


export function buildSomedaySectionMoveDialog(
    tasks: readonly (Task | undefined)[],
    stored: readonly ViewSectionDefinition[] | undefined,
    t: Translate,
) {
    const sections = sortViewSectionDefinitions(stored);
    const { selectedId, selectionMixed } = getSomedaySectionMoveSelection(tasks, sections);
    return {
        title: tFallback(t, 'viewSections.moveToSection', 'Move to section…'),
        choices: getSomedaySectionChoices(sections, selectedId, tFallback(t, 'viewSections.noSection', 'No section'), selectionMixed)
            .map((choice) => ({ sectionId: choice.id || null, title: choice.title, selected: choice.selected })),
        newSectionLabel: `+ ${tFallback(t, 'viewSections.add', 'New section…')}`,
        cancelLabel: t('common.cancel'),
    };
}

export function getSomedaySectionMoveText(t: Translate) {
    return {
        undoLabel: tFallback(t, 'common.undo', 'Undo'),
        errorTitle: tFallback(t, 'common.error', 'Error'),
        moveFailed: tFallback(t, 'viewSections.moveFailed', 'Could not move tasks to the section.'),
        undoFailed: tFallback(t, 'viewSections.undoFailed', 'Could not undo the section move.'),
    };
}


export function formatSomedaySectionMoved(t: Translate, count: number, sectionTitle?: string): string {
    return formatI18nTemplate(tFallback(t, 'viewSections.moved', 'Moved to {section} ({count})'), {
        count,
        section: sectionTitle ?? tFallback(t, 'viewSections.noSection', 'No section'),
    });
}


export type SomedaySectionTaskPlan =
    | { kind: 'blank' }

    | { kind: 'missing-section' }
    | { kind: 'add'; title: string; props: Partial<Task> };

export function planSomedaySectionTaskAdd(input: {
    title: string;

    sectionId?: string;
    stored: readonly ViewSectionDefinition[] | undefined;
}): SomedaySectionTaskPlan {
    const title = input.title.trim();
    if (!title) return { kind: 'blank' };
    if (input.sectionId && !sortViewSectionDefinitions(input.stored).some((section) => section.id === input.sectionId)) {
        return { kind: 'missing-section' };
    }
    return {
        kind: 'add',
        title,
        props: {
            status: 'someday',
            ...(input.sectionId ? { viewSectionIds: { someday: input.sectionId } } : {}),
        },
    };
}

export function getSomedaySectionTaskText(t: Translate, groupTitle: string) {
    return {
        title: formatI18nTemplate(tFallback(t, 'viewSections.addTask', 'Add task to {section}'), { section: groupTitle }),
        inputLabel: tFallback(t, 'taskEdit.titleLabel', 'Task title'),
        placeholder: tFallback(t, 'quickAdd.inputLabel', 'Task title'),
        failed: tFallback(t, 'task.addFailed', 'Failed to add task'),
        created: tFallback(t, 'calendar.eventTaskCreatedTitle', 'Task created'),
        saveLabel: t('common.save'),
        retryLabel: tFallback(t, 'common.retry', 'Retry'),
        cancelLabel: t('common.cancel'),
    };
}
