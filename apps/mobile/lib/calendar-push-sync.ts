


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

/**
 * expo-calendar on Android never reports a missing event (CalendarModule.kt): an update of one writes no row and
 * resolves, and a delete rejects "could not be deleted", as any failed delete does. Its event read rejects
 * E_EVENT_NOT_FOUND for an event that is gone (or marked deleted), so the binding reads the event and answers the
 * text core takes as missing: core then pushes the task again, or forgets the row. The read also answers 'elsewhere' when
 * the ID now names an event in another calendar than the row's: Android's calendar provider hands a deleted event's _id to
 * the next event, which can be the user's own (seen on a Galaxy S23), and that event is never written or deleted. A failed
 * read answers 'here'.
 */
const eventPlace = (eventId: string, calendarId?: string): Promise<'gone' | 'elsewhere' | 'here'> => Calendar.getEventAsync(eventId).then(
    (event) => (calendarId && event?.calendarId != null && String(event.calendarId) !== calendarId ? 'elsewhere' : 'here'),
    (error: unknown) => ((error as { code?: unknown } | null)?.code === 'E_EVENT_NOT_FOUND' ? 'gone' : 'here'),
);

const missingEvent = (outcome: 'recreated' | 'cleared'): Error => {
    void logInfo('Calendar push found a missing event', {
        scope: 'calendar-push',
        force: true,
        extra: { releaseCheck: 'v1.3.8/calendar-push-missing-event', outcome },
    });
    return new Error('Calendar event not found');
};

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
            updateEvent: async (eventId, details, context) => {
                if (Platform.OS === 'android' && await eventPlace(eventId, context?.calendarId) !== 'here') throw missingEvent('recreated');
                return Calendar.updateEventAsync(eventId, details);
            },
            deleteEvent: async (eventId, context) => {
                if (Platform.OS === 'android' && context && await eventPlace(eventId, context.calendarId) === 'elsewhere') throw missingEvent('cleared');
                try {
                    return await Calendar.deleteEventAsync(eventId);
                } catch (error) {
                    if (Platform.OS === 'android' && await eventPlace(eventId) === 'gone') throw missingEvent('cleared');
                    throw error;
                }
            },
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
