import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSandboxMode, type AppData, type Language, useTaskStore } from '@mindwtr/core';
import * as ReactNativeWidgetKit from 'react-native-widgetkit';

import * as AndroidWidget from '../modules/android-widget';
import {
    type AndroidTasksWidgetPayload,
    buildAndroidQuickCaptureLabels,
    buildAndroidTaskPeekLabels,
    buildShortcutsSnapshot,
    buildWidgetPayload,
    createWidgetPayloadProjection,
    IOS_SHORTCUTS_SNAPSHOT_KEY,
    IOS_WIDGET_APP_GROUP,
    IOS_WIDGET_KIND,
    IOS_WIDGET_COMPACT_KIND,
    IOS_WIDGET_LOCK_KIND,
    IOS_WIDGET_PAYLOAD_KEY,
    IOS_WIDGET_PAYLOAD_KEY_EXTRA_LARGE,
    IOS_WIDGET_PAYLOAD_KEY_LARGE,
    IOS_WIDGET_PAYLOAD_KEY_MEDIUM,
    IOS_WIDGET_PAYLOAD_KEY_SMALL,
    resolveWidgetLanguage,
    type ShortcutsSnapshot,
    type TasksWidgetPayload,
    type WidgetPayloadBuildOptions,
    type WidgetPayloadProjection,
    WIDGET_LANGUAGE_KEY,
} from './widget-data';
import { WIDGET_FIXED_LIST_IDS } from './widget-lists';
import { focusWidgetFilterKey, getFocusWidgetFilter } from './focus-widget-filter';
import { logError, logInfo, logWarn } from './app-log';
import { getLocalDayKey } from '@/hooks/use-local-day-key';
import { getSystemColorSchemeForWidget } from './system-color-scheme';

export function isAndroidWidgetSupported(): boolean {
    return !isSandboxMode() && Platform.OS === 'android';
}

export function isIosWidgetSupported(): boolean {
    return !isSandboxMode() && Platform.OS === 'ios';
}

type IosWidgetApi = {
    setItem: (key: string, value: string, appGroup: string) => Promise<void>;
    reloadTimelines?: (ofKind: string) => void;
    reloadAllTimelines?: () => void;
};

// iOS widget families are fixed presets (Apple does not allow user resizing),
// so ship an explicit item budget per size instead of guessing from a height.
// The Swift view re-caps to what actually fits the rendered widget; these are
// the upper bounds it draws from. extraLarge (iPad) renders two columns.
const IOS_WIDGET_FAMILY_MAX_ITEMS = {
    default: 12,
    small: 3,
    medium: 5,
    large: 12,
    extraLarge: 24,
} as const;

async function getIosWidgetApi(): Promise<IosWidgetApi | null> {
    if (Platform.OS !== 'ios') return null;
    if (typeof ReactNativeWidgetKit.setItem === 'function') {
        return ReactNativeWidgetKit as IosWidgetApi;
    }
    if (__DEV__) {
        void logWarn('[RNWidget] iOS widget API unavailable', {
            scope: 'widget',
            extra: { error: 'react-native-widgetkit setItem unavailable' },
        });
    }
    return null;
}

async function resolvePayloadLanguage(data: AppData): Promise<Language> {
    const languageValue = await AsyncStorage.getItem(WIDGET_LANGUAGE_KEY);
    return resolveWidgetLanguage(languageValue, data.settings?.language);
}

// Which lists the Android payload carries. The widget's own header chooser
// switches lists with no app running, so it can only show a list the payload
// already holds: once any Tasks widget is placed, all five GTD lists ride
// along and switching between them is instant. A project list is still built
// only when a widget asks for it, so picking one shows its name and fills in
// on the next publish (#1173).
function androidWidgetListIds(): string[] {
    const selections = AndroidWidget.getWidgetListSelections();
    return selections.length === 0 ? [] : [...WIDGET_FIXED_LIST_IDS, ...selections];
}

function widgetPayloadOptions(): Omit<WidgetPayloadBuildOptions, 'maxItems'> {
    return {
        systemColorScheme: getSystemColorSchemeForWidget(),
        // The widget's Focus list shows what the Focus screen shows, so it
        // rides the screen's current filter and sort (#1173).
        focusFilter: getFocusWidgetFilter(),
        // Only the lists placed Android widgets asked for are built (#1173);
        // folding them in here also puts them in the render fingerprint.
        ...(Platform.OS === 'android' && AndroidWidget.isSupported() ? { listIds: androidWidgetListIds() } : {}),
        // Edit Widget can switch lists while the app is not running. Carry the
        // bounded chooser's lists in each family snapshot, not just Focus.
        ...(Platform.OS === 'ios' ? {
            listIds: WIDGET_FIXED_LIST_IDS,
            includeSavedFilterLists: true,
        } : {}),
    };
}

function buildPayloadFromData(
    data: AppData,
    language: Language,
    maxItems?: number,
): TasksWidgetPayload {
    return buildWidgetPayload(data, language, {
        ...widgetPayloadOptions(),
        maxItems,
    });
}

function createPayloadProjectionFromData(data: AppData, language: Language): WidgetPayloadProjection {
    return createWidgetPayloadProjection(data, language, widgetPayloadOptions());
}

// The native widget's task list scrolls (RemoteViewsService), so the payload
// carries a fixed slice instead of a per-widget-height budget.
const ANDROID_WIDGET_MAX_ITEMS = 20;
const ANDROID_WIDGET_RELEASE_CHECK = 'v1.3.0/android-native-widget';
const ANDROID_WIDGET_PROVIDER_COMPAT_RELEASE_CHECK = 'v1.3.0/android-widget-provider-compat';
const WIDGET_FOCUS_TODAY_RELEASE_CHECK = 'v1.3.0/widget-focus-today';
let androidWidgetUnavailableLogged = false;

function capWidgetSections(
    sections: TasksWidgetPayload['sections'] | undefined,
    maxItems: number,
): TasksWidgetPayload['sections'] | undefined {
    if (!sections) return undefined;
    let remaining = maxItems;
    const capped: TasksWidgetPayload['sections'] = [];
    for (const section of sections) {
        if (remaining <= 0) break;
        const items = section.items.slice(0, remaining);
        if (items.length === 0) continue;
        capped.push({ ...section, items });
        remaining -= items.length;
    }
    return capped;
}

// `rendered` is built at the Android publication cap. The broader fingerprint
// below still detects changes in chooser lists, but reusing its 50-row payload
// here would make the published subtitle claim that no rows were hidden after
// this path sliced the native payload to 20.
async function updateAndroidWidgetsFromData(rendered: TasksWidgetPayload, language: Language, audioEnabled: boolean): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    // Expo Go does not link modules/android-widget. Say so once, then stay quiet.
    if (!AndroidWidget.isSupported()) {
        if (!androidWidgetUnavailableLogged) {
            androidWidgetUnavailableLogged = true;
            void logInfo('Android widget module unavailable in this build; skipping updates', { scope: 'widget' });
        }
        return false;
    }

    try {
        const payload: AndroidTasksWidgetPayload = {
            ...rendered,
            items: rendered.items.slice(0, ANDROID_WIDGET_MAX_ITEMS),
            sections: capWidgetSections(rendered.sections, ANDROID_WIDGET_MAX_ITEMS) ?? [],
            lists: Object.fromEntries(Object.entries(rendered.lists).map(([id, list]) => [id, {
                ...list,
                items: list.items.slice(0, ANDROID_WIDGET_MAX_ITEMS),
                ...(list.sections ? { sections: capWidgetSections(list.sections, ANDROID_WIDGET_MAX_ITEMS) } : {}),
            }])),
            quickCapture: buildAndroidQuickCaptureLabels(language, audioEnabled),
            taskPeek: buildAndroidTaskPeekLabels(language),
        };
        AndroidWidget.setPayload(JSON.stringify(payload));
        const refreshResult = AndroidWidget.updateWidgets();
        // Older installed native modules return only the compatibility count.
        const legacyWidgetCount = typeof refreshResult === 'number' ? refreshResult : refreshResult?.legacyWidgetCount;
        if (typeof refreshResult === 'object' && refreshResult.compactWidgetCount > 0) {
            void logInfo('Compact Android widgets refreshed', {
                scope: 'widget',
                extra: {
                    releaseCheck: 'v1.3.0/android-compact-widget',
                    count: String(refreshResult.compactWidgetCount),
                },
            });
        }
        if (typeof legacyWidgetCount === 'number' && legacyWidgetCount > 0) {
            void logInfo('Legacy Android Tasks widgets refreshed', {
                scope: 'widget',
                extra: {
                    releaseCheck: ANDROID_WIDGET_PROVIDER_COMPAT_RELEASE_CHECK,
                    legacyWidgetCount: String(legacyWidgetCount),
                },
            });
        }
        void logInfo('Android widget payload published', {
            scope: 'widget',
            extra: { releaseCheck: ANDROID_WIDGET_RELEASE_CHECK, items: String(payload.items.length) },
        });
        void logInfo('Android widget Focus and Today payload published', {
            scope: 'widget',
            extra: {
                releaseCheck: WIDGET_FOCUS_TODAY_RELEASE_CHECK,
                focusItems: String(payload.sections.find((section) => section.key === 'focus')?.items.length ?? 0),
                todayItems: String(payload.sections.find((section) => section.key === 'schedule')?.items.length ?? 0),
                totalItems: String(payload.items.length),
            },
        });
        return true;
    } catch (error) {
        if (__DEV__) {
            void logWarn('[RNWidget] Failed to update Android widget', {
                scope: 'widget',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        }
        void logError(error, { scope: 'widget', extra: { platform: 'android' } });
        return false;
    }
}

async function updateIosWidgetPayloads(projection: WidgetPayloadProjection): Promise<boolean> {
    if (Platform.OS !== 'ios') return false;
    const widgetApi = await getIosWidgetApi();
    if (!widgetApi) return false;

    const payloadEntries = [
        [
            IOS_WIDGET_PAYLOAD_KEY,
            projection.build(IOS_WIDGET_FAMILY_MAX_ITEMS.default),
        ],
        [
            IOS_WIDGET_PAYLOAD_KEY_SMALL,
            projection.build(IOS_WIDGET_FAMILY_MAX_ITEMS.small),
        ],
        [
            IOS_WIDGET_PAYLOAD_KEY_MEDIUM,
            projection.build(IOS_WIDGET_FAMILY_MAX_ITEMS.medium),
        ],
        [
            IOS_WIDGET_PAYLOAD_KEY_LARGE,
            projection.build(IOS_WIDGET_FAMILY_MAX_ITEMS.large),
        ],
        [
            IOS_WIDGET_PAYLOAD_KEY_EXTRA_LARGE,
            projection.build(IOS_WIDGET_FAMILY_MAX_ITEMS.extraLarge),
        ],
    ] as const satisfies readonly [string, TasksWidgetPayload][];

    try {
        for (const [key, payload] of payloadEntries) {
            await widgetApi.setItem(
                key,
                JSON.stringify(payload),
                IOS_WIDGET_APP_GROUP,
            );
        }
        if (typeof widgetApi.reloadTimelines === 'function') {
            widgetApi.reloadTimelines(IOS_WIDGET_KIND);
            widgetApi.reloadTimelines(IOS_WIDGET_COMPACT_KIND);
            widgetApi.reloadTimelines(IOS_WIDGET_LOCK_KIND);
        } else if (typeof widgetApi.reloadAllTimelines === 'function') {
            widgetApi.reloadAllTimelines();
        }
        void logInfo('iOS widget family payloads published from one derivation', {
            scope: 'widget',
            extra: { releaseCheck: 'v1.3.0/widget-batch-derivation', count: 5 },
        });
        const payload = payloadEntries[0][1];
        void logInfo('iOS Focus widget payload published', {
            scope: 'widget',
            extra: {
                releaseCheck: 'v1.3.0/ios-focus-widget',
                focusItems: String(payload.sections.find((section) => section.key === 'focus')?.items.length ?? 0),
                todayItems: String(payload.sections.find((section) => section.key === 'schedule')?.items.length ?? 0),
                totalItems: String(payload.items.length),
            },
        });
        return true;
    } catch (error) {
        if (__DEV__) {
            void logWarn('[RNWidget] Failed to update iOS widget', {
                scope: 'widget',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        }
        void logError(error, { scope: 'widget', extra: { platform: 'ios' } });
        return false;
    }
}

// Separate from the widget payload write above (#980 correction): the
// snapshot changes on edits the widget never shows (for example project
// metadata outside the widget's own top-N slice), so it needs
// its own change-skip gate. Sharing one fingerprint would either miss those
// snapshot-only changes or re-run the widget's five setItem calls plus three
// reloadTimelines on every one of them, which is exactly what #766 added a
// cache to avoid.
async function updateIosShortcutsSnapshotFromData(snapshot: ShortcutsSnapshot): Promise<boolean> {
    if (Platform.OS !== 'ios') return false;
    const widgetApi = await getIosWidgetApi();
    if (!widgetApi) return false;

    try {
        await widgetApi.setItem(
            IOS_SHORTCUTS_SNAPSHOT_KEY,
            JSON.stringify(snapshot),
            IOS_WIDGET_APP_GROUP,
        );
        return true;
    } catch (error) {
        if (__DEV__) {
            void logWarn('[RNWidget] Failed to update iOS shortcuts snapshot', {
                scope: 'widget',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        }
        void logError(error, { scope: 'widget', extra: { platform: 'ios', surface: 'shortcuts-snapshot' } });
        return false;
    }
}

// Storage fires widget updates on every save and load, but the native render
// (Android RemoteViews / iOS timeline reload) costs seconds on mid-range
// devices while the payload build costs milliseconds (#766). Remember what was
// last rendered and skip the native update when nothing any widget shows
// changed. Newly placed or resized Android widgets draw from the last stored
// payload natively, so they never depend on this path.
const WIDGET_FINGERPRINT_MAX_ITEMS = 50;
// Folded into the fingerprint (not just the storage key) so an app upgrade
// that changes what a render writes without changing the payload data still
// forces a render: a persisted fingerprint from an older build never matches
// the newly computed one (correction #4).
const WIDGET_RENDER_APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';
let lastRenderedWidgetFingerprint: string | null = null;
let lastRenderedShortcutsSnapshotFingerprint: string | null = null;

// The rendered fingerprint above only lives in module scope, which is cold on
// every invocation of the scheduled background sync (a headless RN instance):
// the #766 native-render skip never fired there. Persist it so a background
// cycle that changed nothing still skips the native render (#766 follow-up).
const WIDGET_FINGERPRINT_STORAGE_KEY = 'mindwtr-widget-render-fingerprint';
let widgetFingerprintLoadedFromStorage = false;
let widgetFingerprintLoadPromise: Promise<void> | null = null;

async function ensureLastRenderedWidgetFingerprintLoaded(): Promise<void> {
    if (widgetFingerprintLoadedFromStorage) return;
    if (!widgetFingerprintLoadPromise) {
        widgetFingerprintLoadPromise = (async () => {
            try {
                const stored = await AsyncStorage.getItem(WIDGET_FINGERPRINT_STORAGE_KEY);
                if (stored !== null) lastRenderedWidgetFingerprint = stored;
            } catch {
                // Read failure: treat as null (render).
            } finally {
                widgetFingerprintLoadedFromStorage = true;
            }
        })();
    }
    await widgetFingerprintLoadPromise;
}

// Gate 0's cache: {lastDataChangeAt, language, localDayKey} of the last
// successful render, so a repeated store-driven update (the immediate + 800ms
// pair after a foreground transition) can skip building/stringifying the
// widget payload entirely when nothing that could change it moved. Only
// `updateMobileWidgetFromStore` has `lastDataChangeAt`, so this gate lives
// there rather than in `updateMobileWidgetFromData`.
type WidgetRenderContext = {
    lastDataChangeAt: number;
    language: Language;
    localDayKey: string;
    systemColorScheme: ReturnType<typeof getSystemColorSchemeForWidget>;
    focusFilterKey: string;
};
let lastRenderContext: WidgetRenderContext | null = null;

export function resetMobileWidgetRenderCache(): void {
    lastRenderedWidgetFingerprint = null;
    lastRenderedShortcutsSnapshotFingerprint = null;
    lastRenderContext = null;
    widgetFingerprintLoadedFromStorage = false;
    widgetFingerprintLoadPromise = null;
}

export async function updateMobileWidgetFromData(data: AppData): Promise<boolean> {
    if (isSandboxMode()) return false;
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return false;
    await ensureLastRenderedWidgetFingerprintLoaded();
    const language = await resolvePayloadLanguage(data);
    const iosProjection = Platform.OS === 'ios'
        ? createPayloadProjectionFromData(data, language)
        : null;

    // Gate 1: the widget's own payload fingerprint, exactly as before #980 --
    // this is the #766 skip and must not fire on changes the widget doesn't
    // show.
    const fingerprintPayload = iosProjection
        ? iosProjection.build(WIDGET_FINGERPRINT_MAX_ITEMS)
        : buildPayloadFromData(data, language, WIDGET_FINGERPRINT_MAX_ITEMS);
    // Native capture reads only availability, never provider credentials or model paths.
    // Include it in the fingerprint so a setting-only change refreshes the dialog.
    const audioEnabled = data.settings.ai?.speechToText?.enabled === true;
    const nativeCaptureFingerprint = Platform.OS === 'android' ? `:audio=${audioEnabled}` : '';
    const widgetFingerprint = `${WIDGET_RENDER_APP_VERSION}:${language}:${JSON.stringify(fingerprintPayload)}${nativeCaptureFingerprint}`;
    let widgetUpdated = true;
    if (widgetFingerprint !== lastRenderedWidgetFingerprint) {
        widgetUpdated = Platform.OS === 'android'
            ? await updateAndroidWidgetsFromData(
                buildPayloadFromData(data, language, ANDROID_WIDGET_MAX_ITEMS),
                language,
                audioEnabled,
            )
            : await updateIosWidgetPayloads(iosProjection as WidgetPayloadProjection);
        if (widgetUpdated) {
            lastRenderedWidgetFingerprint = widgetFingerprint;
            // Awaited (still error-swallowed): the headless background-sync
            // instance this cache targets can tear down as soon as this
            // function's promise settles, so a fire-and-forget write could
            // never land (correction #5).
            await AsyncStorage.setItem(WIDGET_FINGERPRINT_STORAGE_KEY, widgetFingerprint).catch(() => undefined);
        }
    }

    // Gate 2: the Shortcuts/Spotlight snapshot's own fingerprint (iOS only),
    // independent of the widget gate above. `generatedAt` is excluded -- it
    // always changes, and folding it in would defeat the point of this cache.
    let snapshotUpdated = true;
    if (Platform.OS === 'ios') {
        const snapshot = buildShortcutsSnapshot(data);
        const snapshotFingerprint = JSON.stringify({ lists: snapshot.lists, projects: snapshot.projects });
        if (snapshotFingerprint !== lastRenderedShortcutsSnapshotFingerprint) {
            snapshotUpdated = await updateIosShortcutsSnapshotFromData(snapshot);
            if (snapshotUpdated) {
                lastRenderedShortcutsSnapshotFingerprint = snapshotFingerprint;
            }
        }
    }

    return widgetUpdated && snapshotUpdated;
}

export async function updateMobileWidgetFromStore(): Promise<boolean> {
    if (isSandboxMode()) return false;
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return false;
    const { _allTasks, _allProjects, _allSections, _allAreas, tasks, projects, sections, areas, settings, lastDataChangeAt } = useTaskStore.getState();
    const ensureArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
    const allTasks = ensureArray<AppData['tasks'][number]>(_allTasks);
    const allProjects = ensureArray<AppData['projects'][number]>(_allProjects);
    const allSections = ensureArray<AppData['sections'][number]>(_allSections);
    const allAreas = ensureArray<AppData['areas'][number]>(_allAreas);
    const visibleTasks = ensureArray<AppData['tasks'][number]>(tasks);
    const visibleProjects = ensureArray<AppData['projects'][number]>(projects);
    const visibleSections = ensureArray<AppData['sections'][number]>(sections);
    const visibleAreas = ensureArray<AppData['areas'][number]>(areas);
    const data: AppData = {
        tasks: allTasks.length ? allTasks : visibleTasks,
        projects: allProjects.length ? allProjects : visibleProjects,
        sections: allSections.length ? allSections : visibleSections,
        areas: allAreas.length ? allAreas : visibleAreas,
        settings: settings ?? {},
    };

    // Gate 0: cheap pre-check before building/stringifying the widget payload.
    // `language` still needs its own (cheap, single-key) AsyncStorage read to
    // compare -- the JSON-heavy gate 1 fingerprint below is what this skips.
    // The system colour scheme is included because the payload's palette
    // depends on it (widget-data.ts reads getSystemColorSchemeForWidget) but
    // nothing else in this key moves when it flips (correction #2).
    const language = await resolvePayloadLanguage(data);
    const localDayKey = getLocalDayKey();
    const systemColorScheme = getSystemColorSchemeForWidget();
    // Changing a filter on the Focus screen moves no task data, so without this
    // the gate below would skip the republish that shows the new selection.
    const currentFocusFilterKey = focusWidgetFilterKey(getFocusWidgetFilter());
    if (
        lastRenderContext
        && lastRenderContext.lastDataChangeAt === lastDataChangeAt
        && lastRenderContext.language === language
        && lastRenderContext.localDayKey === localDayKey
        && lastRenderContext.systemColorScheme === systemColorScheme
        && lastRenderContext.focusFilterKey === currentFocusFilterKey
    ) {
        return true;
    }

    const result = await updateMobileWidgetFromData(data);
    // Only remember this context on a successful render -- a failed render
    // (native call threw, iOS widget API unavailable) must not disable the
    // callers' retry (immediate + 800ms) via gate 0 (correction #1, blocking).
    if (result) {
        lastRenderContext = { lastDataChangeAt, language, localDayKey, systemColorScheme, focusFilterKey: currentFocusFilterKey };
    }
    return result;
}

// Backwards-compatible aliases for older imports.
export const updateAndroidWidgetFromData = updateMobileWidgetFromData;
export const updateAndroidWidgetFromStore = updateMobileWidgetFromStore;

export async function requestPinAndroidWidget(): Promise<boolean> {
    if (isSandboxMode()) return false;
    return false;
}
