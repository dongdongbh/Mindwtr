import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { registerWidgetTaskHandler, type WidgetTaskHandler } from 'react-native-android-widget';
import type { AppData } from '@mindwtr/core';

import { buildTasksWidgetTree } from './components/TasksWidget';
import {
    buildWidgetPayload,
    resolveWidgetLanguage,
    WIDGET_DATA_KEY,
    WIDGET_LANGUAGE_KEY,
} from './lib/widget-data';

const DEFAULT_DATA: AppData = { tasks: [], projects: [], areas: [], settings: {} };

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
            console.warn('[RNWidget] Failed to load widget payload', error);
        }
        return { data: DEFAULT_DATA, language: 'en' as const };
    }
}

const widgetTaskHandler: WidgetTaskHandler = async ({ renderWidget, widgetInfo }) => {
    const { data, language } = await loadWidgetContext();
    const tasksPayload = buildWidgetPayload(data, language);
    try {
        renderWidget(buildTasksWidgetTree(tasksPayload));
    } catch (error) {
        if (__DEV__) {
            console.warn('[RNWidget] Widget render failed', error);
        }
        renderWidget(buildTasksWidgetTree(tasksPayload));
    }

    if (widgetInfo.width <= 0 || widgetInfo.height <= 0) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        renderWidget(buildTasksWidgetTree(tasksPayload));
    }
};

registerWidgetTaskHandler(widgetTaskHandler);
