

import {
    buildAndroidQuickCaptureLabels,
    buildAndroidTaskPeekLabels,
    buildShortcutsSnapshot,
    buildWidgetPayload,
    createWidgetPayloadProjection,
    resolveWidgetDayFirst,
    resolveWidgetLanguage,
    SHORTCUTS_SNAPSHOT_ITEM_CAP,
    SHORTCUTS_SNAPSHOT_PROJECT_CAP,
    SHORTCUTS_SNAPSHOT_VERSION,
    WIDGET_FOCUS_URI,
    WIDGET_PEEK_DESCRIPTION_MAX,
    WIDGET_PEEK_TOKEN_MAX,
    WIDGET_QUICK_CAPTURE_URI,
} from '@mindwtr/core/widget-payload';

export type {
    AndroidQuickCaptureLabels,
    AndroidTaskPeekLabels,
    AndroidTasksWidgetPayload,
    ShortcutsSnapshot,
    ShortcutsSnapshotListKey,
    ShortcutsSnapshotProjectGroup,
    ShortcutsSnapshotTaskItem,
    TasksWidgetPayload,
    WidgetColor,
    WidgetDueTone,
    WidgetListPayload,
    WidgetPalette,
    WidgetPayloadBuildOptions,
    WidgetPayloadProjection,
    WidgetSavedFilterOption,
    WidgetSystemColorScheme,
    WidgetTaskItem,
    WidgetTaskSection,
} from '@mindwtr/core/widget-payload';
export type { WidgetTaskList } from '@mindwtr/core/widget-lists';
export {
    buildAndroidQuickCaptureLabels,
    buildAndroidTaskPeekLabels,
    buildShortcutsSnapshot,
    buildWidgetPayload,
    createWidgetPayloadProjection,
    resolveWidgetDayFirst,
    resolveWidgetLanguage,
    SHORTCUTS_SNAPSHOT_ITEM_CAP,
    SHORTCUTS_SNAPSHOT_PROJECT_CAP,
    SHORTCUTS_SNAPSHOT_VERSION,
    WIDGET_FOCUS_URI,
    WIDGET_PEEK_DESCRIPTION_MAX,
    WIDGET_PEEK_TOKEN_MAX,
    WIDGET_QUICK_CAPTURE_URI,
};

export const WIDGET_DATA_KEY = 'mindwtr-data';
export const WIDGET_LANGUAGE_KEY = 'mindwtr-language';
export const IOS_WIDGET_APP_GROUP = 'group.tech.dongdongbh.mindwtr';
export const IOS_WIDGET_PAYLOAD_KEY = 'mindwtr-ios-widget-payload';
export const IOS_WIDGET_PAYLOAD_KEY_SMALL = 'mindwtr-ios-widget-payload-small';
export const IOS_WIDGET_PAYLOAD_KEY_MEDIUM = 'mindwtr-ios-widget-payload-medium';
export const IOS_WIDGET_PAYLOAD_KEY_LARGE = 'mindwtr-ios-widget-payload-large';
export const IOS_WIDGET_PAYLOAD_KEY_EXTRA_LARGE = 'mindwtr-ios-widget-payload-extra-large';


export const IOS_SHORTCUTS_SNAPSHOT_KEY = 'mindwtr-ios-shortcuts-snapshot';
export const IOS_WIDGET_KIND = 'MindwtrTasksWidget';
export const IOS_WIDGET_COMPACT_KIND = 'MindwtrCompactWidget';
export const IOS_WIDGET_LOCK_KIND = 'MindwtrFocusLockWidget';
