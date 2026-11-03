


import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    createCalendarPushService,
    useTaskStore,
    type CalendarPushService,
} from '@mindwtr/core';

import { logInfo, logWarn, logError } from './app-log';
import {
    ensureCalendarSyncStorageReady,
    getCalendarSyncEntry,
    upsertCalendarSyncEntry,
    deleteCalendarSyncEntry,
    getAllCalendarSyncEntries,
} from './storage-adapter';

export { CALENDAR_PUSH_COLOR_OPTIONS, type CalendarPushTargetCalendar } from '@mindwtr/core';

const PLATFORM = Platform.OS;

let service: CalendarPushService | null = null;
const getService = (): CalendarPushService => {
    service ??= createCalendarPushService({
        platform: PLATFORM,
        os: () => Platform.OS,
        storage: {
            getItem: (key) => AsyncStorage.getItem(key),
            setItem: (key, value) => AsyncStorage.setItem(key, value),
            removeItem: (key) => AsyncStorage.removeItem(key),
        },
        calendars: {
            getPermissions: () => Calendar.getCalendarPermissionsAsync(),
            requestPermissions: () => Calendar.requestCalendarPermissionsAsync(),
            getCalendars: () => Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT),
            getEvents: (calendarIds, start, end) => Calendar.getEventsAsync(calendarIds, start, end),
            getSources: () => Calendar.getSourcesAsync(),
            createCalendar: (details) => Calendar.createCalendarAsync(details as Parameters<typeof Calendar.createCalendarAsync>[0]),

            get updateCalendar() {
                return typeof Calendar.updateCalendarAsync === 'function'
                    ? (calendarId: string, details: { color: string; title?: string }) => Calendar.updateCalendarAsync(calendarId, details)
                    : undefined;
            },
            deleteCalendar: (calendarId) => Calendar.deleteCalendarAsync(calendarId),
            createEvent: (calendarId, details) => Calendar.createEventAsync(calendarId, details),
            updateEvent: (eventId, details) => Calendar.updateEventAsync(eventId, details),
            deleteEvent: (eventId) => Calendar.deleteEventAsync(eventId),
        },
        syncEntries: {
            ensureReady: () => ensureCalendarSyncStorageReady(),
            get: (taskId, platform) => getCalendarSyncEntry(taskId, platform),
            upsert: (entry) => upsertCalendarSyncEntry(entry),
            delete: (taskId, platform) => deleteCalendarSyncEntry(taskId, platform),
            getAll: (platform) => getAllCalendarSyncEntries(platform),
        },
        log: {
            info: (message, context) => logInfo(message, context),
            warn: (message, context) => logWarn(message, context),
            error: (error, context) => logError(error, context),
        },
        store: useTaskStore,
    });
    return service;
};


export const getCalendarPushEnabled = (): Promise<boolean> => getService().getCalendarPushEnabled();

export const setCalendarPushEnabled = (enabled: boolean): Promise<void> => getService().setCalendarPushEnabled(enabled);

export const getCalendarPushTargetCalendarId = (): Promise<string | null> => getService().getCalendarPushTargetCalendarId();

export const setCalendarPushTargetCalendarId = (calendarId: string | null): Promise<void> => (
    getService().setCalendarPushTargetCalendarId(calendarId)
);

export const getCalendarPushColor = (): Promise<string> => getService().getCalendarPushColor();

export const setCalendarPushColor = (color: string): Promise<string> => getService().setCalendarPushColor(color);


export const requestCalendarWritePermission = (): Promise<boolean> => getService().requestCalendarWritePermission();

export const getCalendarWritePermissionStatus = (): Promise<'granted' | 'denied' | 'undetermined'> => (
    getService().getCalendarWritePermissionStatus()
);


export const getCalendarPushTargetCalendars = () => getService().getCalendarPushTargetCalendars();


export const ensureMindwtrCalendar = (): Promise<string | null> => getService().ensureMindwtrCalendar();

export const updateMindwtrCalendarColor = (color: string): Promise<boolean> => getService().updateMindwtrCalendarColor(color);


export const deleteMindwtrCalendar = (): Promise<void> => getService().deleteMindwtrCalendar();


export const runFullCalendarSync = (): Promise<void> => getService().runFullCalendarSync();

export const scheduleSyncDebounced = (taskIds: string[]): void => getService().scheduleSyncDebounced(taskIds);


export const startCalendarPushSync = (): (() => void) => getService().startCalendarPushSync();

export const stopCalendarPushSync = (): void => getService().stopCalendarPushSync();
