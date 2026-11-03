import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Calendar from 'expo-calendar';
import {
    createExternalCalendarFeeds,
    isSandboxMode,
    type ExternalCalendarEvent,
    type ExternalCalendarFeeds,
    type ExternalCalendarFetchOptions,
    type ExternalCalendarSubscription,
    type SystemCalendarInfo,
    type SystemCalendarSettings,
    useTaskStore,
} from '@mindwtr/core';
import * as FileSystem from './file-system';
import { logInfo } from './app-log';
import { getAllCalendarSyncEntries } from './storage-adapter';


export {
    EXTERNAL_CALENDARS_KEY,
    SYSTEM_CALENDAR_SETTINGS_KEY,
    type SystemCalendarInfo,
    type SystemCalendarPermissionStatus,
    type SystemCalendarSettings,
} from '@mindwtr/core';

let feeds: ExternalCalendarFeeds | null = null;
const getFeeds = (): ExternalCalendarFeeds => {
    feeds ??= createExternalCalendarFeeds({
        platform: () => Platform.OS,
        storage: {
            getItem: (key) => AsyncStorage.getItem(key),
            setItem: (key, value) => AsyncStorage.setItem(key, value),
        },
        fetch: (input, init) => fetch(input, init),
        readLocalFile: (url) => (url.trim().toLowerCase().startsWith('content://')
            ? FileSystem.StorageAccessFramework.readAsStringAsync(url)
            : FileSystem.readAsStringAsync(url)),
        calendars: {
            getPermissions: () => Calendar.getCalendarPermissionsAsync(),
            requestPermissions: () => Calendar.requestCalendarPermissionsAsync(),
            getCalendars: () => Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT),
            getEvents: (calendarIds, start, end) => Calendar.getEventsAsync(calendarIds, start, end),
        },
        getAllCalendarSyncEntries: (platform) => getAllCalendarSyncEntries(platform),
        logInfo: (message, context) => logInfo(message, context),
        syncedSubscriptions: () => useTaskStore.getState().settings.externalCalendars,
    });
    return feeds;
};

export function canOpenExternalCalendarEvent(event: ExternalCalendarEvent): boolean {
    return getFeeds().canOpenExternalCalendarEvent(event);
}

export async function openExternalCalendarEvent(event: ExternalCalendarEvent): Promise<boolean> {
    if (isSandboxMode()) return false;
    if (!canOpenExternalCalendarEvent(event)) return false;

    const params = {
        id: event.nativeEventId as string,
        instanceStartDate: event.start,
    };

    if (typeof Calendar.editEventInCalendarAsync === 'function') {
        await Calendar.editEventInCalendarAsync(params, { startNewActivityTask: Platform.OS === 'android' });
        return true;
    }

    if (typeof Calendar.openEventInCalendarAsync === 'function') {
        await Calendar.openEventInCalendarAsync(params, {
            allowsEditing: true,
            startNewActivityTask: Platform.OS === 'android',
        });
        return true;
    }

    return false;
}

export const getExternalCalendars = (): Promise<ExternalCalendarSubscription[]> => getFeeds().getExternalCalendars();

export const saveExternalCalendars = (calendars: ExternalCalendarSubscription[]): Promise<void> => getFeeds().saveExternalCalendars(calendars);

export const getSystemCalendarSettings = (): Promise<SystemCalendarSettings> => getFeeds().getSystemCalendarSettings();

export const saveSystemCalendarSettings = (settings: SystemCalendarSettings): Promise<void> => getFeeds().saveSystemCalendarSettings(settings);

export const getSystemCalendarPermissionStatus = () => getFeeds().getSystemCalendarPermissionStatus();

export const requestSystemCalendarPermission = () => getFeeds().requestSystemCalendarPermission();

export const getSystemCalendars = (): Promise<SystemCalendarInfo[]> => getFeeds().getSystemCalendars();

export const fetchExternalCalendarEvents = (
    rangeStart: Date,
    rangeEnd: Date,
    options: ExternalCalendarFetchOptions = {},
): Promise<{
    calendars: ExternalCalendarSubscription[];
    events: ExternalCalendarEvent[];
}> => getFeeds().fetchExternalCalendarEvents(rangeStart, rangeEnd, options);
