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
    type FilterCriteria,
    type Language,
    type SortField,
    type WidgetSystemColorScheme,
} from '@mindwtr/core';

/** What the publication reads from the device (HostWidgets.kt): what RN's widget service reads from React Native. */
export type WidgetInputs = {
    systemColorScheme: WidgetSystemColorScheme;
    systemLocale: string;
    listSelections: string[];
    /** Debug builds only (check-widgets-device.mjs): the widgets' language, in place of the app's. */
    language?: Language;
    /** True when the last publication handed over was not stored and drawn (it failed): it is sent again even if unchanged. */
    stale?: boolean;
};

/** Kotlin's half of RN's widget module (HostWidgets.kt): the device's inputs, and setPayload + updateWidgets in one call. */
export type WidgetBridge = {
    /** True once the boot's validated load finished: before it the store is empty, and an empty payload would blank the widgets. */
    ready(): boolean;
    inputs(): WidgetInputs;
    publish(payload: string): void;
    /** The language chosen in the app (RN's `mindwtr-language`), as the host last passed it to setLanguage; null for none. */
    storedLanguage(): string | null;
    /** True while the app is in front (RN's AppState "active"). */
    active(): boolean;
};

/**
 * Store changes arrive in bursts (a sync, a bulk edit); one publication covers them. RN coalesces its widget refresh after a
 * save the same way (storage-adapter.ts, one second).
 */
const PUBLISH_DELAY_MS = 1_000;
/**
 * RN's widget refresh after a save (storage-adapter.ts, #766: a redraw costs seconds on mid-range phones): while the app is in
 * front, at most once per five minutes; leaving the app publishes at once (the host's background refresh), as RN flushes it.
 */
const FOREGROUND_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * RN's widget service on the engine: core builds the whole Android payload (buildAndroidWidgetPublication) from the store, with
 * the device's inputs and the device language passed every time (QuickJS cannot detect either), and Kotlin writes it where RN's
 * module reads it and redraws the widgets. A store change publishes after a short delay (at most once per five minutes while the
 * app is in front, as RN); the host publishes at once after its boot, after a CoreWork job and when the app comes to the front,
 * and flushes a waiting change when the app leaves (RN publishes on resume and flushes on leaving). A payload equal to the last one is
 * not sent again, unless Kotlin says that one never reached the widgets.
 */
export const createWidgetPublisher = (bridge: WidgetBridge) => {
    let last: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let due = 0;
    // RN's throttle counts from its last save-driven refresh: a store change waiting is published with this one.
    let storeChangePending = false;
    let lastStoreRefreshAt = 0;

    const publish = (): boolean => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (storeChangePending) lastStoreRefreshAt = Date.now();
        storeChangePending = false;
        if (isSandboxMode() || !bridge.ready()) return false;
        const state = useTaskStore.getState();
        const data = { tasks: state._allTasks, projects: state._allProjects, sections: state._allSections, areas: state._allAreas, settings: state.settings ?? {} };
        const input = bridge.inputs();
        const language = input.language ?? resolveWidgetLanguage(bridge.storedLanguage(), data.settings.language, resolveLanguageFromLocale(input.systemLocale));
        const publication = buildAndroidWidgetPublication(data, language, {
            systemColorScheme: input.systemColorScheme,
            focusFilter: getFocusWidgetFilter(),
            systemLocale: input.systemLocale,
            listSelections: input.listSelections,
        });
        const payload = JSON.stringify(publication);
        if (payload === last && !input.stale) return false;
        bridge.publish(payload);
        last = payload;
        logInfo('Android widget context and tag snapshots published', {
            scope: 'widget', force: true,
            context: {
                releaseCheck: 'v1.3.7/widget-context-selection', count: (publication.contexts?.length ?? 0) + (publication.tags?.length ?? 0),
                // Lists built for placed widgets' context, tag and saved-filter choices only.
                lists: Object.keys(publication.lists).filter((id) => /^(context|tag|filter):/.test(id)).length,
            },
        });
        logInfo('Widget lists published from one snapshot', {
            scope: 'widget',
            force: true,
            context: { releaseCheck: 'v1.3.8/widget-snapshot-rollover', platform: 'android', count: publication.lists.upcoming?.items.length ?? 0 },
        });
        logInfo('Native Android widget payload published', {
            scope: 'widget',
            context: { items: publication.items.length, language, scheme: input.systemColorScheme, locale: input.systemLocale, count: input.listSelections.length },
        });
        return true;
    };

    /** Publishes in [delayMs], or sooner if a publication is already due sooner. */
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
    // RN's computeThrottledDelayMs while in front; its one-second coalesce otherwise.
    const storeChangeDelay = () => (bridge.active()
        ? Math.min(Math.max(lastStoreRefreshAt + FOREGROUND_MIN_INTERVAL_MS - Date.now(), PUBLISH_DELAY_MS), FOREGROUND_MIN_INTERVAL_MS)
        : PUBLISH_DELAY_MS);

    useTaskStore.subscribe((state, previous) => {
        // RN's Focus start-date setting republishes at once (its own listener, use-root-layout-sync-effects.ts).
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
        /**
         * Leaving the app (ProcessCoreHost's "background"): RN flushes a refresh still waiting. With none waiting, and the last
         * publication stored and drawn, nothing is built: the whole payload costs about 300 ms of the engine at 5,000 tasks,
         * right when a leave-time sync starts its read.
         */
        flush(): boolean {
            if (timer === null && !storeChangePending && !bridge.inputs().stale) return false;
            return publish();
        },
        /**
         * The Focus screen's current filter and sort (core's `controls.widgetFilter`), as RN's Focus screen hands it to
         * setFocusWidgetFilter: a change republishes at once, as RN's Focus screen does. Core's null sortOrder is RN's absent one.
         */
        focusFilter(filter: { criteria: FilterCriteria; sortBy: SortField; sortOrder: 'asc' | 'desc' | null } | undefined) {
            if (filter && setFocusWidgetFilter({ criteria: filter.criteria, sortBy: filter.sortBy, sortOrder: filter.sortOrder ?? undefined })) schedule(PUBLISH_DELAY_MS);
        },
    };
};
