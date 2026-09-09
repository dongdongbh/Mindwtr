import React from 'react';
import {
    Switch,
    Text,
    TouchableOpacity,
    View,
    type GestureResponderEvent,
    type StyleProp,
    type TextStyle,
    type ViewStyle,
} from 'react-native';

import { useThemeColors } from '@/hooks/use-theme-colors';

import { styles } from './settings.styles';

// The historical switch rows hardcode this track color pair. It is preserved
// verbatim (rather than swapped for theme tokens) so the shared row stays
// pixel-identical to the inline blocks it replaces; themed callers override it
// via the `trackColor` prop.
const LEGACY_SWITCH_TRACK_COLOR = { false: '#767577', true: '#3B82F6' } as const;

export interface SettingRowProps {
    /** Already-translated label text. */
    label: string;
    /** Already-translated secondary line; omit for a label-only row. */
    description?: string;
    /** Trailing control (switch, chevron, link, input, …). */
    children?: React.ReactNode;
    /** Draw the hairline top divider that separates stacked rows within a card. */
    divider?: boolean;
    /** Dim label + description to signal the row's control is inactive. */
    dimmed?: boolean;
    /** When set, the whole row becomes pressable (picker/navigation rows). */
    onPress?: (event: GestureResponderEvent) => void;
    /** Disables the pressable row (only meaningful alongside `onPress`). */
    disabled?: boolean;
    style?: StyleProp<ViewStyle>;
    labelStyle?: StyleProp<TextStyle>;
    descriptionStyle?: StyleProp<TextStyle>;
    accessibilityLabel?: string;
    testID?: string;
}

/**
 * The standard settings row anatomy shared across the mobile settings screens:
 * a label with an optional description on the left, and a trailing control
 * passed as `children`. Presentational only — callers pass already-translated
 * strings and own the control's behavior.
 */
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
                testID={testID}
            >
                {content}
            </TouchableOpacity>
        );
    }

    return (
        <View style={rowStyle} accessibilityLabel={accessibilityLabel} testID={testID}>
            {content}
        </View>
    );
}

export interface SettingToggleRowProps {
    /** Already-translated label text. */
    label: string;
    /** Already-translated secondary line; omit for a label-only row. */
    description?: string;
    value: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
    divider?: boolean;
    dimmed?: boolean;
    /** Override the track color; defaults to the legacy hardcoded pair. */
    trackColor?: { false: string; true: string };
    style?: StyleProp<ViewStyle>;
    accessibilityLabel?: string;
    testID?: string;
    switchTestID?: string;
}

/**
 * A {@link SettingRow} whose trailing control is a `Switch`. Collapses the
 * label/description/switch block that repeats across the settings screens.
 */
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
