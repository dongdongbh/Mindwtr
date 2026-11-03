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
import { WIDGET_FIXED_LIST_IDS, WIDGET_FOCUS_AVAILABLE_LIST_ID } from '@mindwtr/core/widget-lists';
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


function logFocusAvailablePublished(payload: TasksWidgetPayload, platform: 'android' | 'ios'): void {
    const list = payload.lists[WIDGET_FOCUS_AVAILABLE_LIST_ID];
    if (!list) return;
    void logInfo('Focus widget available actions published', {
        scope: 'widget',
        force: true,
        extra: {
            releaseCheck: 'v1.3.8/widget-focus-available',
            platform,
            count: String(list.sections?.find((section) => section.key === 'available')?.items.length ?? 0),
            totalItems: String(list.totalCount),
        },
    });
}

async function updateAndroidWidgetsFromData(rendered: TasksWidgetPayload, language: Language, audioEnabled: boolean): Promise<boolean> {
    if (Platform.OS !== 'android') return false;

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

                lists: Object.keys(payload.lists).filter((id) => /^(context|tag|filter):/.test(id)).length,
            },
        });
        void logInfo('Widget lists published from one snapshot', {
            scope: 'widget',
            force: true,
            extra: { releaseCheck: 'v1.3.8/widget-snapshot-rollover', platform: 'android', count: payload.lists.upcoming?.items.length ?? 0 },
        });
        logFocusAvailablePublished(payload, 'android');
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
        void logInfo('Widget lists published from one snapshot', {
            scope: 'widget',
            force: true,
            extra: { releaseCheck: 'v1.3.8/widget-snapshot-rollover', platform: 'ios', count: payload.lists.upcoming?.items.length ?? 0 },
        });
        logFocusAvailablePublished(payload, 'ios');
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


const WIDGET_FINGERPRINT_MAX_ITEMS = 50;
const WIDGET_RENDER_SCHEMA_REVISION = 2;


const WIDGET_RENDER_APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';
let lastRenderedWidgetFingerprint: string | null = null;
let lastRenderedShortcutsSnapshotFingerprint: string | null = null;


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

            } finally {
                widgetFingerprintLoadedFromStorage = true;
            }
        })();
    }
    await widgetFingerprintLoadPromise;
}


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


    const fingerprintPayload = projection.build(
        Platform.OS === 'android' ? ANDROID_WIDGET_MAX_ITEMS : WIDGET_FINGERPRINT_MAX_ITEMS,
    );


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
            await logInfo('Widget list presentation published', {
                scope: 'widget', force: true,
                extra: { releaseCheck: 'v1.3.8/widget-list-presentation',
                    lists: Object.values(fingerprintPayload.lists).filter((list) => list.sections?.length).length },
            });
            lastRenderedWidgetFingerprint = widgetFingerprint;


            await AsyncStorage.setItem(WIDGET_FINGERPRINT_STORAGE_KEY, widgetFingerprint).catch(() => undefined);
            void logInfo('Widget Focus pools published to native host', {
                scope: 'widget',
                force: true,
                extra: { releaseCheck: 'v1.3.2/widget-focus-pools' },
            });
        }
    }


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


    const language = await resolvePayloadLanguage(data);
    const localDayKey = getLocalDayKey();
    const systemColorScheme = getSystemColorSchemeForWidget();


    const currentFocusFilterKey = focusWidgetFilterKey(getFocusWidgetFilter());


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


    if (result) {
        lastRenderContext = { lastDataChangeAt, language, localDayKey, systemColorScheme, focusFilterKey: currentFocusFilterKey, listSelectionsKey };
    }
    return result;
}


export const updateAndroidWidgetFromData = updateMobileWidgetFromData;
export const updateAndroidWidgetFromStore = updateMobileWidgetFromStore;

export async function requestPinAndroidWidget(): Promise<boolean> {
    if (isSandboxMode()) return false;
    return false;
}
