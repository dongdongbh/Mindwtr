import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { type AppData, type Language, useTaskStore } from '@mindwtr/core';
import * as ReactNativeWidgetKit from 'react-native-widgetkit';

import * as AndroidWidget from '../modules/android-widget';
import {
    type AndroidTasksWidgetPayload,
    buildAndroidQuickCaptureLabels,
    buildShortcutsSnapshot,
    buildWidgetPayload,
    IOS_SHORTCUTS_SNAPSHOT_KEY,
    IOS_WIDGET_APP_GROUP,
    IOS_WIDGET_KIND,
    IOS_WIDGET_LOCK_KIND,
    IOS_WIDGET_PAYLOAD_KEY,
    IOS_WIDGET_PAYLOAD_KEY_EXTRA_LARGE,
    IOS_WIDGET_PAYLOAD_KEY_LARGE,
    IOS_WIDGET_PAYLOAD_KEY_MEDIUM,
    IOS_WIDGET_PAYLOAD_KEY_SMALL,
    resolveWidgetLanguage,
    type ShortcutsSnapshot,
    type TasksWidgetPayload,
    WIDGET_LANGUAGE_KEY,
} from './widget-data';
import { WIDGET_FIXED_LIST_IDS } from './widget-lists';
import { logError, logInfo, logWarn } from './app-log';
import { getLocalDayKey } from '@/hooks/use-local-day-key';
import { getSystemColorSchemeForWidget } from './system-color-scheme';

export function isAndroidWidgetSupported(): boolean {
    return Platform.OS === 'android';
}

export function isIosWidgetSupported(): boolean {
    return Platform.OS === 'ios';
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

function buildPayloadFromData(
    data: AppData,
    language: Language,
    maxItems?: number,
): TasksWidgetPayload {
    return buildWidgetPayload(data, language, {
        systemColorScheme: getSystemColorSchemeForWidget(),
        maxItems,
        // Only the lists placed Android widgets asked for are built (#1173);
        // folding them in here also puts them in the render fingerprint.
        ...(Platform.OS === 'android' && AndroidWidget.isSupported() ? { listIds: androidWidgetListIds() } : {}),
    });
}

// The native widget's task list scrolls (RemoteViewsService), so the payload
// carries a fixed slice instead of a per-widget-height budget.
const ANDROID_WIDGET_MAX_ITEMS = 20;
const ANDROID_WIDGET_RELEASE_CHECK = 'v1.2.9/android-native-widget';
let androidWidgetUnavailableLogged = false;

// `rendered` is the fingerprint build below (up to WIDGET_FINGERPRINT_MAX_ITEMS
// items), reused so a render costs one payload build, not two.
async function updateAndroidWidgetsFromData(rendered: TasksWidgetPayload, language: Language): Promise<boolean> {
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
            lists: Object.fromEntries(Object.entries(rendered.lists).map(([id, list]) => [id, {
                ...list,
                items: list.items.slice(0, ANDROID_WIDGET_MAX_ITEMS),
            }])),
            quickCapture: buildAndroidQuickCaptureLabels(language),
        };
        AndroidWidget.setPayload(JSON.stringify(payload));
        AndroidWidget.updateWidgets();
        void logInfo('Android widget payload published', {
            scope: 'widget',
            extra: { releaseCheck: ANDROID_WIDGET_RELEASE_CHECK, items: String(payload.items.length) },
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

async function updateIosWidgetPayloadsFromData(data: AppData, language: Language): Promise<boolean> {
    if (Platform.OS !== 'ios') return false;
    const widgetApi = await getIosWidgetApi();
    if (!widgetApi) return false;

    const payloadEntries = [
        [
            IOS_WIDGET_PAYLOAD_KEY,
            buildPayloadFromData(data, language, IOS_WIDGET_FAMILY_MAX_ITEMS.default),
        ],
        [
            IOS_WIDGET_PAYLOAD_KEY_SMALL,
            buildPayloadFromData(data, language, IOS_WIDGET_FAMILY_MAX_ITEMS.small),
        ],
        [
            IOS_WIDGET_PAYLOAD_KEY_MEDIUM,
            buildPayloadFromData(data, language, IOS_WIDGET_FAMILY_MAX_ITEMS.medium),
        ],
        [
            IOS_WIDGET_PAYLOAD_KEY_LARGE,
            buildPayloadFromData(data, language, IOS_WIDGET_FAMILY_MAX_ITEMS.large),
        ],
        [
            IOS_WIDGET_PAYLOAD_KEY_EXTRA_LARGE,
            buildPayloadFromData(data, language, IOS_WIDGET_FAMILY_MAX_ITEMS.extraLarge),
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
            widgetApi.reloadTimelines(IOS_WIDGET_LOCK_KIND);
        } else if (typeof widgetApi.reloadAllTimelines === 'function') {
            widgetApi.reloadAllTimelines();
        }
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
// snapshot changes on edits the widget never shows (a Waiting/Someday/Inbox
// task, a project task outside the widget's own top-N slice), so it needs
// its own change-skip gate. Sharing one fingerprint would either miss those
// snapshot-only changes or re-run the widget's five setItem calls plus two
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
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return false;
    await ensureLastRenderedWidgetFingerprintLoaded();
    const language = await resolvePayloadLanguage(data);

    // Gate 1: the widget's own payload fingerprint, exactly as before #980 --
    // this is the #766 skip and must not fire on changes the widget doesn't
    // show.
    const fingerprintPayload = buildPayloadFromData(data, language, WIDGET_FINGERPRINT_MAX_ITEMS);
    const widgetFingerprint = `${WIDGET_RENDER_APP_VERSION}:${language}:${JSON.stringify(fingerprintPayload)}`;
    let widgetUpdated = true;
    if (widgetFingerprint !== lastRenderedWidgetFingerprint) {
        widgetUpdated = Platform.OS === 'android'
            ? await updateAndroidWidgetsFromData(fingerprintPayload, language)
            : await updateIosWidgetPayloadsFromData(data, language);
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
    if (
        lastRenderContext
        && lastRenderContext.lastDataChangeAt === lastDataChangeAt
        && lastRenderContext.language === language
        && lastRenderContext.localDayKey === localDayKey
        && lastRenderContext.systemColorScheme === systemColorScheme
    ) {
        return true;
    }

    const result = await updateMobileWidgetFromData(data);
    // Only remember this context on a successful render -- a failed render
    // (native call threw, iOS widget API unavailable) must not disable the
    // callers' retry (immediate + 800ms) via gate 0 (correction #1, blocking).
    if (result) {
        lastRenderContext = { lastDataChangeAt, language, localDayKey, systemColorScheme };
    }
    return result;
}

// Backwards-compatible aliases for older imports.
export const updateAndroidWidgetFromData = updateMobileWidgetFromData;
export const updateAndroidWidgetFromStore = updateMobileWidgetFromStore;

export async function requestPinAndroidWidget(): Promise<boolean> {
    return false;
}
