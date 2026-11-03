import React from 'react';
import {
    Switch,
    Text,
    TouchableOpacity,
    View,
    type AccessibilityRole,
    type AccessibilityState,
    type GestureResponderEvent,
    type StyleProp,
    type TextStyle,
    type ViewStyle,
} from 'react-native';

import { useThemeColors } from '@/hooks/use-theme-colors';

import { styles } from './settings.styles';


const LEGACY_SWITCH_TRACK_COLOR = { false: '#767577', true: '#3B82F6' } as const;

export interface SettingRowProps {

    label: string;

    description?: string;

    children?: React.ReactNode;

    divider?: boolean;

    dimmed?: boolean;

    onPress?: (event: GestureResponderEvent) => void;

    disabled?: boolean;
    style?: StyleProp<ViewStyle>;
    labelStyle?: StyleProp<TextStyle>;
    descriptionStyle?: StyleProp<TextStyle>;
    accessibilityLabel?: string;
    accessibilityRole?: AccessibilityRole;
    accessibilityState?: AccessibilityState;
    testID?: string;
}


export function SettingRow({
    label,
    description,
    children,
    divider,
    dimmed,
    onPress,
    disabled,
    style,
    labelStyle,
    descriptionStyle,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    testID,
}: SettingRowProps) {
    const tc = useThemeColors();
    const dim = dimmed ? { opacity: 0.5 } : null;
    const rowStyle: StyleProp<ViewStyle> = [
        styles.settingRow,
        divider ? { borderTopWidth: 1, borderTopColor: tc.border } : null,
        style,
    ];

    const content = (
        <>
            <View style={styles.settingInfo}>
                <Text style={[styles.settingLabel, { color: tc.text }, dim, labelStyle]}>{label}</Text>
                {description != null ? (
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }, dim, descriptionStyle]}>
                        {description}
                    </Text>
                ) : null}
            </View>
            {children}
        </>
    );

    if (onPress) {
        return (
            <TouchableOpacity
                style={rowStyle}
                onPress={onPress}
                disabled={disabled}
                accessibilityLabel={accessibilityLabel}
                accessibilityRole={accessibilityRole}
                accessibilityState={accessibilityState}
                testID={testID}
            >
                {content}
            </TouchableOpacity>
        );
    }

    return (
        <View
            style={rowStyle}
            accessibilityLabel={accessibilityLabel}
            accessibilityRole={accessibilityRole}
            accessibilityState={accessibilityState}
            testID={testID}
        >
            {content}
        </View>
    );
}

export interface SettingToggleRowProps {

    label: string;

    description?: string;
    value: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
    divider?: boolean;
    dimmed?: boolean;

    trackColor?: { false: string; true: string };
    style?: StyleProp<ViewStyle>;
    accessibilityLabel?: string;
    testID?: string;
    switchTestID?: string;
}


export function SettingToggleRow({
    label,
    description,
    value,
    onChange,
    disabled,
    divider,
    dimmed,
    trackColor,
    style,
    accessibilityLabel,
    testID,
    switchTestID,
}: SettingToggleRowProps) {
    return (
        <SettingRow
            label={label}
            description={description}
            divider={divider}
            dimmed={dimmed}
            style={style}
            accessibilityLabel={accessibilityLabel}
            testID={testID}
        >
            <Switch
                accessibilityLabel={accessibilityLabel ?? label}
                value={value}
                onValueChange={onChange}
                disabled={disabled}
                trackColor={trackColor ?? LEGACY_SWITCH_TRACK_COLOR}
                testID={switchTestID}
            />
        </SettingRow>
    );
}
