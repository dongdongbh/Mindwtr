import {
    buildAndroidWidgetPublication,
    getFocusWidgetFilter,
    isSandboxMode,
    logInfo,
    logWarn,
    resolveLanguageFromLocale,
    resolveWidgetLanguage,
    setFocusWidgetFilter,
    useTaskStore,
    WIDGET_FOCUS_AVAILABLE_LIST_ID,
    type FilterCriteria,
    type Language,
    type SortField,
    type WidgetSystemColorScheme,
} from '@mindwtr/core';


export type WidgetInputs = {
    systemColorScheme: WidgetSystemColorScheme;
    systemLocale: string;
    listSelections: string[];

    language?: Language;

    stale?: boolean;
};


export type WidgetBridge = {

    ready(): boolean;
    inputs(): WidgetInputs;
    publish(payload: string): void;

    storedLanguage(): string | null;

    active(): boolean;
};


const PUBLISH_DELAY_MS = 1_000;


const FOREGROUND_MIN_INTERVAL_MS = 5 * 60_000;


export const createWidgetPublisher = (bridge: WidgetBridge) => {
    let last: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let due = 0;

    let storeChangePending = false;
    let lastStoreRefreshAt = 0;


    let lastBuild: unknown[] | null = null;
    const publish = (): boolean => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (storeChangePending) lastStoreRefreshAt = Date.now();
        storeChangePending = false;
        if (isSandboxMode()) return false;
        const state = useTaskStore.getState();
        const input = bridge.inputs();
        const focusFilter = getFocusWidgetFilter();
        const built = [state._allTasks, state._allProjects, state._allSections, state._allAreas, state.settings, JSON.stringify(input),
            bridge.storedLanguage(), focusFilter, Math.floor(Date.now() / 60_000)];
        if (!input.stale && lastBuild && built.every((value, index) => value === lastBuild![index])) return false;
        if (!bridge.ready()) return false;
        const data = { tasks: state._allTasks, projects: state._allProjects, sections: state._allSections, areas: state._allAreas, settings: state.settings ?? {} };
        const language = input.language ?? resolveWidgetLanguage(bridge.storedLanguage(), data.settings.language, resolveLanguageFromLocale(input.systemLocale));
        const publication = buildAndroidWidgetPublication(data, language, {
            systemColorScheme: input.systemColorScheme,
            focusFilter,
            systemLocale: input.systemLocale,
            listSelections: input.listSelections,
        });
        const payload = JSON.stringify(publication);
        if (payload === last && !input.stale) { lastBuild = built; return false; }
        bridge.publish(payload);
        last = payload;
        lastBuild = built;
        logInfo('Widget list presentation published', {
            scope: 'widget', force: true,
            context: { releaseCheck: 'v1.3.8/widget-list-presentation',
                lists: Object.values(publication.lists).filter((list) => list.sections?.length).length },
        });
        logInfo('Android widget context and tag snapshots published', {
            scope: 'widget', force: true,
            context: {
                releaseCheck: 'v1.3.7/widget-context-selection', count: (publication.contexts?.length ?? 0) + (publication.tags?.length ?? 0),

                lists: Object.keys(publication.lists).filter((id) => /^(context|tag|filter):/.test(id)).length,
            },
        });
        logInfo('Widget lists published from one snapshot', {
            scope: 'widget',
            force: true,
            context: { releaseCheck: 'v1.3.8/widget-snapshot-rollover', platform: 'android', count: publication.lists.upcoming?.items.length ?? 0 },
        });

        const available = publication.lists[WIDGET_FOCUS_AVAILABLE_LIST_ID];
        if (available) logInfo('Focus widget available actions published', {
            scope: 'widget',
            force: true,
            context: { releaseCheck: 'v1.3.8/widget-focus-available', platform: 'android',
                count: available.sections?.find((section) => section.key === 'available')?.items.length ?? 0, totalItems: available.totalCount },
        });
        logInfo('Native Android widget payload published', {
            scope: 'widget',
            context: { items: publication.items.length, language, scheme: input.systemColorScheme, locale: input.systemLocale, count: input.listSelections.length },
        });
        return true;
    };


    const schedule = (delayMs: number) => {
        const at = Date.now() + delayMs;
        if (timer !== null) {
            if (at >= due) return;
            clearTimeout(timer);
        }
        due = at;
        timer = setTimeout(() => {
            timer = null;
            try { publish(); } catch (error) { logWarn('Native Android widget publication failed', { scope: 'widget', error }); }
        }, delayMs);
    };

    const storeChangeDelay = () => (bridge.active()
        ? Math.min(Math.max(lastStoreRefreshAt + FOREGROUND_MIN_INTERVAL_MS - Date.now(), PUBLISH_DELAY_MS), FOREGROUND_MIN_INTERVAL_MS)
        : PUBLISH_DELAY_MS);

    useTaskStore.subscribe((state, previous) => {

        if (state.settings?.gtd?.focusIncludeStartDates !== previous.settings?.gtd?.focusIncludeStartDates) {
            storeChangePending = true;
            schedule(PUBLISH_DELAY_MS);
        } else if (state.lastDataChangeAt !== previous.lastDataChangeAt || state.settings !== previous.settings) {
            storeChangePending = true;
            schedule(storeChangeDelay());
        }
    });

    return {
        publish,


        flush(): boolean {
            if (timer === null && !storeChangePending && !bridge.inputs().stale) return false;
            return publish();
        },


        focusFilter(filter: { criteria: FilterCriteria; sortBy: SortField; sortOrder: 'asc' | 'desc' | null } | undefined) {
            if (filter && setFocusWidgetFilter({ criteria: filter.criteria, sortBy: filter.sortBy, sortOrder: filter.sortOrder ?? undefined })) schedule(PUBLISH_DELAY_MS);
        },
    };
};
