import React from 'react';
import { Linking, Pressable, Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AlertTriangle, Check, RefreshCw, ChevronRight, ExternalLink as ExternalLinkIcon, type LucideIcon } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getSettingsMenuItemAccessibilityLabel, type SettingsSyncBadgeIcon } from '@mindwtr/core';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '@/contexts/language-context';

import { styles } from './settings.styles';

type MenuItemIcon = LucideIcon;
const SYNC_INDICATOR_ICONS = { refresh: RefreshCw, check: Check, warning: AlertTriangle };

export function SubHeader({ title }: { title: string }) {
    const tc = useThemeColors();

    return (
        <View style={styles.subHeader}>
            <Text style={[styles.subHeaderTitle, { color: tc.text }]}>{title}</Text>
        </View>
    );
}

export function MenuItem({
    title,
    description,
    icon: Icon,
    onPress,
    isLast,
    showIndicator,
    indicatorColor,
    indicatorIcon,
    indicatorAccessibilityLabel,
    disabled = false,
}: {
    title: string;
    description?: string;
    icon?: MenuItemIcon;
    onPress: () => void;
    isLast?: boolean;
    showIndicator?: boolean;
    indicatorColor?: string;
    indicatorIcon?: SettingsSyncBadgeIcon;
    indicatorAccessibilityLabel?: string;
    disabled?: boolean;
}) {
    const tc = useThemeColors();
    const accessibilityLabel = getSettingsMenuItemAccessibilityLabel(title, description, indicatorAccessibilityLabel);
    const IndicatorIcon = indicatorIcon ? SYNC_INDICATOR_ICONS[indicatorIcon] : undefined;

    return (
        <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ disabled }}
            activeOpacity={0.72}
            disabled={disabled}
            style={[
                styles.menuItem,
                Icon || description ? styles.menuItemDetailed : null,
                {
                    borderBottomColor: tc.border,
                    borderBottomWidth: isLast ? 0 : 1,
                    opacity: disabled ? 0.5 : 1,
                },
            ]}
            onPress={onPress}
        >
            <View style={styles.menuLeft}>
                {Icon && (
                    <View style={styles.menuIconSlot} pointerEvents="none">
                        <Icon color={tc.secondaryText} size={20} strokeWidth={2} />
                    </View>
                )}
                <View style={styles.menuTextBlock}>
                    <Text style={[styles.menuLabel, { color: tc.text }]} numberOfLines={2}>
                        {title}
                    </Text>
                    {description && (
                        <Text style={[styles.menuDescription, { color: tc.secondaryText }]} numberOfLines={2}>
                            {description}
                        </Text>
                    )}
                </View>
            </View>
            <View style={styles.menuRight}>
                {showIndicator && (IndicatorIcon ? (
                    <IndicatorIcon color={indicatorColor ?? tc.text} size={16} accessibilityLabel={indicatorAccessibilityLabel} />
                ) : (
                    <View
                        accessibilityLabel={indicatorAccessibilityLabel}
                        accessibilityRole="text"
                        style={[styles.updateDot, indicatorColor ? { backgroundColor: indicatorColor } : null]}
                    />
                ))}
                <ChevronRight color={tc.secondaryText} size={20} strokeWidth={2.2} />
            </View>
        </TouchableOpacity>
    );
}

export function SettingsGuideLink({
    description = 'Opens the guide in your browser.',
    style,
    testID,
    title,
    url,
}: {
    description?: string;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    title: string;
    url: string;
}) {
    const tc = useThemeColors();

    return (
        <TouchableOpacity
            accessibilityHint="Opens an external guide in your browser."
            accessibilityLabel={`${title}. ${description}`}
            accessibilityRole="link"
            activeOpacity={0.72}
            onPress={() => {
                void Linking.openURL(url);
            }}
            style={[
                styles.guideLinkInline,
                style,
            ]}
            testID={testID}
        >
            <Text style={[styles.guideLinkLabel, { color: tc.tint }]}>{title}</Text>
            <ExternalLinkIcon color={tc.tint} size={15} strokeWidth={2.2} />
        </TouchableOpacity>
    );
}

export function SettingsTopBar({ title }: { title?: string } = {}) {
    const router = useRouter();
    const { t } = useLanguage();
    const tc = useThemeColors();
    const insets = useSafeAreaInsets();
    const canGoBack = router.canGoBack();
    const backText = t('common.back');

    return (
        <View
            style={[
                styles.topBar,
                {
                    backgroundColor: tc.cardBg,
                    borderBottomColor: tc.border,
                    minHeight: 52 + insets.top,
                    paddingTop: insets.top,
                },
            ]}
        >
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={backText}
                disabled={!canGoBack}
                hitSlop={8}
                onPress={() => {
                    if (canGoBack) router.back();
                }}
                style={[styles.topBarBackButton, !canGoBack && styles.topBarBackButtonHidden]}
            >
                <Ionicons color={tc.text} name="chevron-back" size={24} />
            </Pressable>
            <Text style={[styles.topBarTitle, { color: tc.text }]} numberOfLines={2}>
                {title ?? t('settings.title')}
            </Text>
            <View style={styles.topBarBackButton} />
        </View>
    );
}
