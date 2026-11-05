import React, { useCallback, useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '@/hooks/use-theme-colors';

import {
    isExactAlarmPermissionRelevant,
    openExactAlarmSettings,
    refreshExactAlarmPermission,
} from '@/lib/exact-alarm-permission';

import { SettingRow } from './setting-row';
import { styles } from './settings.styles';


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

    label: string;
    description: string;
    actionLabel: string;
    divider?: boolean;

    inline?: boolean;
}


export function ExactAlarmNoticeRow({ label, description, actionLabel, divider, inline = false }: ExactAlarmNoticeRowProps) {
    const tc = useThemeColors();
    const onPress = useCallback(() => {
        openExactAlarmSettings().catch(console.error);
    }, []);

    if (inline) {
        return (
            <View style={noticeStyles.container} testID="exact-alarm-notice">
                <Text style={[noticeStyles.label, { color: tc.text }]}>{label}</Text>
                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{description}</Text>
                <TouchableOpacity
                    style={noticeStyles.action}
                    onPress={onPress}
                    accessibilityRole="button"
                    accessibilityLabel={actionLabel}
                    testID="exact-alarm-allow"
                >
                    <Text style={[noticeStyles.actionText, { color: tc.tint }]}>{actionLabel}</Text>
                </TouchableOpacity>
            </View>
        );
    }

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

const noticeStyles = StyleSheet.create({
    container: { paddingHorizontal: 16, paddingBottom: 12, gap: 4 },
    label: { fontSize: 13, fontWeight: '600' },
    action: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingVertical: 10 },
    actionText: { fontSize: 14, fontWeight: '600' },
});
