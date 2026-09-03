import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Text, TouchableOpacity } from 'react-native';

import {
    isExactAlarmPermissionRelevant,
    openExactAlarmSettings,
    refreshExactAlarmPermission,
} from '@/lib/exact-alarm-permission';

import { SettingRow } from './setting-row';
import { styles } from './settings.styles';

/**
 * Tracks whether the OS will let this app set exact alarms, for the settings
 * screens that own a feature which depends on them.
 *
 * Only runs while `enabled` is true — the user has the reminder or pomodoro
 * alert switched on and is looking at the screen that offers the fix. No
 * polling and no background work: the state can only change on the system
 * screen we send them to, so re-reading it when the app comes back to the
 * foreground is enough.
 */
export function useExactAlarmPermission(enabled: boolean): { showNotice: boolean } {
    const [allowed, setAllowed] = useState(true);

    useEffect(() => {
        if (!enabled || !isExactAlarmPermissionRelevant()) return;
        let cancelled = false;
        const check = () => {
            refreshExactAlarmPermission()
                .then((next) => {
                    if (!cancelled) setAllowed(next);
                })
                .catch(() => undefined);
        };
        check();
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') check();
        });
        return () => {
            cancelled = true;
            subscription.remove();
        };
    }, [enabled]);

    return { showNotice: enabled && isExactAlarmPermissionRelevant() && !allowed };
}

export interface ExactAlarmNoticeRowProps {
    /** Already-translated title, description and button label. */
    label: string;
    description: string;
    actionLabel: string;
    divider?: boolean;
}

/** The one row both reminder and pomodoro settings show while exact alarms are denied. */
export function ExactAlarmNoticeRow({ label, description, actionLabel, divider }: ExactAlarmNoticeRowProps) {
    const onPress = useCallback(() => {
        openExactAlarmSettings().catch(console.error);
    }, []);

    return (
        <SettingRow
            divider={divider}
            label={label}
            description={description}
            testID="exact-alarm-notice"
        >
            <TouchableOpacity
                style={[styles.manageEditorButton, styles.manageEditorButtonPrimary]}
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={actionLabel}
                testID="exact-alarm-allow"
            >
                <Text style={[styles.manageEditorButtonText, styles.manageEditorButtonPrimaryText]}>
                    {actionLabel}
                </Text>
            </TouchableOpacity>
        </SettingRow>
    );
}
