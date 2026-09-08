import { useCallback, useEffect, useState } from 'react';
import {
    generateUUID,
    normalizeExternalCalendarColor,
    type AppData,
    type ExternalCalendarSubscription,
} from '@mindwtr/core';
import { ExternalCalendarService } from '../../../lib/external-calendar-service';
import {
    getCalendarSourceFileName,
    isSupportedCalendarSourceUrl,
    localPathToCalendarFileUrl,
} from '../../../lib/external-calendar-source';
import { isTauriRuntime } from '../../../lib/runtime';
import { useLanguage } from '../../../contexts/language-context';
import { reportSettingsFailure, resolveSettingsFeedback } from './settings-feedback';
import {
    enableDesktopCalendarPush,
    getDesktopCalendarPushEnabled,
    getDesktopCalendarPushTargetCalendarId,
    getDesktopCalendarPushTargetCalendars,
    runFullDesktopCalendarPushSync,
    setDesktopCalendarPushEnabled,
    setDesktopCalendarPushTargetCalendarId,
    startDesktopCalendarPushSync,
    stopDesktopCalendarPushSync,
} from '../../../lib/desktop-calendar-push-sync';
import {
    getSystemCalendarPermissionStatus,
    requestSystemCalendarPermission,
    type SystemCalendarPushTarget,
    type SystemCalendarPermissionStatus,
} from '../../../lib/system-calendar';

type UseCalendarSettingsOptions = {
    loadEnabled?: boolean;
    showSaved: () => void;
    settings: AppData['settings'] | undefined;
    updateSettings: (updates: Partial<AppData['settings']>) => Promise<void>;
    supportsSystemCalendar: boolean;
};

export function useCalendarSettings({ loadEnabled = true, showSaved, settings, updateSettings, supportsSystemCalendar }: UseCalendarSettingsOptions) {
    const { t } = useLanguage();
    const resolveFeedback = useCallback((key: string, fallback: string) => (
        resolveSettingsFeedback(t, key, fallback)
    ), [t]);
    const loadFailedMessage = resolveFeedback(
        'settings.feedback.loadFailed',
        "Couldn't load this setting. Try again.",
    );
    const saveFailedMessage = resolveFeedback(
        'settings.feedback.saveFailed',
        "Couldn't save this setting. Try again.",
    );
    const [externalCalendars, setExternalCalendars] = useState<ExternalCalendarSubscription[]>([]);
    const [newCalendarName, setNewCalendarName] = useState('');
    const [newCalendarUrl, setNewCalendarUrl] = useState('');
    const [calendarError, setCalendarError] = useState<string | null>(null);
    const [systemCalendarPermission, setSystemCalendarPermission] = useState<SystemCalendarPermissionStatus>('unsupported');
    const [calendarPushEnabled, setCalendarPushEnabledState] = useState(false);
    const [calendarPushTargetCalendarId, setCalendarPushTargetCalendarIdState] = useState<string | null>(null);
    const [calendarPushTargets, setCalendarPushTargets] = useState<SystemCalendarPushTarget[]>([]);
    const [calendarPushLoading, setCalendarPushLoading] = useState(false);

    useEffect(() => {
        if (!loadEnabled) return;
        let cancelled = false;
        ExternalCalendarService.getCalendars()
            .then(async (stored) => {
                if (cancelled) return;
                if (Array.isArray(settings?.externalCalendars)) {
                    setExternalCalendars(settings.externalCalendars);
                    if (settings.externalCalendars.length || stored.length) {
                        await ExternalCalendarService.setCalendars(settings.externalCalendars);
                    }
                    return;
                }
                setExternalCalendars(stored);
            })
            .catch((error) => reportSettingsFailure('Failed to load calendars', error, loadFailedMessage));
        return () => {
            cancelled = true;
        };
    }, [loadEnabled, loadFailedMessage, settings?.externalCalendars]);

    const refreshSystemCalendarPermission = useCallback(async () => {
        if (!supportsSystemCalendar) {
            setSystemCalendarPermission('unsupported');
            return;
        }
        const status = await getSystemCalendarPermissionStatus();
        setSystemCalendarPermission(status);
    }, [supportsSystemCalendar]);

    useEffect(() => {
        if (!loadEnabled) return;
        void refreshSystemCalendarPermission();
        const onFocus = () => {
            void refreshSystemCalendarPermission();
        };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onFocus);
        return () => {
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onFocus);
        };
    }, [loadEnabled, refreshSystemCalendarPermission]);

    const refreshCalendarPushTargets = useCallback(async () => {
        if (!supportsSystemCalendar) {
            setCalendarPushTargets([]);
            return;
        }
        try {
            setCalendarPushTargets(await getDesktopCalendarPushTargetCalendars());
        } catch (error) {
            reportSettingsFailure('Failed to load system calendar push targets', error, loadFailedMessage);
            setCalendarError(loadFailedMessage);
        }
    }, [loadFailedMessage, supportsSystemCalendar]);

    useEffect(() => {
        if (!loadEnabled) return;
        if (!supportsSystemCalendar) {
            setCalendarPushEnabledState(false);
            setCalendarPushTargetCalendarIdState(null);
            setCalendarPushTargets([]);
            return;
        }
        let cancelled = false;
        Promise.all([
            getDesktopCalendarPushEnabled(),
            getDesktopCalendarPushTargetCalendarId(),
        ])
            .then(([enabled, targetCalendarId]) => {
                if (cancelled) return;
                setCalendarPushEnabledState(enabled);
                setCalendarPushTargetCalendarIdState(targetCalendarId);
            })
            .catch((error) => {
                if (!cancelled) {
                    reportSettingsFailure('Failed to load system calendar push settings', error, loadFailedMessage);
                    setCalendarError(loadFailedMessage);
                }
            });
        void refreshCalendarPushTargets();
        return () => {
            cancelled = true;
        };
    }, [loadEnabled, loadFailedMessage, supportsSystemCalendar, refreshCalendarPushTargets]);

    const persistCalendars = useCallback(async (next: ExternalCalendarSubscription[]) => {
        setCalendarError(null);
        setExternalCalendars(next);
        try {
            await ExternalCalendarService.setCalendars(next);
            await updateSettings({ externalCalendars: next });
            showSaved();
        } catch (error) {
            reportSettingsFailure('Failed to save calendars', error, saveFailedMessage);
            setCalendarError(saveFailedMessage);
        }
    }, [saveFailedMessage, showSaved, updateSettings]);

    const handleAddCalendar = useCallback(() => {
        const url = newCalendarUrl.trim();
        if (!url) return;
        if (!isSupportedCalendarSourceUrl(url)) {
            setCalendarError(resolveFeedback(
                'settings.calendar.invalidSource',
                'Use an http(s), webcal, or absolute file:///path.ics source.',
            ));
            return;
        }
        const name = (newCalendarName.trim() || resolveFeedback('calendar.title', 'Calendar')).trim();
        const id = generateUUID();
        // No color yet: an unset color means "no explicit pick", so a feed
        // hint or the deterministic hash fallback can still apply (#974).
        const next = [
            ...externalCalendars,
            { id, name, url, enabled: true },
        ];
        setNewCalendarName('');
        setNewCalendarUrl('');
        persistCalendars(next);
    }, [externalCalendars, newCalendarName, newCalendarUrl, persistCalendars, resolveFeedback]);

    const handleChooseLocalCalendarFile = useCallback(async () => {
        if (!isTauriRuntime()) {
            setCalendarError(resolveFeedback(
                'settings.calendar.localIcsDesktopRequired',
                'Local ICS files require the desktop app.',
            ));
            return;
        }
        setCalendarError(null);
        try {
            const { open } = await import('@tauri-apps/plugin-dialog');
            const selected = await open({
                multiple: false,
                directory: false,
                filters: [{ name: 'ICS calendar', extensions: ['ics'] }],
            });
            if (!selected || Array.isArray(selected)) return;
            const url = localPathToCalendarFileUrl(String(selected));
            setNewCalendarUrl(url);
            if (!newCalendarName.trim()) {
                setNewCalendarName(
                    getCalendarSourceFileName(url).replace(/\.ics$/i, '')
                    || resolveFeedback('calendar.title', 'Calendar'),
                );
            }
        } catch (error) {
            reportSettingsFailure('Failed to choose local ICS calendar', error, loadFailedMessage);
            setCalendarError(loadFailedMessage);
        }
    }, [loadFailedMessage, newCalendarName, resolveFeedback]);

    const handleToggleCalendar = useCallback((id: string, enabled: boolean) => {
        const next = externalCalendars.map((calendar) => (calendar.id === id ? { ...calendar, enabled } : calendar));
        persistCalendars(next);
    }, [externalCalendars, persistCalendars]);

    const handleCalendarColorChange = useCallback((id: string, color: string | undefined) => {
        // `undefined` is the Auto swatch: drop the pick so the feed hint or
        // the assigned default applies again (#974).
        const normalized = color === undefined ? undefined : normalizeExternalCalendarColor(color);
        if (color !== undefined && !normalized) return;
        const next = externalCalendars.map((calendar) => {
            if (calendar.id !== id) return calendar;
            if (normalized) return { ...calendar, color: normalized };
            const { color: _cleared, ...rest } = calendar;
            return rest;
        });
        persistCalendars(next);
    }, [externalCalendars, persistCalendars]);

    const handleRemoveCalendar = useCallback((id: string) => {
        const next = externalCalendars.filter((calendar) => calendar.id !== id);
        persistCalendars(next);
    }, [externalCalendars, persistCalendars]);

    const handleRequestSystemCalendarPermission = useCallback(async () => {
        if (!supportsSystemCalendar) return;
        const status = await requestSystemCalendarPermission();
        setSystemCalendarPermission(status);
        if (status === 'granted') {
            await refreshCalendarPushTargets();
            showSaved();
        }
    }, [refreshCalendarPushTargets, showSaved, supportsSystemCalendar]);

    const handleToggleCalendarPush = useCallback(async (enabled: boolean) => {
        if (!supportsSystemCalendar) return;
        setCalendarError(null);

        if (!enabled) {
            await setDesktopCalendarPushEnabled(false);
            setCalendarPushEnabledState(false);
            stopDesktopCalendarPushSync();
            showSaved();
            return;
        }

        setCalendarPushLoading(true);
        try {
            let status = systemCalendarPermission;
            if (status !== 'granted') {
                status = await requestSystemCalendarPermission();
                setSystemCalendarPermission(status);
            }
            if (status !== 'granted') {
                setCalendarError(resolveFeedback(
                    'settings.calendarMobile.calendarAccessIsRequiredToPushTasksToYourCalendar',
                    'Calendar access is required to push tasks to your calendar.',
                ));
                return;
            }

            const ok = await enableDesktopCalendarPush();
            setCalendarPushEnabledState(ok);
            await refreshCalendarPushTargets();
            if (!ok) {
                setCalendarError(resolveFeedback(
                    'settings.calendar.writableTargetUnavailable',
                    'Could not create or find a writable system calendar target.',
                ));
                return;
            }
            showSaved();
        } catch (error) {
            reportSettingsFailure('Failed to update system calendar push setting', error, saveFailedMessage);
            setCalendarError(saveFailedMessage);
        } finally {
            setCalendarPushLoading(false);
        }
    }, [refreshCalendarPushTargets, resolveFeedback, saveFailedMessage, showSaved, supportsSystemCalendar, systemCalendarPermission]);

    const handleCalendarPushTargetChange = useCallback(async (calendarId: string | null) => {
        if (!supportsSystemCalendar) return;
        const nextId = calendarId?.trim() || null;
        setCalendarError(null);
        setCalendarPushTargetCalendarIdState(nextId);
        try {
            await setDesktopCalendarPushTargetCalendarId(nextId);
            if (calendarPushEnabled) {
                startDesktopCalendarPushSync();
                await runFullDesktopCalendarPushSync();
            }
            showSaved();
        } catch (error) {
            reportSettingsFailure('Failed to update system calendar push target', error, saveFailedMessage);
            setCalendarError(saveFailedMessage);
        }
    }, [calendarPushEnabled, saveFailedMessage, showSaved, supportsSystemCalendar]);

    // Only user-initiated work blocks the controls; loading the target list in
    // the background must never leave the push toggle stuck greyed out (#575).
    const handleRefreshCalendarPushTargets = useCallback(async () => {
        setCalendarPushLoading(true);
        try {
            await refreshCalendarPushTargets();
        } finally {
            setCalendarPushLoading(false);
        }
    }, [refreshCalendarPushTargets]);

    return {
        externalCalendars,
        // Swatch fills only — a pick is still stored as the canonical hex (#974).
        theme: settings?.theme,
        newCalendarName,
        newCalendarUrl,
        calendarError,
        showSystemCalendarSection: supportsSystemCalendar,
        systemCalendarPermission,
        calendarPushEnabled,
        calendarPushTargetCalendarId,
        calendarPushTargets,
        calendarPushLoading,
        onCalendarNameChange: setNewCalendarName,
        onCalendarUrlChange: setNewCalendarUrl,
        onAddCalendar: handleAddCalendar,
        onChooseLocalCalendarFile: handleChooseLocalCalendarFile,
        onToggleCalendar: handleToggleCalendar,
        onCalendarColorChange: handleCalendarColorChange,
        onRemoveCalendar: handleRemoveCalendar,
        onRequestSystemCalendarPermission: handleRequestSystemCalendarPermission,
        onToggleCalendarPush: handleToggleCalendarPush,
        onCalendarPushTargetChange: handleCalendarPushTargetChange,
        onRefreshCalendarPushTargets: handleRefreshCalendarPushTargets,
    };
}
