import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { registerWidgetTaskHandler, type WidgetTaskHandler } from 'react-native-android-widget';
import { type AppData } from '@mindwtr/core';

import { buildTasksWidgetTree } from './components/TasksWidget';
import {
    buildWidgetPayload,
    resolveWidgetLanguage,
    WIDGET_DATA_KEY,
    WIDGET_LANGUAGE_KEY,
} from './lib/widget-data';
import { getAdaptiveAndroidWidgetTaskLimit, getAndroidWidgetLayoutMode } from './lib/widget-layout';
import { logWarn } from './lib/app-log';
import { getSystemColorSchemeForWidget } from './lib/system-color-scheme';

const DEFAULT_DATA: AppData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };
// Task completion via widget taps is disabled. Keep handler to render widget payloads only.

async function loadWidgetContext() {
    try {
        const [rawData, rawLanguage] = await Promise.all([
            AsyncStorage.getItem(WIDGET_DATA_KEY),
            AsyncStorage.getItem(WIDGET_LANGUAGE_KEY),
        ]);

        let data = DEFAULT_DATA;
        if (rawData) {
            try {
                data = JSON.parse(rawData) as AppData;
            } catch {
                data = DEFAULT_DATA;
            }
        }

        const language = resolveWidgetLanguage(rawLanguage, data.settings?.language);
        return { data, language };
    } catch (error) {
        if (__DEV__) {
            void logWarn('[RNWidget] Failed to load widget payload', {
                scope: 'widget',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        }
        return { data: DEFAULT_DATA, language: 'en' as const };
    }
}

const widgetTaskHandler: WidgetTaskHandler = async ({ renderWidget, widgetInfo }) => {
    let { data, language } = await loadWidgetContext();
    const layoutMode = getAndroidWidgetLayoutMode(widgetInfo.width);
    const tasksPayload = buildWidgetPayload(data, language, {
        systemColorScheme: getSystemColorSchemeForWidget(),
        maxItems: getAdaptiveAndroidWidgetTaskLimit(widgetInfo.height, widgetInfo.width),
    });
    try {
        renderWidget(buildTasksWidgetTree(tasksPayload, { layoutMode }));
    } catch (error) {
        if (__DEV__) {
            void logWarn('[RNWidget] Widget render failed', {
                scope: 'widget',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        }
        renderWidget(buildTasksWidgetTree(tasksPayload, { layoutMode }));
    }

    if (widgetInfo.width <= 0 || widgetInfo.height <= 0) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        renderWidget(buildTasksWidgetTree(tasksPayload, { layoutMode }));
    }
};

registerWidgetTaskHandler(widgetTaskHandler);
