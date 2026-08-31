import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { type AppData, type Language, useTaskStore } from '@mindwtr/core';
import { requestWidgetUpdate, type WidgetInfo } from 'react-native-android-widget';
import * as ReactNativeWidgetKit from 'react-native-widgetkit';

import { buildTasksWidgetTree } from '../components/TasksWidget';
import {
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
import { logError, logInfo, logWarn } from './app-log';
import { isExpoGo } from './expo-go';
import { getSystemColorSchemeForWidget } from './system-color-scheme';
import {
    getAdaptiveAndroidWidgetTaskLimit,
    getAndroidWidgetLayoutMode,
} from './widget-layout';

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

function buildPayloadFromData(
    data: AppData,
    language: Language,
    maxItems?: number,
): TasksWidgetPayload {
    return buildWidgetPayload(data, language, {
        systemColorScheme: getSystemColorSchemeForWidget(),
        maxItems,
    });
}

let expoGoWidgetSkipLogged = false;

async function updateAndroidWidgetsFromData(data: AppData, language: Language): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    // Expo Go does not bundle react-native-android-widget; the bridge call below would
    // fail (twice, then log an error) on every data change. Say so once, then stay quiet.
    if (isExpoGo()) {
        if (!expoGoWidgetSkipLogged) {
            expoGoWidgetSkipLogged = true;
            void logInfo('[RNWidget] Android widgets are unavailable in Expo Go; skipping updates', { scope: 'widget' });
        }
        return false;
    }

    try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                await requestWidgetUpdate({
                    widgetName: 'TasksWidget',
                    renderWidget: (widgetInfo) => buildTasksWidgetTree(
                        buildPayloadFromData(
                            data,
                            language,
                            getAdaptiveAndroidWidgetTaskLimit(widgetInfo.height, widgetInfo.width),
                        ),
                        { layoutMode: getAndroidWidgetLayoutMode(widgetInfo.width) },
                    ),
                });
                return true;
            } catch (error) {
                if (attempt < 1) {
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    continue;
                }
                if (__DEV__) {
                    void logWarn('[RNWidget] Failed to update Android widget', {
                        scope: 'widget',
                        extra: { error: error instanceof Error ? error.message : String(error) },
                    });
                }
                void logError(error, { scope: 'widget', extra: { platform: 'android', attempt: String(attempt + 1) } });
                return false;
            }
        }
        return false;
    } catch (error) {
        if (__DEV__) {
            void logWarn('[RNWidget] Failed to update Android widget', {
                scope: 'widget',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        }
        void logError(error, { scope: 'widget', extra: { platform: 'android', attempt: 'setup' } });
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
// changed. System events for new/resized widgets render through
// widget-task-handler directly, so they never depend on this path.
const WIDGET_FINGERPRINT_MAX_ITEMS = 50;
let lastRenderedWidgetFingerprint: string | null = null;
let lastRenderedShortcutsSnapshotFingerprint: string | null = null;

export function resetMobileWidgetRenderCache(): void {
    lastRenderedWidgetFingerprint = null;
    lastRenderedShortcutsSnapshotFingerprint = null;
}

export async function updateMobileWidgetFromData(data: AppData): Promise<boolean> {
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return false;
    const language = await resolvePayloadLanguage(data);

    // Gate 1: the widget's own payload fingerprint, exactly as before #980 --
    // this is the #766 skip and must not fire on changes the widget doesn't
    // show.
    const widgetFingerprint = `${language}:${JSON.stringify(
        buildPayloadFromData(data, language, WIDGET_FINGERPRINT_MAX_ITEMS),
    )}`;
    let widgetUpdated = true;
    if (widgetFingerprint !== lastRenderedWidgetFingerprint) {
        widgetUpdated = Platform.OS === 'android'
            ? await updateAndroidWidgetsFromData(data, language)
            : await updateIosWidgetPayloadsFromData(data, language);
        if (widgetUpdated) {
            lastRenderedWidgetFingerprint = widgetFingerprint;
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
    const { _allTasks, _allProjects, _allSections, _allAreas, tasks, projects, sections, areas, settings } = useTaskStore.getState();
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
    return await updateMobileWidgetFromData(data);
}

// Backwards-compatible aliases for older imports.
export const updateAndroidWidgetFromData = updateMobileWidgetFromData;
export const updateAndroidWidgetFromStore = updateMobileWidgetFromStore;

export async function requestPinAndroidWidget(): Promise<boolean> {
    return false;
}
