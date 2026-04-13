import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { type AppData, type Language, useTaskStore } from '@mindwtr/core';
import { requestWidgetUpdate, type WidgetInfo } from 'react-native-android-widget';
import * as ReactNativeWidgetKit from 'react-native-widgetkit';

import { buildTasksWidgetTree } from '../components/TasksWidget';
import {
    buildWidgetPayload,
    IOS_WIDGET_APP_GROUP,
    IOS_WIDGET_KIND,
    IOS_WIDGET_PAYLOAD_KEY,
    IOS_WIDGET_PAYLOAD_KEY_LARGE,
    IOS_WIDGET_PAYLOAD_KEY_MEDIUM,
    IOS_WIDGET_PAYLOAD_KEY_SMALL,
    resolveWidgetLanguage,
    type TasksWidgetPayload,
    WIDGET_LANGUAGE_KEY,
} from './widget-data';
import { logError, logWarn } from './app-log';
import { getSystemColorSchemeForWidget } from './system-color-scheme';
import {
    getAdaptiveAndroidWidgetTaskLimit,
    getAdaptiveWidgetTaskLimit,
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

const IOS_WIDGET_FAMILY_HEIGHTS_DP = {
    small: 180,
    medium: 320,
    large: 530,
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

async function updateAndroidWidgetsFromData(data: AppData, language: Language): Promise<boolean> {
    if (Platform.OS !== 'android') return false;

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

async function updateIosWidgetsFromData(data: AppData, language: Language): Promise<boolean> {
    if (Platform.OS !== 'ios') return false;
    const widgetApi = await getIosWidgetApi();
    if (!widgetApi) return false;

    const payloadEntries = [
        [
            IOS_WIDGET_PAYLOAD_KEY,
            buildPayloadFromData(data, language, getAdaptiveWidgetTaskLimit(IOS_WIDGET_FAMILY_HEIGHTS_DP.medium)),
        ],
        [
            IOS_WIDGET_PAYLOAD_KEY_SMALL,
            buildPayloadFromData(data, language, getAdaptiveWidgetTaskLimit(IOS_WIDGET_FAMILY_HEIGHTS_DP.small)),
        ],
        [
            IOS_WIDGET_PAYLOAD_KEY_MEDIUM,
            buildPayloadFromData(data, language, getAdaptiveWidgetTaskLimit(IOS_WIDGET_FAMILY_HEIGHTS_DP.medium)),
        ],
        [
            IOS_WIDGET_PAYLOAD_KEY_LARGE,
            buildPayloadFromData(data, language, getAdaptiveWidgetTaskLimit(IOS_WIDGET_FAMILY_HEIGHTS_DP.large)),
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

export async function updateMobileWidgetFromData(data: AppData): Promise<boolean> {
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return false;
    const language = await resolvePayloadLanguage(data);
    if (Platform.OS === 'android') {
        return await updateAndroidWidgetsFromData(data, language);
    }
    return await updateIosWidgetsFromData(data, language);
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
