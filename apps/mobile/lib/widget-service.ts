import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSystemDefaultLanguage, isSandboxMode, type AppData, type Language, useTaskStore } from '@mindwtr/core';
import * as ReactNativeWidgetKit from 'react-native-widgetkit';

import * as AndroidWidget from '../modules/android-widget';
import {
    ANDROID_WIDGET_MAX_ITEMS,
    androidWidgetProjectionOptions,
    buildAndroidTasksWidgetPayload,
    createPublishedWidgetProjection,
    IOS_WIDGET_FAMILY_CACHE_ITEMS,
    iosWidgetProjectionOptions,
    isWidgetAudioCaptureEnabled,
} from '@mindwtr/core/widget-payload';
import { WIDGET_FIXED_LIST_IDS } from '@mindwtr/core/widget-lists';
import {
    buildShortcutsSnapshot,
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
    return resolveWidgetLanguage(languageValue, data.settings?.language, getSystemDefaultLanguage());
}

// What each platform's payload carries is core's (widget-payload.ts); this
// reads the inputs only the app has: the system colour scheme, the Focus
// screen's current filter (#1173) and the lists placed Android widgets chose.
function widgetPayloadOptions(): Omit<WidgetPayloadBuildOptions, 'maxItems'> {
    const input = {
        systemColorScheme: getSystemColorSchemeForWidget(),
        focusFilter: getFocusWidgetFilter(),
    };
    if (Platform.OS === 'android' && AndroidWidget.isSupported()) {
        return androidWidgetProjectionOptions({ ...input, listSelections: AndroidWidget.getWidgetListSelections() });
    }
    if (Platform.OS === 'ios') return iosWidgetProjectionOptions(input);
    return input;
}

function createPayloadProjectionFromData(data: AppData, language: Language): WidgetPayloadProjection {
    return createPublishedWidgetProjection(createWidgetPayloadProjection(data, language, widgetPayloadOptions()), language);
}

const ANDROID_WIDGET_RELEASE_CHECK = 'v1.3.0/android-native-widget';
const ANDROID_WIDGET_PROVIDER_COMPAT_RELEASE_CHECK = 'v1.3.0/android-widget-provider-compat';
const WIDGET_FOCUS_TODAY_RELEASE_CHECK = 'v1.3.0/widget-focus-today';
const IOS_WIDGET_PARITY_RELEASE_CHECK = 'v1.3.1/ios-widget-parity';
let androidWidgetUnavailableLogged = false;

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
        const payload = buildAndroidTasksWidgetPayload(rendered, language, audioEnabled);
        AndroidWidget.setPayload(JSON.stringify(payload));
        const refreshResult = AndroidWidget.updateWidgets();
        // Older installed native modules return only the compatibility count.
        const legacyWidgetCount = typeof refreshResult === 'number' ? refreshResult : refreshResult?.legacyWidgetCount;
        const hiddenCheckoffCount = typeof refreshResult === 'object' ? refreshResult.hiddenCheckoffCount : undefined;
        const serializedCheckoffCount = typeof refreshResult === 'object' ? refreshResult.serializedCheckoffCount : undefined;
        const directCollectionCount = typeof refreshResult === 'object' ? refreshResult.directCollectionCount : undefined;
        const renderedTaskCount = typeof refreshResult === 'object' ? refreshResult.renderedTaskCount : undefined;
        const eligibleTaskCount = typeof refreshResult === 'object' ? refreshResult.eligibleTaskCount : undefined;
        const collectionBytes = typeof refreshResult === 'object' ? refreshResult.collectionBytes : undefined;
        if (
            typeof directCollectionCount === 'number' && directCollectionCount > 0
            && typeof renderedTaskCount === 'number'
            && typeof eligibleTaskCount === 'number'
            && typeof collectionBytes === 'number'
        ) {
            void logInfo('Android widget list rendered within parcel budget', {
                scope: 'widget',
                extra: {
                    count: String(directCollectionCount),
                    items: String(renderedTaskCount),
                    totalItems: String(eligibleTaskCount),
                    collectionBytes: String(collectionBytes),
                },
            });
        }
        if (typeof hiddenCheckoffCount === 'number' && hiddenCheckoffCount > 0) {
            void logInfo('Android widget check-offs hidden after Undo', {
                scope: 'widget',
                extra: {
                    releaseCheck: 'v1.3.1/widget-checkoff-hide',
                    count: String(hiddenCheckoffCount),
                },
            });
        }
        if (typeof serializedCheckoffCount === 'number' && serializedCheckoffCount > 0) {
            void logInfo('Android widget check-off state serialized', {
                scope: 'widget',
                extra: {
                    releaseCheck: 'v1.3.2/widget-checkoff-serialized',
                    count: String(serializedCheckoffCount),
                },
            });
        }
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
        void logInfo('Android widget context and tag snapshots published', {
            scope: 'widget', force: true,
            extra: {
                releaseCheck: 'v1.3.7/widget-context-selection', count: (payload.contexts?.length ?? 0) + (payload.tags?.length ?? 0),
                // Lists built for placed widgets' context, tag and saved-filter choices only.
                lists: Object.keys(payload.lists).filter((id) => /^(context|tag|filter):/.test(id)).length,
            },
        });
        void logInfo('Upcoming widget snapshot published', {
            scope: 'widget',
            force: true,
            extra: { releaseCheck: 'v1.3.7/widget-upcoming', platform: 'android', count: payload.lists.upcoming?.items.length ?? 0 },
        });
        void logInfo('Android widget fixed lists published', {
            scope: 'widget',
            extra: {
                releaseCheck: 'v1.3.1/android-widget-lists',
                count: String(WIDGET_FIXED_LIST_IDS.length),
                focusItems: String(payload.items.length),
                nextItems: String(payload.lists.next?.items.length ?? 0),
                inboxItems: String(payload.lists.inbox?.items.length ?? 0),
            },
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
            projection.build(IOS_WIDGET_FAMILY_CACHE_ITEMS.default),
        ],
        [
            IOS_WIDGET_PAYLOAD_KEY_SMALL,
            projection.build(IOS_WIDGET_FAMILY_CACHE_ITEMS.small),
        ],
        [
            IOS_WIDGET_PAYLOAD_KEY_MEDIUM,
            projection.build(IOS_WIDGET_FAMILY_CACHE_ITEMS.medium),
        ],
        [
            IOS_WIDGET_PAYLOAD_KEY_LARGE,
            projection.build(IOS_WIDGET_FAMILY_CACHE_ITEMS.large),
        ],
        [
            IOS_WIDGET_PAYLOAD_KEY_EXTRA_LARGE,
            projection.build(IOS_WIDGET_FAMILY_CACHE_ITEMS.extraLarge),
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
        void logInfo('Upcoming widget snapshot published', {
            scope: 'widget',
            force: true,
            extra: { releaseCheck: 'v1.3.7/widget-upcoming', platform: 'ios', count: payload.lists.upcoming?.items.length ?? 0 },
        });
        void logInfo('iOS Focus widget payload published', {
            scope: 'widget',
            extra: {
                releaseCheck: 'v1.3.0/ios-focus-widget',
                focusItems: String(payload.sections.find((section) => section.key === 'focus')?.items.length ?? 0),
                todayItems: String(payload.sections.find((section) => section.key === 'schedule')?.items.length ?? 0),
                totalItems: String(payload.items.length),
            },
        });
        void logInfo('iOS widget parity snapshot published', {
            scope: 'widget',
            extra: {
                releaseCheck: IOS_WIDGET_PARITY_RELEASE_CHECK,
                count: String(payloadEntries.length),
                totalItems: String(payload.items.length),
                nextItems: String(payload.lists.next?.items.length ?? 0),
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
const WIDGET_RENDER_SCHEMA_REVISION = 2;
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
    listSelectionsKey: string;
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
    const projection = createPayloadProjectionFromData(data, language);
    const iosProjection = Platform.OS === 'ios' ? projection : null;

    // Gate 1: the widget's own payload fingerprint, exactly as before #980 --
    // this is the #766 skip and must not fire on changes the widget doesn't
    // show.
    const fingerprintPayload = projection.build(
        Platform.OS === 'android' ? ANDROID_WIDGET_MAX_ITEMS : WIDGET_FINGERPRINT_MAX_ITEMS,
    );
    // Include audio availability in the fingerprint so a setting-only change
    // refreshes the dialog.
    const audioEnabled = isWidgetAudioCaptureEnabled(data.settings);
    const nativeCaptureFingerprint = Platform.OS === 'android' ? `:audio=${audioEnabled}` : '';
    const widgetFingerprint = `${WIDGET_RENDER_SCHEMA_REVISION}:${WIDGET_RENDER_APP_VERSION}:${language}:${JSON.stringify(fingerprintPayload)}${nativeCaptureFingerprint}`;
    let widgetUpdated = true;
    if (widgetFingerprint !== lastRenderedWidgetFingerprint) {
        widgetUpdated = Platform.OS === 'android'
            ? await updateAndroidWidgetsFromData(
                fingerprintPayload,
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
            void logInfo('Widget Focus pools published to native host', {
                scope: 'widget',
                force: true,
                extra: { releaseCheck: 'v1.3.2/widget-focus-pools' },
            });
        }
    }

    // Gate 2: the Shortcuts/Spotlight snapshot's own fingerprint (iOS only),
    // independent of the widget gate above. `generatedAt` is excluded -- it
    // always changes, and folding it in would defeat the point of this cache.
    let snapshotUpdated = true;
    if (Platform.OS === 'ios') {
        const snapshot = buildShortcutsSnapshot(data);
        const snapshotFingerprint = JSON.stringify({
            version: snapshot.version,
            lists: snapshot.lists,
            projects: snapshot.projects,
            coverage: snapshot.coverage,
        });
        if (snapshotFingerprint !== lastRenderedShortcutsSnapshotFingerprint) {
            snapshotUpdated = await updateIosShortcutsSnapshotFromData(snapshot);
            if (snapshotUpdated) {
                lastRenderedShortcutsSnapshotFingerprint = snapshotFingerprint;
                void logInfo('iOS task snapshot published to App Group', {
                    scope: 'widget',
                    force: true,
                    extra: {
                        releaseCheck: 'v1.3.1/apple-task-snapshot',
                        snapshotVersion: snapshot.version,
                        publishedCount: snapshot.coverage.tasks.published,
                        omittedCount: snapshot.coverage.tasks.omitted,
                        exactLinkCount: snapshot.coverage.tasks.published,
                    },
                });
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
    // The Android payload carries context, tag and saved-filter lists only for placed widgets' choices (core's
    // androidWidgetProjectionOptions), so a list picked in the widget's chooser moves no task data either.
    const listSelectionsKey = Platform.OS === 'android' && AndroidWidget.isSupported()
        ? JSON.stringify(AndroidWidget.getWidgetListSelections()) : '';
    if (
        lastRenderContext
        && lastRenderContext.lastDataChangeAt === lastDataChangeAt
        && lastRenderContext.language === language
        && lastRenderContext.localDayKey === localDayKey
        && lastRenderContext.systemColorScheme === systemColorScheme
        && lastRenderContext.focusFilterKey === currentFocusFilterKey
        && lastRenderContext.listSelectionsKey === listSelectionsKey
    ) {
        return true;
    }

    const result = await updateMobileWidgetFromData(data);
    // Only remember this context on a successful render -- a failed render
    // (native call threw, iOS widget API unavailable) must not disable the
    // callers' retry (immediate + 800ms) via gate 0 (correction #1, blocking).
    if (result) {
        lastRenderContext = { lastDataChangeAt, language, localDayKey, systemColorScheme, focusFilterKey: currentFocusFilterKey, listSelectionsKey };
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
