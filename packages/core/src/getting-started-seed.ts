import {
    buildSaveSnapshot,
    ensureDeviceId,
    getNextDataChangeAt,
    nextRevision,
    selectVisibleProjects,
    selectVisibleTasks,
} from './store-helpers';
import { generateUUID as uuidv4 } from './uuid';
import { translations } from './i18n/i18n-translations';
import { isSupportedLanguage } from './i18n/i18n-constants';
import { getSystemDefaultLanguage } from './i18n/i18n-storage';
import type { Language } from './i18n/i18n-types';
import type { AppData, Project, Task } from './types';
import type { StoreActionResult, TaskStore } from './store-types';

type StarterTaskTemplate = {
    key: StarterTaskKey;
    titleKey: string;
    descriptionKey: string;
    checklistKeys: string[];
    contexts?: string[];
    tags?: string[];
    isFocusedToday?: boolean;
};

type ResolvedStarterTemplate = {
    key: StarterTaskKey;
    title: string;
    description: string;
    checklist: string[];
    contexts?: string[];
    tags?: string[];
    isFocusedToday?: boolean;
};

type StarterTaskKey =
    | 'process-inbox'
    | 'quick-capture'
    | 'focus'
    | 'simplify'
    | 'weekly-review'
    | 'sync'
    | 'import';

const normalizeStarterTaskTitle = (title: string): string => title.trim().toLowerCase();

const STARTER_TASK_TEMPLATES: StarterTaskTemplate[] = [
    { key: 'process-inbox', titleKey: 'starter.processInbox.title', descriptionKey: 'starter.processInbox.desc', checklistKeys: ['starter.processInbox.check1', 'starter.processInbox.check2', 'starter.processInbox.check3'] },
    { key: 'quick-capture', titleKey: 'starter.quickCapture.title', descriptionKey: 'starter.quickCapture.desc', checklistKeys: ['starter.quickCapture.check1', 'starter.quickCapture.check2', 'starter.quickCapture.check3'], contexts: ['@computer'] },
    { key: 'focus', titleKey: 'starter.focus.title', descriptionKey: 'starter.focus.desc', checklistKeys: ['starter.focus.check1', 'starter.focus.check2', 'starter.focus.check3'], contexts: ['@computer'], isFocusedToday: true },
    { key: 'simplify', titleKey: 'starter.simplify.title', descriptionKey: 'starter.simplify.desc', checklistKeys: ['starter.simplify.check1', 'starter.simplify.check2', 'starter.simplify.check3'] },
    { key: 'sync', titleKey: 'starter.sync.title', descriptionKey: 'starter.sync.desc', checklistKeys: ['starter.sync.check1', 'starter.sync.check2', 'starter.sync.check3'] },
    { key: 'import', titleKey: 'starter.import.title', descriptionKey: 'starter.import.desc', checklistKeys: ['starter.import.check1', 'starter.import.check2', 'starter.import.check3'] },
    { key: 'weekly-review', titleKey: 'starter.weeklyReview.title', descriptionKey: 'starter.weeklyReview.desc', checklistKeys: ['starter.weeklyReview.check1', 'starter.weeklyReview.check2', 'starter.weeklyReview.check3'] },
];

const STARTER_SAMPLE_TASK_KEYS = ['starter.sampleBuyMilk', 'starter.sampleReplySam'] as const;

const STARTER_PROJECT_TITLE_KEY = 'starter.projectTitle';
const STARTER_PROJECT_NOTES_KEY = 'starter.projectNotes';

const seedLanguages = (): Language[] => Object.keys(translations) as Language[];

const resolveStarterString = (lang: Language, key: string): string =>
    translations[lang]?.[key] ?? translations.en[key] ?? key;

const resolveStarterTemplates = (lang: Language): ResolvedStarterTemplate[] =>
    STARTER_TASK_TEMPLATES.map((template) => ({
        key: template.key,
        title: resolveStarterString(lang, template.titleKey),
        description: resolveStarterString(lang, template.descriptionKey),
        checklist: template.checklistKeys.map((checklistKey) => resolveStarterString(lang, checklistKey)),
        contexts: template.contexts,
        tags: template.tags,
        isFocusedToday: template.isFocusedToday,
    }));

export const resolveSeedLanguage = (explicit?: string, settingsLanguage?: string): Language => {
    if (explicit && isSupportedLanguage(explicit)) return explicit;
    if (settingsLanguage && settingsLanguage !== 'system' && isSupportedLanguage(settingsLanguage)) return settingsLanguage;
    return getSystemDefaultLanguage();
};

// Seeded titles are matched across every app language so a seed created in one
// language repairs (never duplicates) after the user switches languages.
let starterTaskKeyByTitleCache: Map<string, StarterTaskKey> | null = null;
const getStarterTaskKeyByTitle = (): Map<string, StarterTaskKey> => {
    if (starterTaskKeyByTitleCache) return starterTaskKeyByTitleCache;
    const map = new Map<string, StarterTaskKey>();
    for (const lang of seedLanguages()) {
        for (const template of STARTER_TASK_TEMPLATES) {
            map.set(normalizeStarterTaskTitle(resolveStarterString(lang, template.titleKey)), template.key);
        }
    }
    // Titles from older seed copy; keep so existing installs repair instead of duplicating.
    map.set('process your first inbox item', 'process-inbox');
    map.set('start here: process your first inbox item', 'process-inbox');
    map.set('try quick capture with a context and date', 'quick-capture');
    map.set('여기서 시작: 첫 수집함 항목 처리하기', 'process-inbox');
    map.set('한 줄로 작업 기록하기', 'quick-capture');
    map.set('오늘의 포커스에 작업을 최대 3개 별표하기', 'focus');
    map.set('mindwtr를 내 것으로: 안 쓰는 것 숨기기', 'simplify');
    map.set('다른 앱에서 작업 가져오기', 'import');
    starterTaskKeyByTitleCache = map;
    return map;
};

let starterProjectTitlesCache: Set<string> | null = null;
const getStarterProjectTitles = (): Set<string> => {
    if (starterProjectTitlesCache) return starterProjectTitlesCache;
    const titles = new Set<string>();
    for (const lang of seedLanguages()) {
        titles.add(normalizeStarterTaskTitle(resolveStarterString(lang, STARTER_PROJECT_TITLE_KEY)));
    }
    starterProjectTitlesCache = titles;
    return titles;
};

let sampleTaskKeyByTitleCache: Map<string, string> | null = null;
const getSampleTaskKeyByTitle = (): Map<string, string> => {
    if (sampleTaskKeyByTitleCache) return sampleTaskKeyByTitleCache;
    const map = new Map<string, string>();
    for (const lang of seedLanguages()) {
        for (const sampleKey of STARTER_SAMPLE_TASK_KEYS) {
            map.set(normalizeStarterTaskTitle(resolveStarterString(lang, sampleKey)), sampleKey);
        }
    }
    sampleTaskKeyByTitleCache = map;
    return map;
};

const getStarterTaskKey = (task: Task): StarterTaskKey | null =>
    getStarterTaskKeyByTitle().get(normalizeStarterTaskTitle(task.title)) ?? null;

const getStarterTaskSortValue = (task: Task): number => {
    if (Number.isFinite(task.order)) return task.order as number;
    if (Number.isFinite(task.orderNum)) return task.orderNum as number;
    return Number.MAX_SAFE_INTEGER;
};

const buildStarterChecklist = (
    template: ResolvedStarterTemplate,
    existingChecklist: Task['checklist']
): Task['checklist'] => {
    if (template.checklist.length === 0) return undefined;
    const existingByTitle = new Map(
        (existingChecklist ?? []).map((item) => [normalizeStarterTaskTitle(item.title), item])
    );
    return template.checklist.map((title, index) => {
        const existingItem = existingByTitle.get(normalizeStarterTaskTitle(title)) ?? existingChecklist?.[index];
        return {
            id: existingItem?.id ?? uuidv4(),
            title,
            isCompleted: existingItem?.isCompleted ?? false,
        };
    });
};

const arrayShallowEqual = (left: readonly string[] = [], right: readonly string[] = []): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);

const checklistShallowEqual = (left: Task['checklist'], right: Task['checklist']): boolean => {
    const leftItems = left ?? [];
    const rightItems = right ?? [];
    return leftItems.length === rightItems.length && leftItems.every((item, index) => {
        const other = rightItems[index];
        return Boolean(other)
            && item.id === other.id
            && item.title === other.title
            && item.isCompleted === other.isCompleted;
    });
};

const normalizeExistingStarterTask = (
    task: Task,
    template: ResolvedStarterTemplate,
    order: number,
    nowIso: string,
    deviceId?: string
): Task => {
    const nextChecklist = buildStarterChecklist(template, task.checklist);
    const nextTaskMode = template.checklist.length > 0 ? 'list' : 'task';
    const nextIsFocusedToday = task.isFocusedToday === undefined ? template.isFocusedToday : task.isFocusedToday;
    const changed =
        task.title !== template.title
        || task.taskMode !== nextTaskMode
        || task.description !== template.description
        || task.order !== order
        || task.orderNum !== order
        || task.isFocusedToday !== nextIsFocusedToday
        || !arrayShallowEqual(task.tags, template.tags ?? [])
        || !arrayShallowEqual(task.contexts, template.contexts ?? [])
        || !checklistShallowEqual(task.checklist, nextChecklist);

    if (!changed) return task;

    return {
        ...task,
        title: template.title,
        taskMode: nextTaskMode,
        tags: template.tags ?? [],
        contexts: template.contexts ?? [],
        checklist: nextChecklist,
        description: template.description,
        order,
        orderNum: order,
        isFocusedToday: nextIsFocusedToday,
        updatedAt: nowIso,
        rev: nextRevision(task.rev),
        ...(deviceId ? { revBy: deviceId } : {}),
    };
};

const buildFreshInstallGettingStartedData = (
    nowIso: string,
    deviceId: string | undefined,
    lang: Language
): Pick<AppData, 'projects' | 'tasks'> => {
    const projectId = uuidv4();
    const revisionMeta = deviceId ? { revBy: deviceId } : {};
    const project: Project = {
        id: projectId,
        title: resolveStarterString(lang, STARTER_PROJECT_TITLE_KEY),
        status: 'active',
        color: '#3B82F6',
        order: 0,
        tagIds: [],
        supportNotes: resolveStarterString(lang, STARTER_PROJECT_NOTES_KEY),
        rev: 1,
        ...revisionMeta,
        createdAt: nowIso,
        updatedAt: nowIso,
    };
    const tasks: Task[] = resolveStarterTemplates(lang).map((template, index) => ({
        id: uuidv4(),
        title: template.title,
        status: 'next',
        taskMode: template.checklist.length > 0 ? 'list' : 'task',
        tags: template.tags ?? [],
        contexts: template.contexts ?? [],
        ...(template.checklist.length > 0 ? {
            checklist: template.checklist.map((title) => ({
                id: uuidv4(),
                title,
                isCompleted: false,
            })),
        } : {}),
        description: template.description,
        projectId,
        order: index,
        orderNum: index,
        isFocusedToday: template.isFocusedToday,
        rev: 1,
        ...revisionMeta,
        createdAt: nowIso,
        updatedAt: nowIso,
    }));

    const sampleInboxTasks: Task[] = STARTER_SAMPLE_TASK_KEYS.map((sampleKey) => ({
        id: uuidv4(),
        title: resolveStarterString(lang, sampleKey),
        status: 'inbox',
        taskMode: 'task',
        tags: [],
        contexts: [],
        rev: 1,
        ...revisionMeta,
        createdAt: nowIso,
        updatedAt: nowIso,
    }));

    return { projects: [project], tasks: [...tasks, ...sampleInboxTasks] };
};

/**
 * Builds the seedGettingStarted store action. Takes only the two pieces of
 * SettingsActionContext it actually uses (see store-settings.ts) so this
 * module has no dependency back on the store action wiring.
 */
export const createSeedGettingStartedAction = (
    set: (partial: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore> | TaskStore)) => void,
    debouncedSave: (data: AppData, onError?: (msg: string) => void) => void
): ((options?: { language?: string }) => Promise<StoreActionResult>) => async (options) => {
    const changeAt = Date.now();
    const nowIso = new Date().toISOString();
    let snapshot: AppData | null = null;
    let projectId: string | undefined;

    set((state) => {
        const deviceState = ensureDeviceId(state.settings);
        const lang = resolveSeedLanguage(
            options?.language,
            typeof state.settings.language === 'string' ? state.settings.language : undefined
        );
        const starterData = buildFreshInstallGettingStartedData(nowIso, deviceState.deviceId, lang);
        const starterTemplateProject = starterData.projects[0];
        if (!starterTemplateProject) return state;
        const starterProjectTitles = getStarterProjectTitles();
        const existingProject = state._allProjects.find((project) =>
            !project.deletedAt &&
            typeof project.title === 'string' &&
            starterProjectTitles.has(project.title.trim().toLowerCase())
        );
        const maxProjectOrder = state._allProjects.reduce(
            (max, project) => Math.max(max, Number.isFinite(project.order) ? project.order : -1),
            -1
        );
        const starterProject = existingProject ?? {
            ...starterTemplateProject,
            order: maxProjectOrder + 1,
        };
        // Repair the tutorial project's canonical copy into the seed language,
        // mirroring how the starter tasks are repaired below.
        let starterProjectUpdate: Project | null = null;
        if (existingProject
            && (existingProject.title !== starterTemplateProject.title
                || existingProject.supportNotes !== starterTemplateProject.supportNotes)) {
            starterProjectUpdate = {
                ...existingProject,
                title: starterTemplateProject.title,
                supportNotes: starterTemplateProject.supportNotes,
                updatedAt: nowIso,
                rev: nextRevision(existingProject.rev),
                ...(deviceState.deviceId ? { revBy: deviceState.deviceId } : {}),
            };
        }
        const starterTasksByKey = new Map<StarterTaskKey, Task[]>();
        for (const task of state._allTasks) {
            if (task.deletedAt || task.projectId !== starterProject.id) continue;
            const starterKey = getStarterTaskKey(task);
            if (!starterKey) continue;
            const tasksForKey = starterTasksByKey.get(starterKey) ?? [];
            tasksForKey.push(task);
            starterTasksByKey.set(starterKey, tasksForKey);
        }
        const starterTaskUpdates = new Map<string, Task>();
        const existingStarterKeys = new Set<StarterTaskKey>();
        const resolvedTemplates = resolveStarterTemplates(lang);
        for (const [index, template] of resolvedTemplates.entries()) {
            const candidates = (starterTasksByKey.get(template.key) ?? [])
                .slice()
                .sort((left, right) => getStarterTaskSortValue(left) - getStarterTaskSortValue(right));
            if (candidates.length === 0) continue;

            existingStarterKeys.add(template.key);
            const currentTitle = normalizeStarterTaskTitle(template.title);
            const preferredCandidate = candidates.find((task) => normalizeStarterTaskTitle(task.title) === currentTitle)
                ?? candidates[0];
            const normalizedTask = normalizeExistingStarterTask(preferredCandidate, template, index, nowIso, deviceState.deviceId);
            if (normalizedTask !== preferredCandidate) {
                starterTaskUpdates.set(preferredCandidate.id, normalizedTask);
            }
            for (const duplicate of candidates) {
                if (duplicate.id === preferredCandidate.id) continue;
                starterTaskUpdates.set(duplicate.id, {
                    ...duplicate,
                    deletedAt: duplicate.deletedAt ?? nowIso,
                    updatedAt: nowIso,
                    rev: nextRevision(duplicate.rev),
                    ...(deviceState.deviceId ? { revBy: deviceState.deviceId } : {}),
                });
            }
        }
        const activeTaskTitleKey = (task: Task) => `${task.status}:${task.projectId ?? ''}:${task.title.trim().toLowerCase()}`;
        const existingActiveTaskKeys = new Set(
            state._allTasks
                .filter((task) => !task.deletedAt)
                .map(activeTaskTitleKey)
        );
        // Sample inbox items are matched across languages too, so re-seeding
        // after a language switch does not duplicate them.
        const sampleTaskKeyByTitle = getSampleTaskKeyByTitle();
        const existingSampleKeys = new Set<string>();
        for (const task of state._allTasks) {
            if (task.deletedAt || task.projectId || task.status !== 'inbox') continue;
            const sampleKey = sampleTaskKeyByTitle.get(normalizeStarterTaskTitle(task.title));
            if (sampleKey) existingSampleKeys.add(sampleKey);
        }
        const tasksToAdd = starterData.tasks
            .map((task) => ({
                ...task,
                projectId: task.projectId === starterTemplateProject.id ? starterProject.id : task.projectId,
            }))
            .filter((task) => {
                const starterKey = task.projectId === starterProject.id ? getStarterTaskKey(task) : null;
                if (starterKey && existingStarterKeys.has(starterKey)) return false;
                const sampleKey = task.projectId ? null : sampleTaskKeyByTitle.get(normalizeStarterTaskTitle(task.title));
                if (sampleKey && existingSampleKeys.has(sampleKey)) return false;
                return !existingActiveTaskKeys.has(activeTaskTitleKey(task));
            });

        projectId = starterProject.id;
        if (existingProject && tasksToAdd.length === 0 && starterTaskUpdates.size === 0 && !starterProjectUpdate && !deviceState.updated) {
            return state;
        }

        const starterProjectRepair = starterProjectUpdate;
        const nextProjects = existingProject
            ? (starterProjectRepair
                ? state._allProjects.map((project) => project.id === starterProjectRepair.id ? starterProjectRepair : project)
                : state._allProjects)
            : [...state._allProjects, starterProject];
        const repairedTasks = starterTaskUpdates.size > 0
            ? state._allTasks.map((task) => starterTaskUpdates.get(task.id) ?? task)
            : state._allTasks;
        const nextTasks = tasksToAdd.length > 0 ? [...repairedTasks, ...tasksToAdd] : repairedTasks;

        snapshot = buildSaveSnapshot(state, {
            tasks: nextTasks,
            projects: nextProjects,
            ...(deviceState.updated ? { settings: deviceState.settings } : {}),
        });

        return {
            tasks: selectVisibleTasks(nextTasks),
            projects: selectVisibleProjects(nextProjects),
            _allTasks: nextTasks,
            _allProjects: nextProjects,
            ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
        };
    });

    if (snapshot) {
        debouncedSave(snapshot, (msg) => set({ error: msg }));
    }
    return { success: true, id: projectId };
};
