


import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    calendarPushTaskMarkerLine,
    createCalendarPushService,
    notesCarryCalendarPushTaskMarker,
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

type EventPlace = 'gone' | 'elsewhere' | 'unmarked' | 'here';

const eventPlace = (eventId: string, owner?: { taskId: string; calendarId: string }): Promise<EventPlace> => Calendar.getEventAsync(eventId).then(
    (event): EventPlace => {
        if (owner && event?.calendarId != null && String(event.calendarId) !== owner.calendarId) return 'elsewhere';
        const markerLine = owner ? calendarPushTaskMarkerLine(owner.taskId) : null;
        return markerLine && !notesCarryCalendarPushTaskMarker(event?.notes, markerLine) ? 'unmarked' : 'here';
    },
    (error: unknown): EventPlace => {
        if ((error as { code?: unknown } | null)?.code === 'E_EVENT_NOT_FOUND') return 'gone';
        throw error;
    },
);

const unmarkedEvent = (outcome: 'recreated' | 'cleared'): Error => {
    void logWarn('Calendar push left an event it did not make', {
        scope: 'calendar-push',
        force: true,
        extra: { releaseCheck: 'v1.3.8/calendar-push-unmarked-event', outcome },
    });
    return new Error('Calendar event not found');
};

const notOwnEvent = (place: EventPlace, outcome: 'recreated' | 'cleared'): Error => (
    place === 'unmarked' ? unmarkedEvent(outcome) : missingEvent(outcome)
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
                const place = Platform.OS === 'android' ? await eventPlace(eventId, context) : 'here';
                if (place !== 'here') throw notOwnEvent(place, 'recreated');
                return Calendar.updateEventAsync(eventId, details);
            },
            deleteEvent: async (eventId, context) => {
                const place = Platform.OS === 'android' && context ? await eventPlace(eventId, context) : 'here';
                if (place === 'elsewhere' || place === 'unmarked') throw notOwnEvent(place, 'cleared');
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
