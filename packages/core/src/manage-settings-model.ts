/**
 * The mobile Settings › Manage screen as data: its sections, texts, person
 * rows, delete confirmations, the editor dialog's texts, and the writes the
 * editor's Save makes. Shared by the React Native screen
 * (components/settings/manage-settings-screen.tsx) and the native host contract
 * (native-host-contract-settings.ts). Someday sections have their own model
 * (someday-sections-model.ts).
 */
import { DEFAULT_AREA_COLOR } from './color-constants';
import { formatI18nTemplate, tFallback } from './i18n';
import { formatListItemCount } from './list-count';
import { buildPersonSearchQuery, getPersonNameKey } from './people';
import { baseTextCollator } from './task-utils';
import type { AppSettings, Area, Person } from './types';

type Translate = (key: string) => string;

export type ManageSectionKey = 'areas' | 'people' | 'somedaySections' | 'contexts' | 'tags';

/** Screen order of the collapsible sections. */
export const MANAGE_SECTION_ORDER: readonly ManageSectionKey[] = ['areas', 'somedaySections', 'people', 'contexts', 'tags'];

/**
 * Device-local (AsyncStorage): which sections are open, as JSON
 * `{"areas":false,"people":false,"somedaySections":false,"contexts":false,"tags":false}`.
 */
export const MANAGE_OPEN_SECTIONS_STORAGE_KEY = 'mindwtr:settings:manage:openSections';
export const DEFAULT_MANAGE_OPEN_SECTIONS: Record<ManageSectionKey, boolean> = {
    areas: false,
    people: false,
    somedaySections: false,
    contexts: false,
    tags: false,
};

export const normalizeManageOpenSections = (value: unknown): Record<ManageSectionKey, boolean> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ...DEFAULT_MANAGE_OPEN_SECTIONS };
    }
    const record = value as Record<string, unknown>;
    return {
        areas: record.areas === true,
        people: record.people === true,
        somedaySections: record.somedaySections === true,
        contexts: record.contexts === true,
        tags: record.tags === true,
    };
};

/** The stored value as the screen restores it: nothing stored or unreadable JSON is all closed. */
export function parseManageOpenSections(raw: string | null | undefined): Record<ManageSectionKey, boolean> {
    if (!raw) return { ...DEFAULT_MANAGE_OPEN_SECTIONS };
    try {
        return normalizeManageOpenSections(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_MANAGE_OPEN_SECTIONS };
    }
}

const SAFE_PERSON_REFERENCE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'obsidian:']);

/** Whether a person's reference link may be opened (the row shows its open button). */
export const isSafePersonReferenceLink = (value: string | undefined): value is string => {
    const trimmed = value?.trim();
    if (!trimmed) return false;
    try {
        const url = new URL(trimmed);
        return SAFE_PERSON_REFERENCE_PROTOCOLS.has(url.protocol);
    } catch {
        return false;
    }
};

/**
 * Manage texts whose keys are not in en.ts yet, so they read in English in every
 * language. Each caller resolves them with its own English fallback:
 * apps/mobile's missing-key ratchet (tests/i18n-missing-keys.test.ts) only sees
 * keys named in mobile code.
 */
export type ManageUntranslatedText = {
    /** areas.newHint */
    newAreaHint: string;
    /** people.empty */
    peopleEmpty: string;
    /** people.newHint */
    newPersonHint: string;
    /** people.edit */
    editPerson: string;
    /** people.namePlaceholder */
    personNamePlaceholder: string;
    /** people.notePlaceholder */
    notePlaceholder: string;
    /** people.referencePlaceholder */
    referencePlaceholder: string;
    /** people.openReference */
    openReference: string;
    /** people.openReferenceFailed */
    openReferenceFailed: string;
};

/** The screen's fixed texts, in the current language. */
export function getManageSettingsText(t: Translate, untranslated: ManageUntranslatedText) {
    const tf = (key: string, fallback: string) => tFallback(t, key, fallback);
    return {
        title: t('settings.manage'),
        sections: {
            areas: t('areas.manage'),
            somedaySections: tf('viewSections.somedaySections', 'Someday sections'),
            people: tf('people.title', 'People'),
            contexts: t('contexts.title'),
            tags: t('tags.title'),
        } satisfies Record<ManageSectionKey, string>,
        areas: {
            unassignedLabel: tf('review.unassigned', 'Unassigned'),
            unassignedDescription: t('settings.unassignedAreaColorDesc'),
            empty: t('projects.noArea'),
            newLabel: tf('areas.new', 'New Area'),
            newHint: untranslated.newAreaHint,
            addLabel: tf('common.add', 'Add'),
        },
        somedaySections: {
            emptyHint: tf('viewSections.manageHint', 'Organize ideas without changing their projects or project sections.'),
        },
        people: {
            empty: untranslated.peopleEmpty,
            newLabel: tf('people.new', 'New Person'),
            newHint: untranslated.newPersonHint,
            addLabel: tf('common.add', 'Add'),
            openReference: untranslated.openReference,
            openReferenceFailed: untranslated.openReferenceFailed,
            editLabel: t('common.edit'),
            deleteLabel: t('common.delete'),
            /** The task count's accessibility hint: it opens search. */
            countHint: t('search.title'),
        },
        contexts: { empty: t('contexts.empty'), newLabel: tf('contexts.new', 'New context'), addLabel: tf('common.add', 'Add') },
        tags: { empty: t('projects.noTags'), newLabel: tf('tags.new', 'New tag'), addLabel: tf('common.add', 'Add') },
    };
}

export type ManageConfirm = { title: string; message: string; cancelLabel: string; confirmLabel: string };

/** The delete dialog for an item: Cancel, then a destructive Delete. */
export function getManageDeleteConfirm(
    t: Translate,
    name: string,
    messageKey: 'settings.deleteNamed' | 'areas.deleteConfirm' | 'people.deleteConfirm' = 'settings.deleteNamed',
): ManageConfirm {
    const localizedKey = messageKey === 'people.deleteConfirm' ? 'settings.deleteNamed' : messageKey;
    const fallback = localizedKey === 'areas.deleteConfirm'
        ? 'Delete this area? Projects and tasks in this area will be kept and moved to unassigned.'
        : 'Delete "{{name}}"?';
    return {
        title: t('common.delete'),
        message: formatI18nTemplate(tFallback(t, localizedKey, fallback), { name }),
        cancelLabel: t('common.cancel'),
        confirmLabel: t('common.delete'),
    };
}

/** Areas in their stored order. */
export const sortManageAreas = (areas: readonly Area[]): Area[] => [...areas].sort((a, b) => a.order - b.order);

/** People by name, ignoring case and accents. */
export const sortManagePeople = (people: readonly Person[]): Person[] => [...people].sort((a, b) => baseTextCollator.compare(a.name, b.name));

/** A person row: its initial, second line, task count and what the count opens. */
export function buildManagePersonRow(person: Person, taskCountByName: ReadonlyMap<string, number>, t: Translate) {
    const taskCount = taskCountByName.get(getPersonNameKey(person.name)) ?? 0;
    const referenceLink = person.referenceLink?.trim();
    const countLabel = formatListItemCount(taskCount, 'task', t);
    return {
        taskCount,
        initial: person.name.trim().slice(0, 1).toUpperCase() || '?',
        /** The second line: the note, else the link; null shows none (the count is beside the row). */
        detail: person.note?.trim() || referenceLink || null,
        countLabel,
        countAccessibilityLabel: `${person.name}: ${countLabel}`,
        /** Global search for the person's tasks, completed ones included. */
        searchQuery: buildPersonSearchQuery(person.name),
        /** The trimmed link when it may be opened; null hides the open button. */
        referenceLink: isSafePersonReferenceLink(referenceLink) ? referenceLink : null,
    };
}

/** What the editor dialog edits; each opens with the values shown. */
export type ManageEditorTarget =
    | { type: 'area'; id: string; name: string; color?: string }
    | { type: 'newArea' }
    | { type: 'unassignedArea'; color?: string }
    | { type: 'newPerson' }
    | { type: 'newContext' }
    | { type: 'newTag' }
    | { type: 'person'; id: string; name: string; note?: string; referenceLink?: string }
    | { type: 'context' | 'tag'; name: string };

export type ManageEditorDraft = { name: string; color: string; note: string; referenceLink: string };

/** The editor's fields as it opens for a target. */
export function getManageEditorDraft(target: ManageEditorTarget): ManageEditorDraft {
    const draft: ManageEditorDraft = { name: '', color: DEFAULT_AREA_COLOR, note: '', referenceLink: '' };
    switch (target.type) {
        case 'area':
            return { ...draft, name: target.name, color: target.color || DEFAULT_AREA_COLOR };
        case 'unassignedArea':
            return { ...draft, color: target.color ?? DEFAULT_AREA_COLOR };
        case 'person':
            return { ...draft, name: target.name, note: target.note ?? '', referenceLink: target.referenceLink ?? '' };
        case 'context':
        case 'tag':
            return { ...draft, name: target.name };
        default:
            return draft;
    }
}

/** The editor dialog's texts for a target type; null parts are not shown. */
export function getManageEditorText(t: Translate, type: ManageEditorTarget['type'], untranslated: ManageUntranslatedText) {
    const tf = (key: string, fallback: string) => tFallback(t, key, fallback);
    const isArea = type === 'area' || type === 'newArea';
    const isPerson = type === 'newPerson' || type === 'person';
    return {
        title: type === 'area'
            ? t('areas.edit')
            : type === 'newArea'
                ? tf('areas.new', 'New Area')
                : type === 'unassignedArea'
                    ? t('settings.unassignedAreaColor')
                    : type === 'newPerson'
                        ? tf('people.new', 'New Person')
                        : type === 'person'
                            ? untranslated.editPerson
                            : type === 'newContext'
                                ? tf('contexts.new', 'New context')
                                : type === 'newTag'
                                    ? tf('tags.new', 'New tag')
                                    : t('common.rename'),
        /** The name field's placeholder; null: no name field (the unassigned color). */
        namePlaceholder: type === 'unassignedArea'
            ? null
            : isArea
                ? t('projects.areaLabel')
                : isPerson
                    ? untranslated.personNamePlaceholder
                    : t('common.name'),
        personFields: isPerson ? {
            notePlaceholder: untranslated.notePlaceholder,
            referencePlaceholder: untranslated.referencePlaceholder,
        } : null,
        /** The color swatches' spoken label prefix: `${changeColor}: ${color}`; null: no swatches. */
        changeColor: isArea || type === 'unassignedArea' ? t('projects.changeColor') : null,
        /** Shown under the name while isManageAreaNameTaken; null: never. */
        nameTaken: type === 'newArea' ? tf('areas.nameExists', 'An area with this name already exists.') : null,
        cancelLabel: t('common.cancel'),
        saveLabel: t('common.save'),
    };
}

/**
 * A new area named like a live area, ignoring case and outer spaces. Save is off
 * for it: adding the name would only return that area, and nothing is written.
 */
export const isManageAreaNameTaken = (type: ManageEditorTarget['type'], name: string, areas: readonly Pick<Area, 'name'>[]): boolean => {
    const key = name.trim().toLowerCase();
    return type === 'newArea' && key !== '' && areas.some((area) => area.name?.trim().toLowerCase() === key);
};

/** Save is off while the name is blank, except for the unassigned color, and for a new area's taken name. */
export const isManageEditorSaveDisabled = (type: ManageEditorTarget['type'], name: string, areas: readonly Pick<Area, 'name'>[]): boolean => (
    (type !== 'unassignedArea' && !name.trim()) || isManageAreaNameTaken(type, name, areas)
);

/** One store call the editor's Save makes. */
export type ManageEditorWrite =
    | { kind: 'updateSettings'; updates: Partial<AppSettings> }
    | { kind: 'addContext' | 'addTag'; name: string }
    | { kind: 'addArea'; name: string; props: Partial<Area> }
    | { kind: 'addPerson'; name: string; props: Partial<Person> | undefined }
    | { kind: 'updatePerson'; id: string; updates: Partial<Person> }
    | { kind: 'renamePerson'; id: string; name: string; options: { updateTasks: true } }
    | { kind: 'updateArea'; id: string; updates: Partial<Area> }
    | { kind: 'renameContext' | 'renameTag'; from: string; to: string };

/**
 * The store calls Save makes, in order, compared with the values the editor
 * opened with. null: nothing is written and the editor stays open (a blank
 * name). An empty list closes the editor without writing.
 */
export function planManageEditorSave(target: ManageEditorTarget, draft: ManageEditorDraft, settings: AppSettings): ManageEditorWrite[] | null {
    const trimmed = draft.name.trim();

    if (target.type === 'unassignedArea') {
        return [{
            kind: 'updateSettings',
            updates: { appearance: { ...(settings.appearance ?? {}), unassignedAreaColor: draft.color } },
        }];
    }

    if (!trimmed) return null;

    if (target.type === 'newContext') return [{ kind: 'addContext', name: trimmed }];
    if (target.type === 'newTag') return [{ kind: 'addTag', name: trimmed }];

    if (target.type === 'newArea') return [{ kind: 'addArea', name: trimmed, props: { color: draft.color } }];

    if (target.type === 'newPerson') {
        const note = draft.note.trim();
        const referenceLink = draft.referenceLink.trim();
        const initialProps: Partial<Person> = {};
        if (note) initialProps.note = note;
        if (referenceLink) initialProps.referenceLink = referenceLink;
        return [{ kind: 'addPerson', name: trimmed, props: Object.keys(initialProps).length > 0 ? initialProps : undefined }];
    }

    if (target.type === 'person') {
        const writes: ManageEditorWrite[] = [];
        const note = draft.note.trim();
        const referenceLink = draft.referenceLink.trim();
        const updates: Partial<Person> = {};
        if ((target.note ?? '') !== note) {
            updates.note = note || undefined;
        }
        if ((target.referenceLink ?? '') !== referenceLink) {
            updates.referenceLink = referenceLink || undefined;
        }
        if (Object.keys(updates).length > 0) writes.push({ kind: 'updatePerson', id: target.id, updates });
        if (trimmed !== target.name) writes.push({ kind: 'renamePerson', id: target.id, name: trimmed, options: { updateTasks: true } });
        return writes;
    }

    if (target.type === 'area') {
        const updates: Partial<Area> = {};
        if (trimmed !== target.name) {
            updates.name = trimmed;
        }
        if (draft.color !== (target.color || DEFAULT_AREA_COLOR)) {
            updates.color = draft.color;
        }
        return Object.keys(updates).length > 0 ? [{ kind: 'updateArea', id: target.id, updates }] : [];
    }

    if (trimmed === target.name) return [];
    return [{ kind: target.type === 'context' ? 'renameContext' : 'renameTag', from: target.name, to: trimmed }];
}
