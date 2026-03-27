import React from 'react';
import { Pressable, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '@/contexts/language-context';

import { styles } from './settings.styles';

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
    onPress,
    showIndicator,
    indicatorColor,
    indicatorAccessibilityLabel,
}: {
    title: string;
    onPress: () => void;
    showIndicator?: boolean;
    indicatorColor?: string;
    indicatorAccessibilityLabel?: string;
}) {
    const tc = useThemeColors();

    return (
        <TouchableOpacity style={[styles.menuItem, { borderBottomColor: tc.border }]} onPress={onPress}>
            <Text style={[styles.menuLabel, { color: tc.text }]}>{title}</Text>
            <View style={styles.menuRight}>
                {showIndicator && (
                    <View
                        accessibilityLabel={indicatorAccessibilityLabel}
                        accessibilityRole="text"
                        style={[styles.updateDot, indicatorColor ? { backgroundColor: indicatorColor } : null]}
                    />
                )}
                <Text style={[styles.chevron, { color: tc.secondaryText }]}>›</Text>
            </View>
        </TouchableOpacity>
    );
}

export function SettingsTopBar() {
    const router = useRouter();
    const { t } = useLanguage();
    const tc = useThemeColors();
    const insets = useSafeAreaInsets();
    const canGoBack = router.canGoBack();

    return (
        <View
            style={[
                styles.topBar,
                {
                    backgroundColor: tc.cardBg,
                    borderBottomColor: tc.border,
                    height: 52 + insets.top,
                    paddingTop: insets.top,
                },
            ]}
        >
            <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back"
                disabled={!canGoBack}
                hitSlop={8}
                onPress={() => {
                    if (canGoBack) router.back();
                }}
                style={[styles.topBarBackButton, !canGoBack && styles.topBarBackButtonHidden]}
            >
                <Ionicons color={tc.text} name="chevron-back" size={24} />
            </Pressable>
            <Text style={[styles.topBarTitle, { color: tc.text }]} numberOfLines={1}>
                {t('settings.title')}
            </Text>
            <View style={styles.topBarBackButton} />
        </View>
    );
}
