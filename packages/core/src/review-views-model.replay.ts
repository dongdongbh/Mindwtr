/**
 * Test support only (imported by the review views tests; not exported).
 * Replays the frozen React Native Review, Weekly Review and Daily Review
 * scenarios (review-views-parity.fixtures.json, captured by the mobile parity
 * harnesses) through the native host contract. The replay plays the native
 * screen: it keeps the screen's own state (what is expanded, selected or open,
 * the stored checkpoint), reads views, sends actions, and lays the view's text
 * out in the order the React Native screen draws it.
 */
import { readFileSync } from 'node:fs';
import type { ReviewSuggestion } from './ai/types';
import type {
    createNativeHostContract,
    NativeHostResult,
} from './native-host-contract';
import type {
    NativeDailyReview,
    NativeReviewAction,
    NativeReviewCalendar,
    NativeReviewActionResult,
    NativeReviewExpansionEdit,
    NativeReviewOverview,
    NativeReviewOverviewItem,
    NativeReviewWindow,
    NativeWeeklyReview,
    NativeWeeklyReviewItem,
    NativeWeeklyReviewList,
} from './native-host-contract-review-views';
import { DAILY_REVIEW_SESSION_STORAGE_KEY, WEEKLY_REVIEW_SESSION_STORAGE_KEY, filterReviewSuggestions, getReviewCalendarRange, getReviewDay, isActionableReviewSuggestion, type TitledReviewSuggestion } from './review-views-model';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppSettings, Area, ExternalCalendarEvent, Project, Task } from './index';

type Contract = ReturnType<typeof createNativeHostContract>;
type Observation = Record<string, unknown>;
export type ReviewPart = 'review' | 'weeklyReview' | 'dailyReview';
export type ReviewScenario = {
    name: string;
    settings: string;
    taskIds?: string[];
    projectIds?: string[];
    calendar?: 'events' | 'error' | 'none';
    storage?: Record<string, string>;
    actions: [string, ...unknown[]][];
};
export type ReviewFixturePart = {
    timeZone: string;
    now: string;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    calendarEvents: ExternalCalendarEvent[];
    settings: Record<string, AppSettings>;
    scenarios: ReviewScenario[];
    aiSuggestions?: ReviewSuggestion[];
    observations: Record<string, Observation[]>;
};
export type ReviewViewsFixture = { provenance: Record<string, unknown> } & Record<ReviewPart, ReviewFixturePart>;

export const loadReviewViewsFixture = (): ReviewViewsFixture => JSON.parse(
    readFileSync(new URL('./review-views-parity.fixtures.json', import.meta.url), 'utf8'),
);

// The mobile harnesses' theme colors.
const THEME = { tint: '#3b82f6', text: '#0f172a', secondaryText: '#64748b', success: '#10b981', warning: '#f59e0b', danger: '#ef4444' };
const CALENDAR_ERROR = 'Calendar feed unreachable';

/** The store writes a scenario asks for, as the mobile harnesses record them. */
export function createReviewRecorder() {
    const log: unknown[][] = [];
    const createdIds = new Map<string, string>();
    const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
        entry === undefined ? '<undefined>' : entry
    )).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (match) => createdIds.get(match) ?? match));
    return { log, createdIds, normalize };
}
export type ReviewRecorder = ReturnType<typeof createReviewRecorder>;

const RECORDED = ['updateTask', 'deleteTask', 'restoreTask', 'addTask', 'batchUpdateTasks', 'batchMoveTasks', 'batchDeleteTasks'] as const;
type Recorded = (typeof RECORDED)[number];
let realActions: Pick<ReturnType<typeof useTaskStore.getState>, Recorded> | null = null;

/** Loads a scenario's data through the store and records the writes, as the harnesses do. */
export async function seedReviewStore(
    part: ReviewFixturePart,
    scenario: ReviewScenario,
    recorder: ReviewRecorder,
    adapter: { saveData?: (data: unknown) => Promise<void> } = {},
): Promise<void> {
    await flushPendingSave();
    resetForTests();
    const initial = useTaskStore.getState();
    realActions ??= Object.fromEntries(RECORDED.map((name) => [name, initial[name]])) as unknown as NonNullable<typeof realActions>;
    const real = realActions!;
    const tasks = scenario.taskIds ? part.tasks.filter((task) => scenario.taskIds!.includes(task.id)) : part.tasks;
    const projects = scenario.projectIds ? part.projects.filter((project) => scenario.projectIds!.includes(project.id)) : part.projects;
    let data = JSON.parse(JSON.stringify({ tasks, projects, sections: [], areas: part.areas, people: [], settings: part.settings[scenario.settings] }));
    setStorageAdapter({
        getData: async () => data,
        saveData: async (next) => {
            await adapter.saveData?.(next);
            data = JSON.parse(JSON.stringify(next));
        },
    });
    useTaskStore.setState({
        ...real,
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    });
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const record = (name: string, args: unknown[]) => { recorder.log.push([name, ...(recorder.normalize(args) as unknown[])]); };
    useTaskStore.setState({
        updateTask: async (id, updates) => { record('updateTask', [id, updates]); return real.updateTask(id, updates); },
        deleteTask: async (id) => { record('deleteTask', [id]); return real.deleteTask(id); },
        restoreTask: async (id) => { record('restoreTask', [id]); return real.restoreTask(id); },
        addTask: async (title, props, options) => {
            record('addTask', [title, props]);
            const result = await real.addTask(title, props, options);
            if (result.id) recorder.createdIds.set(result.id, `<created:${title}>`);
            return result;
        },
        batchUpdateTasks: async (updates) => { record('batchUpdateTasks', [updates]); return real.batchUpdateTasks(updates); },
        batchMoveTasks: async (ids, status) => { record('batchMoveTasks', [ids, status]); return real.batchMoveTasks(ids, status); },
        batchDeleteTasks: async (ids) => { record('batchDeleteTasks', [ids]); return real.batchDeleteTasks(ids); },
    });
}

const ok = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

/** The revision a drawn row showed for a task, as a screen sends it back. */
const rowRevision = (rows: readonly { row: { id: string; taskRevision: string } }[], id: string): string => (
    rows.find((entry) => entry.row.id === id)?.row.taskRevision ?? ''
);
const taskRowsOf = <T extends { type: string }>(items: readonly T[]) => items.flatMap((item) => (
    item.type === 'task' ? [item as unknown as { row: { id: string; taskRevision: string } }] : []
));

let requestCount = 0;
const requestId = () => {
    requestCount += 1;
    return `00000000-0000-4000-8000-${requestCount.toString(16).padStart(12, '0')}`;
};

/** Every page of a windowed view, under one revision. */
function readAll<T extends { revision: string; total: number }, Item>(
    read: (window: { offset: number; limit: number; revision?: string }) => NativeHostResult<T>,
    items: (view: T) => Item[],
): { view: T; items: Item[] } {
    const first = ok(read({ offset: 0, limit: 7 }));
    const all = [...items(first)];
    while (all.length < first.total) all.push(...items(ok(read({ offset: all.length, limit: 7, revision: first.revision }))));
    return { view: first, items: all };
}

/**
 * What the comparison reads. Device storage is compared as what it holds after
 * each step: mobile writes a restored session before correcting its step; the
 * native host stores only the corrected checkpoint.
 */
export function projectObservation(observation: Observation): Observation {
    if (!Array.isArray(observation.storage)) return observation;
    const state: Record<string, string | null> = {};
    for (const [op, key, value] of observation.storage as [string, string, string?][]) {
        if (op === 'set') state[key] = value ?? null;
        if (op === 'remove') state[key] = null;
    }
    return { ...observation, storage: state };
}

// ---------------------------------------------------------------------------
// Review.

async function replayReview(contract: Contract, scenario: ReviewScenario, recorder: ReviewRecorder): Promise<Observation[]> {
    let expandedAreaIds: string[] = [];
    let expandedProjectIds: string[] = [];
    let selected: string[] = [];
    let modal: 'picker' | 'move' | 'tag' | 'removeTags' | 'organize' | null = null;
    let tagInput = '';
    let editor: string | null = null;
    let guidedReview = false;
    const toasts: { toast: NonNullable<NativeReviewActionResult['toast']> }[] = [];
    const alerts: { title: string; message: string; buttons: [string, string][]; confirm: () => Promise<void> }[] = [];
    const pushes: string[] = [];
    const shares: string[] = [];
    const seen = { writes: 0, toasts: 0, alerts: 0, pushes: 0, shares: 0 };

    const read = (edit?: NativeReviewExpansionEdit) => {
        if (edit) {
            // The edit resolves the expansion; the screen keeps what comes back.
            const edited = ok(contract.getReviewOverview({ scope: 'all', expandedAreaIds, expandedProjectIds, selectedIds: selected, expansionEdit: edit, offset: 0, limit: 1 }));
            expandedAreaIds = edited.expandedAreaIds;
            expandedProjectIds = edited.expandedProjectIds;
        }
        return readAll(
            (window) => contract.getReviewOverview({ scope: 'all', expandedAreaIds, expandedProjectIds, selectedIds: selected, ...window }),
            (view: NativeReviewOverview) => view.items,
        );
    };
    const run = async (action: NativeReviewAction) => ok(await contract.runReviewAction({ requestId: requestId(), action }));
    const exitSelection = () => { selected = []; };
    const toggleSelect = (id: string) => {
        selected = selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
    };

    const observe = (): Observation => {
        const { view, items } = read();
        const selection = selected.length > 0 && view.bulk !== null;
        const texts: string[] = [];
        const disabled: [string, boolean][] = [];
        if (!selection) {
            texts.push(view.startReview.label);
            disabled.push([view.expansion.label, view.expansion.disabled]);
        } else {
            texts.push(view.bulk!.countLabel, view.bulk!.cancelLabel, ...view.bulk!.actions.map((action) => action.label));
            disabled.push(...view.bulk!.actions.map((action): [string, boolean] => [action.label, !action.enabled]));
        }
        const headers: unknown[] = [];
        const rows: unknown[] = [];
        items.forEach((item: NativeReviewOverviewItem) => {
            if (item.type === 'task') {
                rows.push([item.row.id, selection, item.selected]);
                return;
            }
            texts.push(item.title, item.summary);
            headers.push(item.type === 'area'
                ? [item.accessibilityLabel, item.expanded, [item.color ?? THEME.tint], [THEME.text, THEME.secondaryText]]
                : [
                    item.accessibilityLabel, item.expanded,
                    item.statusTone ? [THEME[item.statusTone]] : [],
                    [THEME.text, item.summaryTone === 'warning' ? THEME.warning : THEME.secondaryText],
                ]);
        });
        if (view.empty) texts.push(view.empty);
        const bulkLabel = (id: string) => view.bulk?.actions.find((action) => action.id === id)?.label ?? '';
        if (modal === 'picker') texts.push(view.startReview.label, ...view.startReview.options.map((option) => option.label), view.startReview.cancelLabel);
        if (modal === 'move' && view.bulk) {
            texts.push(bulkLabel('moveTo'), ...view.bulk.statuses.map((status) => status.label), view.bulk.cancelLabel);
            disabled.push(...view.bulk.statuses.map((status): [string, boolean] => [status.label, false]));
        }
        if (modal === 'tag' && view.bulk) {
            texts.push(view.bulk.addTag.title, view.bulk.addTag.cancelLabel, view.bulk.addTag.saveLabel);
            disabled.push([view.bulk.addTag.saveLabel, !tagInput.trim()]);
        }
        const observation = {
            texts,
            headers,
            expansion: selection ? null : [view.expansion.label, view.expansion.disabled, view.expansion.allExpanded ? 'Icon:ChevronsUp' : 'Icon:ChevronsDown'],
            rows,
            disabled,
            editor: editor ? [editor, 'view'] : null,
            removeTags: modal === 'removeTags' && view.bulk ? [view.bulk.removeTag.title, view.bulk.removeTag.tags] : null,
            organize: modal === 'organize' ? [selected.length, false] : null,
            guidedReview,
            writes: recorder.log.slice(seen.writes),
            toasts: toasts.slice(seen.toasts).map(({ toast }) => [toast.tone, toast.title, toast.message, toast.undo?.label ?? null]),
            alerts: alerts.slice(seen.alerts).map((alert) => [alert.title, alert.message, alert.buttons]),
            pushes: pushes.slice(seen.pushes),
            shares: shares.slice(seen.shares),
        };
        Object.assign(seen, { writes: recorder.log.length, toasts: toasts.length, alerts: alerts.length, pushes: pushes.length, shares: shares.length });
        return recorder.normalize(observation) as Observation;
    };

    const bulkWrite = async (action: NativeReviewAction) => {
        const result = await run(action);
        if (!result.changed) return;
        exitSelection();
        if (result.toast) toasts.push({ toast: result.toast });
    };

    const perform = async ([kind, target, ...rest]: [string, ...unknown[]]) => {
        const { view, items } = read();
        const header = (title: unknown) => items.find((item) => item.type !== 'task' && item.accessibilityLabel.startsWith(`${String(title)}, `));
        switch (kind) {
            case 'expand':
                read({ type: 'cycle' });
                return;
            case 'area':
            case 'project': {
                const item = header(target)!;
                read({ type: kind === 'area' ? 'toggleArea' : 'toggleProject', id: item.type === 'task' ? '' : item.id });
                return;
            }
            case 'row': {
                const [verb, status] = rest as [string, string?];
                const taskRevision = rowRevision(taskRowsOf(items), String(target));
                if (verb === 'edit') editor = String(target);
                // The row's own toasts belong to the row, which the harness stands in for.
                else if (verb === 'status') await run({ type: 'setTaskStatus', taskId: String(target), status: status as never, taskRevision });
                else await run({ type: 'trashTask', taskId: String(target), taskRevision });
                return;
            }
            case 'longPress':
            case 'select':
                toggleSelect(String(target));
                return;
            case 'type':
                tagInput = String(target);
                return;
            case 'removeTags':
                modal = null;
                await bulkWrite({ type: 'removeTags', taskIds: selected, tags: target as string[], taskRevisions: view.bulk!.taskRevisions });
                return;
            case 'organize':
                await bulkWrite({ type: 'organizeTasks', taskIds: selected, input: target as never, taskRevisions: view.bulk!.taskRevisions });
                modal = null;
                return;
            case 'alert': {
                const alert = alerts[alerts.length - 1];
                if (target === alert.buttons[1][0]) await alert.confirm();
                return;
            }
            case 'toastAction': {
                const undo = toasts[toasts.length - 1].toast.undo!;
                await run(undo.action);
                return;
            }
            case 'press': {
                const bulk = view.bulk;
                const label = String(target);
                if (label === view.startReview.label && !bulk) modal = 'picker';
                else if (modal === 'picker' && label === view.startReview.options[0].label) {
                    modal = null;
                    pushes.push('/daily-review');
                } else if (modal === 'picker' && label === view.startReview.options[1].label) {
                    modal = null;
                    guidedReview = true;
                } else if (label === view.startReview.cancelLabel && !bulk) {
                    modal = null;
                } else if (bulk && label === bulk.cancelLabel) {
                    exitSelection();
                } else if (bulk && modal === 'move' && bulk.statuses.some((status) => status.label === label)) {
                    modal = null;
                    await bulkWrite({
                        type: 'moveTasks', taskIds: selected, status: bulk.statuses.find((status) => status.label === label)!.status, taskRevisions: bulk.taskRevisions,
                    });
                } else if (bulk && modal === 'tag' && label === bulk.addTag.saveLabel) {
                    const tag = tagInput.trim();
                    tagInput = '';
                    modal = null;
                    await bulkWrite({ type: 'addTag', taskIds: selected, tag, taskRevisions: bulk.taskRevisions });
                } else if (bulk) {
                    const action = bulk.actions.find((entry) => entry.label === label)!;
                    if (action.id === 'moveTo') modal = 'move';
                    if (action.id === 'addTag') modal = 'tag';
                    if (action.id === 'removeTag') modal = 'removeTags';
                    if (action.id === 'organize') modal = 'organize';
                    if (action.id === 'share' && bulk.shareText) {
                        shares.push(bulk.shareText);
                        exitSelection();
                    }
                    if (action.id === 'delete') {
                        const ids = [...selected];
                        const taskRevisions = bulk.taskRevisions;
                        const confirmation = bulk.deleteConfirmation;
                        alerts.push({
                            title: confirmation.title,
                            message: confirmation.message,
                            buttons: [[confirmation.cancelLabel, 'cancel'], [confirmation.confirmLabel, 'destructive']],
                            confirm: () => bulkWrite({ type: 'trashTasks', taskIds: ids, taskRevisions }),
                        });
                    }
                } else {
                    throw new Error(`Nothing to press for ${label}`);
                }
                return;
            }
            default:
                throw new Error(`Unknown action ${kind}`);
        }
    };

    const observations = [observe()];
    for (const action of scenario.actions) {
        await perform(action);
        await flushPendingSave();
        observations.push(observe());
    }
    return observations;
}

// ---------------------------------------------------------------------------
// The review wizards' device storage, as the host keeps it.

function createDeviceStorage(initial: Record<string, string> | undefined) {
    const values = new Map(Object.entries(initial ?? {}));
    const log: unknown[][] = [];
    return {
        log,
        get: (key: string) => {
            log.push(['get', key]);
            return values.get(key) ?? null;
        },
        set: (key: string, value: string) => {
            log.push(['set', key, value]);
            values.set(key, value);
        },
        remove: (key: string) => {
            log.push(['remove', key]);
            values.delete(key);
        },
    };
}

const calendarInput = (part: ReviewFixturePart, scenario: ReviewScenario) => (
    scenario.calendar === 'error'
        ? { status: 'error' as const, message: CALENDAR_ERROR }
        : { status: 'ready' as const, events: scenario.calendar === 'none' ? [] : part.calendarEvents }
);

// ---------------------------------------------------------------------------
// Weekly Review.

async function replayWeekly(contract: Contract, part: ReviewFixturePart, scenario: ReviewScenario, recorder: ReviewRecorder): Promise<Observation[]> {
    const storage = createDeviceStorage(scenario.storage);
    let calendar: NativeReviewCalendar = calendarInput(part, scenario);
    let visible = true;
    let checkpoint: string | null = null;
    let expandedProjectId: string | null = null;
    let expandedDays = new Set<string>();
    let expandedContexts = new Set<string>();
    const showScheduled = { waiting: false, someday: false };
    let prompt: { projectId: string; projectTitle: string } | null = null;
    let promptTitle = '';
    let editor: [string, 'view' | 'task'] | null = null;
    const ai = { ran: false, suggestions: [] as TitledReviewSuggestion[], selected: new Set<string>() };
    const captures: unknown[] = [];
    const aiRequests: unknown[] = [];
    let closes = 0;
    const seen = { writes: 0, storage: 0, captures: 0, closes: 0, ai: 0 };

    const read = () => readAll(
        (window) => contract.getWeeklyReview({ checkpoint, calendar, expandedProjectId, ...window }),
        (view: NativeWeeklyReview) => view.items,
    );
    /** A nested list whole: its first window, then the rest under the view's revision. */
    const whole = <T,>(view: NativeWeeklyReview, window: NativeReviewWindow<T>, list: NativeWeeklyReviewList, key?: string): T[] => {
        const all = [...window.items];
        while (all.length < window.total) {
            all.push(...(ok(contract.getWeeklyReviewList({
                checkpoint, calendar, expandedProjectId, list, key, offset: all.length, limit: 7, revision: view.revision,
            })).items as T[]));
        }
        return all;
    };
    /** Every read stores the checkpoint the review now stands on, as mobile saves its session. */
    const settle = () => {
        const result = read();
        if (result.view.checkpoint !== checkpoint) {
            checkpoint = result.view.checkpoint;
            storage.set(result.view.storageKey, checkpoint);
        }
        return result;
    };
    // Mobile opens while the calendar loads, then shows it: a step with no work
    // until then is passed over for good.
    const open = () => {
        const loaded = calendar;
        calendar = { status: 'loading' };
        checkpoint = storage.get(WEEKLY_REVIEW_SESSION_STORAGE_KEY);
        const { view } = read();
        checkpoint = view.checkpoint;
        storage.set(view.storageKey, checkpoint);
        calendar = loaded;
    };
    const moveTo = (next: string | null) => {
        if (next === null) return;
        checkpoint = next;
        storage.set(WEEKLY_REVIEW_SESSION_STORAGE_KEY, next);
    };
    const run = async (action: NativeReviewAction) => ok(await contract.runReviewAction({ requestId: requestId(), action }));
    const close = () => {
        expandedDays = new Set();
        expandedContexts = new Set();
        closes += 1;
        visible = false;
    };

    const layout = (view: NativeWeeklyReview, items: NativeWeeklyReviewItem[]) => {
        const { labels, content } = view;
        const texts: string[] = [view.step.title, view.step.indicator];
        view.rail.forEach((step) => texts.push(...(step.state === 'complete' ? [step.title] : [String(step.number), step.title])));
        const rows: string[] = [];
        const projects: unknown[] = [];
        const suggestionChecks: boolean[] = [];
        const tasks = items.filter((item): item is Extract<NativeWeeklyReviewItem, { type: 'task' }> => item.type === 'task');
        /** RN's renderProjectEntry (Projects and Stale): the card, then its rows and Open project while expanded (rows keep their own list). */
        const projectCards = () => items.forEach((item) => {
            if (item.type === 'project') {
                texts.push(item.title, labels.addTask, item.badge.label, item.countLabel, item.expanded ? '▾' : '▸');
                if (item.expanded) texts.push(item.openLabel);
                projects.push([item.areaColor ?? THEME.tint, item.badge.background, item.badge.color]);
            } else if (item.type === 'task') rows.push(item.row.id);
        });
        if (content.step === 'inbox') {
            if (content.countLabel) texts.push(content.countLabel, labels.inboxHint, labels.processInbox);
            texts.push(labels.mindSweep);
            if (content.empty) texts.push(content.empty);
            rows.push(...tasks.map((item) => item.row.id));
        } else if (content.step === 'stale') {
            texts.push(labels.stale, labels.staleDesc);
            projectCards();
            whole(view, content.projects, 'staleProjects').forEach((item) => texts.push(item.title, item.daysLabel));
            if (content.ai.enabled) {
                texts.push(labels.aiDesc, labels.aiRun);
                if (ai.ran && ai.suggestions.length === 0) texts.push(labels.aiEmpty);
                ai.suggestions.forEach((suggestion) => {
                    const label = suggestion.action === 'someday' ? labels.aiActionSomeday
                        : suggestion.action === 'archive' ? labels.aiActionArchive
                            : suggestion.action === 'breakdown' ? labels.aiActionBreakdown : labels.aiActionKeep;
                    texts.push(suggestion.title, `${label} · ${suggestion.reason}`);
                    suggestionChecks.push(ai.selected.has(suggestion.id));
                });
                if (ai.suggestions.length > 0) texts.push(`${labels.aiApply} (${ai.selected.size})`);
            }
        } else if (content.step === 'calendar') {
            texts.push(labels.calendar, labels.addTask, labels.calendarDesc, labels.calendarUpcoming);
            if (content.notice !== null) texts.push(content.notice);
            else {
                content.days.forEach((day) => {
                    const expanded = expandedDays.has(day.key);
                    texts.push(day.title);
                    const events = whole(view, day.events, 'dayEvents', day.key);
                    (expanded ? events : events.slice(0, day.previewCount)).forEach((event) => texts.push(event.timeLabel, event.title));
                    if (day.moreLabel) texts.push(expanded ? labels.less : day.moreLabel);
                });
            }
            texts.push(labels.calendarTasks);
            if (content.tasksEmpty) texts.push(content.tasksEmpty);
            content.tasks.forEach((task) => texts.push(task.title, task.meta));
        } else if (content.step === 'waiting' || content.step === 'someday') {
            texts.push(...(content.step === 'waiting' ? [labels.waitingDesc, labels.waitingGuide] : [labels.somedayDesc, labels.somedayGuide]));
            if (content.empty) texts.push(content.empty);
            else {
                const expanded = showScheduled[content.step];
                rows.push(...tasks.filter((item) => !item.scheduled || expanded).map((item) => item.row.id));
                if (content.scheduled) texts.push(content.scheduled.label);
            }
        } else if (content.step === 'contexts') {
            texts.push(labels.contexts, labels.contextsDesc);
            if (content.empty) texts.push(content.empty);
            items.forEach((item) => {
                if (item.type !== 'context') return;
                const expanded = expandedContexts.has(item.context);
                const contextTasks = whole(view, item.tasks, 'contextTasks', item.context);
                texts.push(item.context, String(item.tasks.total));
                (expanded ? contextTasks : contextTasks.slice(0, content.previewCount)).forEach((task) => texts.push(task.title));
                if (item.moreLabel) texts.push(expanded ? labels.less : item.moreLabel);
            });
        } else if (content.step === 'projects') {
            texts.push(labels.projectsDesc, labels.projectsGuide);
            if (content.empty) texts.push(content.empty);
            projectCards();
        } else if (content.step === 'completed') {
            texts.push(labels.reviewComplete, labels.completeDesc);
            if (content.week) texts.push(content.week.heading, ...content.week.rows);
            texts.push(...content.checks.map((check) => check.text), labels.mindSweepTitle, labels.mindSweepIntro, labels.mindSweep);
        }
        texts.push(...(view.finish ? [view.finish.shareLabel, view.finish.label] : [`← ${view.back.label}`, `${view.next!.label} →`]));
        if (prompt) texts.push(labels.addTask, prompt.projectTitle, labels.cancel, labels.saveAndEdit, labels.add);
        return { texts, rows, projects, suggestionChecks };
    };

    const observe = (): Observation => {
        let shown: Observation = { texts: [], rail: [], progress: null, rows: [], backDisabled: null, projects: [], suggestions: [], editor: null, sheets: [] };
        if (visible) {
            const { view, items } = settle();
            const { texts, rows, projects, suggestionChecks } = layout(view, items);
            shown = {
                texts,
                rail: view.rail.map((step) => [step.title, step.state]),
                progress: `${view.step.progress}%`,
                rows,
                backDisabled: view.finish ? null : view.back.checkpoint === null,
                projects,
                suggestions: suggestionChecks,
                editor,
                sheets: [],
            };
        }
        const observation = {
            ...shown,
            writes: recorder.log.slice(seen.writes),
            storage: storage.log.slice(seen.storage),
            captures: captures.slice(seen.captures),
            closes: closes - seen.closes,
            aiRequests: aiRequests.slice(seen.ai),
        };
        Object.assign(seen, { writes: recorder.log.length, storage: storage.log.length, captures: captures.length, closes, ai: aiRequests.length });
        return recorder.normalize(observation) as Observation;
    };

    const submitProjectTask = async (openEditor: boolean) => {
        if (!promptTitle.trim() || !prompt) return;
        const result = await run({ type: 'addProjectTask', projectId: prompt.projectId, title: promptTitle });
        prompt = null;
        promptTitle = '';
        if (openEditor && result.createdId) editor = [result.createdId, 'task'];
    };

    const perform = async ([kind, target, ...rest]: [string, ...unknown[]]) => {
        const { view, items } = read();
        const label = String(target);
        switch (kind) {
            case 'next':
                moveTo(view.next!.checkpoint);
                return;
            case 'back':
                moveTo(view.back.checkpoint);
                return;
            case 'close':
                close();
                return;
            case 'reopen':
                visible = true;
                open();
                return;
            case 'project': {
                const project = items.find((item) => item.type === 'project' && item.title === target) as Extract<NativeWeeklyReviewItem, { type: 'project' }>;
                expandedProjectId = expandedProjectId === project.id ? null : project.id;
                return;
            }
            case 'projectAddTask': {
                const project = items.find((item) => item.type === 'project' && item.title === target) as Extract<NativeWeeklyReviewItem, { type: 'project' }>;
                prompt = { projectId: project.id, projectTitle: project.title };
                promptTitle = '';
                return;
            }
            case 'type':
                promptTitle = label;
                return;
            case 'submit':
                await submitProjectTask(false);
                return;
            case 'row': {
                const [verb, status] = rest as [string, string?];
                const taskRevision = rowRevision(taskRowsOf(items), label);
                if (verb === 'edit') editor = [label, 'view'];
                else if (verb === 'status') await run({ type: 'setTaskStatus', taskId: label, status: status as never, taskRevision });
                else await run({ type: 'trashTask', taskId: label, taskRevision });
                return;
            }
            case 'closeEditor':
                editor = null;
                return;
            case 'contextTask': {
                const task = items.flatMap((item) => (item.type === 'context' ? whole(view, item.tasks, 'contextTasks', item.context) : []))
                    .find((entry) => entry.title === target)!;
                editor = [task.id, 'view'];
                return;
            }
            case 'suggestion': {
                const suggestion = ai.suggestions.find((entry) => entry.title === target)!;
                if (!isActionableReviewSuggestion(suggestion)) return;
                if (ai.selected.has(suggestion.id)) ai.selected.delete(suggestion.id);
                else ai.selected.add(suggestion.id);
                return;
            }
            case 'press': {
                const { labels, content } = view;
                if (content.step === 'calendar' && (label === labels.less || content.days.some((day) => day.moreLabel === label))) {
                    const day = content.days.find((entry) => (label === labels.less ? expandedDays.has(entry.key) : !expandedDays.has(entry.key) && entry.moreLabel === label))!;
                    expandedDays = new Set(expandedDays.has(day.key) ? [...expandedDays].filter((key) => key !== day.key) : [...expandedDays, day.key]);
                } else if (content.step === 'contexts' && (label === labels.less || items.some((item) => item.type === 'context' && item.moreLabel === label))) {
                    const context = items.find((item) => item.type === 'context'
                        && (label === labels.less ? expandedContexts.has(item.context) : !expandedContexts.has(item.context) && item.moreLabel === label));
                    const key = (context as Extract<NativeWeeklyReviewItem, { type: 'context' }>).context;
                    expandedContexts = new Set(expandedContexts.has(key) ? [...expandedContexts].filter((entry) => entry !== key) : [...expandedContexts, key]);
                } else if ((content.step === 'waiting' || content.step === 'someday') && label === content.scheduled?.label) {
                    showScheduled[content.step] = !showScheduled[content.step];
                } else if (content.step === 'calendar' && label === labels.addTask) {
                    captures.push({ initialProps: { status: 'inbox' } });
                } else if (view.finish && label === view.finish.label) {
                    storage.set(view.finish.lastReviewKey, view.finish.lastReviewAt);
                    storage.remove(view.storageKey);
                    checkpoint = null;
                    close();
                } else if (prompt && label === labels.add) {
                    await submitProjectTask(false);
                } else if (prompt && label === labels.saveAndEdit) {
                    await submitProjectTask(true);
                } else if (prompt && label === labels.cancel) {
                    prompt = null;
                    promptTitle = '';
                } else if (content.step === 'stale' && label === labels.aiRun) {
                    ai.ran = true;
                    const aiItems = whole(view, content.ai.items, 'aiItems');
                    if (aiItems.length === 0) {
                        ai.suggestions = [];
                        ai.selected = new Set();
                        return;
                    }
                    aiRequests.push({ items: aiItems });
                    ai.suggestions = filterReviewSuggestions(part.aiSuggestions ?? [], aiItems);
                    ai.selected = new Set(ai.suggestions.filter(isActionableReviewSuggestion).map((suggestion) => suggestion.id));
                } else if (content.step === 'stale' && label === `${labels.aiApply} (${ai.selected.size})`) {
                    const chosen = ai.suggestions.filter((suggestion) => ai.selected.has(suggestion.id));
                    // Each actionable suggestion's task, at the revision the step's row shows.
                    const taskRevisions = Object.fromEntries(chosen.filter(isActionableReviewSuggestion).map((suggestion) => (
                        [suggestion.id, rowRevision(taskRowsOf(items), suggestion.id)]
                    )));
                    if (chosen.some(isActionableReviewSuggestion)) await run({ type: 'applySuggestions', suggestions: chosen, taskRevisions });
                } else {
                    throw new Error(`Nothing to press for ${label}`);
                }
                return;
            }
            default:
                throw new Error(`Unknown action ${kind}`);
        }
    };

    open();
    const observations = [observe()];
    for (const action of scenario.actions) {
        await perform(action);
        await flushPendingSave();
        observations.push(observe());
    }
    return observations;
}

// ---------------------------------------------------------------------------
// Daily Review.

async function replayDaily(contract: Contract, part: ReviewFixturePart, scenario: ReviewScenario, recorder: ReviewRecorder): Promise<Observation[]> {
    const storage = createDeviceStorage(scenario.storage);
    let calendar: NativeReviewCalendar = calendarInput(part, scenario);
    let mounted = true;
    let checkpoint: string | null = null;
    let calendarExpanded = true;
    let editor: string | null = null;
    let closes = 0;
    const fetches: unknown[] = [];
    const seen = { writes: 0, storage: 0, closes: 0, fetches: 0 };

    const read = () => readAll(
        (window) => contract.getDailyReview({ checkpoint, calendar, ...window }),
        (view: NativeDailyReview) => view.items,
    );
    const settle = () => {
        const result = read();
        if (result.view.checkpoint !== checkpoint) {
            checkpoint = result.view.checkpoint;
            storage.set(result.view.storageKey, checkpoint);
        }
        return result;
    };
    const mount = () => {
        mounted = true;
        calendarExpanded = true;
        editor = null;
        const range = getReviewCalendarRange(getReviewDay(new Date()), 2);
        fetches.push([range.start.toISOString(), range.end.toISOString()]);
        const loaded = calendar;
        calendar = { status: 'loading' };
        checkpoint = storage.get(DAILY_REVIEW_SESSION_STORAGE_KEY);
        const { view } = read();
        checkpoint = view.checkpoint;
        storage.set(view.storageKey, checkpoint);
        calendar = loaded;
    };
    const moveTo = (next: string | null) => {
        if (next === null) return;
        checkpoint = next;
        storage.set(DAILY_REVIEW_SESSION_STORAGE_KEY, next);
    };
    const run = async (action: NativeReviewAction) => ok(await contract.runReviewAction({ requestId: requestId(), action }));

    const observe = (): Observation => {
        let shown: Observation = { texts: [], rows: [], footer: null, calendarExpanded: null, editor: null, inboxProcessing: false };
        if (mounted) {
            const { view, items } = settle();
            const { content } = view;
            const texts = [view.title, view.step.title, view.step.label];
            if (content.step === 'completed') texts.push(view.step.description);
            else {
                texts.push(`${content.count} ${content.unit}`, view.step.description);
                if (content.step === 'today') {
                    texts.push(content.calendar.label, String(content.calendar.count));
                    if (calendarExpanded) {
                        content.calendar.days.forEach((day) => {
                            texts.push(day.title);
                            if (day.notice !== null) texts.push(day.notice);
                            day.events.forEach((event) => texts.push(event.title, event.timeLabel));
                        });
                    }
                }
                if (content.step === 'inbox' && content.processLabel) texts.push(content.processLabel);
                if (content.empty) texts.push(content.empty);
            }
            texts.push(...(view.finish ? [view.finish.label] : [view.back!.label, view.next!.label]));
            shown = {
                texts,
                rows: items.map((item) => [
                    item.row.id, item.showFocusToggle, item.hideStatusBadge,
                    item.followUp ? [item.followUp.due, item.followUp.accessibilityLabel] : null,
                ]),
                footer: view.finish ? [[view.finish.label, false]] : [[view.back!.label, view.back!.checkpoint === null], [view.next!.label, false]],
                calendarExpanded: content.step === 'today' ? calendarExpanded : null,
                editor: editor ? [editor, 'view'] : null,
                inboxProcessing: false,
            };
        }
        const observation = {
            ...shown,
            writes: recorder.log.slice(seen.writes),
            storage: storage.log.slice(seen.storage),
            closes: closes - seen.closes,
            pushes: [],
            fetches: fetches.slice(seen.fetches),
        };
        Object.assign(seen, { writes: recorder.log.length, storage: storage.log.length, closes, fetches: fetches.length });
        return recorder.normalize(observation) as Observation;
    };

    const perform = async ([kind, target, ...rest]: [string, ...unknown[]]) => {
        const { view, items } = read();
        switch (kind) {
            case 'next':
                moveTo(view.next!.checkpoint);
                return;
            case 'back':
                moveTo(view.back!.checkpoint);
                return;
            case 'close':
                closes += 1;
                mounted = false;
                return;
            case 'reopen':
                mount();
                return;
            case 'press':
                if (view.content.step === 'today' && target === view.content.calendar.label) calendarExpanded = !calendarExpanded;
                else if (view.finish && target === view.finish.label) {
                    storage.remove(view.storageKey);
                    checkpoint = null;
                    closes += 1;
                    mounted = false;
                } else throw new Error(`Nothing to press for ${String(target)}`);
                return;
            case 'row': {
                const [verb, status] = rest as [string, string?];
                const taskRevision = rowRevision(items, String(target));
                if (verb === 'edit') editor = String(target);
                else if (verb === 'status') await run({ type: 'setTaskStatus', taskId: String(target), status: status as never, taskRevision });
                else await run({ type: 'trashTask', taskId: String(target), taskRevision });
                return;
            }
            case 'followUp': {
                const item = items.find((entry) => entry.row.id === target);
                if (item?.followUp && !item.followUp.due) await run({ type: 'followUpToday', taskId: String(target), taskRevision: item.row.taskRevision });
                return;
            }
            case 'editorSave': {
                // The editor is its own contract; its save closes it.
                const updates = target as { title: string };
                const task = useTaskStore.getState()._tasksById.get(editor!)!;
                ok(await contract.updateTask({ id: task.id, base: { title: task.title }, patch: { title: updates.title }, requestId: requestId() }));
                editor = null;
                return;
            }
            default:
                throw new Error(`Unknown action ${kind}`);
        }
    };

    mount();
    const observations = [observe()];
    for (const action of scenario.actions) {
        await perform(action);
        await flushPendingSave();
        observations.push(observe());
    }
    return observations;
}

/** Replays one scenario of one part through the native host contract. */
export function replayReviewScenario(options: {
    part: ReviewPart;
    fixture: ReviewFixturePart;
    scenario: ReviewScenario;
    recorder: ReviewRecorder;
    contract: Contract;
}): Promise<Observation[]> {
    const { part, fixture, scenario, recorder, contract } = options;
    if (part === 'review') return replayReview(contract, scenario, recorder);
    if (part === 'weeklyReview') return replayWeekly(contract, fixture, scenario, recorder);
    return replayDaily(contract, fixture, scenario, recorder);
}
